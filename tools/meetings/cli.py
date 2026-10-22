"""CLI for the meeting (calendar) -> customer intelligence datastore.

Run from the repo root:  python -m tools.meetings.cli <command>

Pull workflow (via the WorkIQ MCP in an agent session):
  1. (agent) workiq-fetch /me/calendarView?startDateTime=...&endDateTime=...&$select=...
  2. stage-raw --file "<temp output>" --name <NN_label>
  3. refresh        # ingest -> link (alias + contact) -> profiles -> diff -> mark-synced -> report
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from . import db as dbmod
from . import build_profile as profmod
from . import link_customers as linkmod
from . import report as repmod
from . import ingest_meetings as ingestmod
from . import sync as syncmod
from . import contacts as contactsmod
from tools.teams import aliases as aliasmod
from tools.common import linking as linkingmod
from tools.common import ai_classify as aiclassifymod

ROOT = Path(__file__).resolve().parents[2]
EXPORTS = ROOT / "tools" / "meetings" / "exports"
MESSAGES_DIR = EXPORTS / "messages"

try:
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")
except (AttributeError, ValueError):
    pass


def _con(args):
    con = dbmod.connect(getattr(args, "db", None))
    dbmod.ensure_schema(con)
    return con


def cmd_aliases(args):
    con = _con(args)
    counts = aliasmod.build_alias_table(con)
    print(f"Alias table built for {len(counts)} accounts (shared with Teams/email).")


def cmd_stage_raw(args):
    MESSAGES_DIR.mkdir(parents=True, exist_ok=True)
    src = Path(args.file)
    if not src.exists():
        print(f"File not found: {src}")
        return
    name = args.name or src.stem
    if not name.endswith(".json"):
        name += ".json"
    dst = MESSAGES_DIR / name
    raw = src.read_text(encoding="utf-8")
    try:
        obj = json.loads(raw)
    except ValueError:
        print("Could not parse the source file as JSON.")
        return
    wrapped = {"searchTpid": args.tpid, "raw": obj}
    dst.write_text(json.dumps(wrapped, ensure_ascii=False), encoding="utf-8")
    _tpid, events = ingestmod.load_export(dst)
    print(f"Staged {dst.name}{f' -> tpid {args.tpid}' if args.tpid else ''} ({len(events)} event(s))")


def cmd_ingest(args):
    con = _con(args)
    res = ingestmod.ingest_dir(con, MESSAGES_DIR)
    print(f"Ingested {res['meetings']} meeting(s) from {res['files']} file(s).")


def cmd_link(args):
    con = _con(args)
    aliasmod.build_alias_table(con)
    res = linkmod.link_meetings(con)
    cres = contactsmod.link_by_contacts(con)
    ires = contactsmod.link_by_identity(con)
    linkingmod.assign_tiers(con, "meeting_customer_links")
    print(f"Linked {res['matched_meetings']} meeting(s) via alias; {res['link_rows']} alias link(s), "
          f"{res['series_propagated']} series-propagated. Contact-linked {cres['related_meetings']} "
          f"meeting(s); {cres['new_links']} new contact link(s). "
          f"Identity-linked {ires['related_meetings']} meeting(s); {ires['new_links']} new link(s).")


def cmd_build_profile(args):
    con = _con(args)
    if args.tpid:
        r = profmod.build_profile(con, args.tpid)
        print(f"{r['display_name']:<32}: {r['meetings']} meetings")
    else:
        for r in profmod.build_all(con):
            print(f"  {r['display_name']:<30}: {r['meetings']} meetings")


def cmd_report(args):
    con = _con(args)
    stats = repmod.inventory_stats(con)
    print(f"Meetings: {stats['meetings']} | customer-related: {stats['customer_related']} | "
          f"links: {stats['links']} | profiles: {stats['profiles']}")
    print("Per account:")
    for r in repmod.customer_breakdown(con):
        print(f"  {r['display_name']:<30} {r['meetings']:>4} meetings · last {r['last_activity'] or 'n/a'}")


def cmd_show_profile(args):
    con = _con(args)
    row = con.execute(
        "SELECT profile_markdown FROM active_meeting_customer_profile WHERE tpid=?", (args.tpid,)
    ).fetchone()
    print(row["profile_markdown"] if row else f"No meeting profile for tpid {args.tpid}")


def cmd_customer(args):
    con = _con(args)
    for m in repmod.meetings_for_customer(con, args.tpid, limit=args.limit):
        online = "online" if m["is_online_meeting"] else "in-person"
        print(f"  {(m['start_at'] or 'n/a')[:16]} | {m['match_method']:<7} | {online:<9} | "
              f"{m['organizer_name'] or '?':<22} | {(m['subject'] or '')[:60]}")


def cmd_diff(args):
    con = _con(args)
    rows = syncmod.diff(con, args.tpid)
    if args.json:
        print(json.dumps(rows, ensure_ascii=False, indent=1))
        return
    actionable = [r for r in rows if r["reason"] != "up_to_date"]
    print(f"=== {len(actionable)} account(s) with new/never-synced meetings "
          f"({sum(r['new_since_watermark'] for r in actionable)} new) ===")
    for r in rows:
        flag = {"never_synced": "[NEW]", "new_meetings": "[UPD]", "up_to_date": "  ok "}[r["reason"]]
        print(f"{flag} {r['display_name']:<30} +{r['new_since_watermark']:<4} "
              f"(synced through {r['synced_through'] or 'never'})")


def cmd_mark_synced(args):
    con = _con(args)
    n = syncmod.mark_synced(con, args.tpid)
    print(f"Advanced watermark for {n} account(s).")


def cmd_contact_manifest(args):
    con = _con(args)
    info = contactsmod.domains_for_tpid(con, args.tpid)
    payload = {
        "tpid": args.tpid,
        "display_name": aliasmod.display_name_for(args.tpid),
        "domains": info["domains"],
        "contacts": info["contacts"],
    }
    if args.json:
        print(json.dumps(payload, ensure_ascii=False, indent=1))
    else:
        print(f"{payload['display_name']} ({args.tpid})")
        print(f"  domains : {', '.join(info['domains']) or '(none)'}")
        print(f"  contacts: {len(info['contacts'])} external address(es)")


def cmd_refresh(args):
    """One-shot end-to-end refresh after staging new calendar pulls:
    ingest -> link (alias + contact) -> build profiles -> diff -> mark-synced -> report."""
    con = _con(args)

    print("1/5 Ingesting staged exports…")
    res = ingestmod.ingest_dir(con, MESSAGES_DIR)
    print(f"    ingested {res['meetings']} meeting(s) from {res['files']} file(s).")

    print("2/5 Linking (identity + alias + series + contact)…")
    aliasmod.build_alias_table(con)
    lres = linkmod.link_meetings(con)
    cres = contactsmod.link_by_contacts(con)
    ires = contactsmod.link_by_identity(con)
    linkingmod.assign_tiers(con, "meeting_customer_links")
    vres = aiclassifymod.verify_weak_links(con, "meeting")
    print(f"    alias {lres['link_rows']} link(s), {lres['series_propagated']} series; "
          f"contact {cres['new_links']} new; identity {ires['new_links']} new; "
          f"AI-verify {vres['confirmed']}✓/{vres['rejected']}✗ of {vres['candidates']} weak.")

    print("3/5 Building meeting profiles…")
    profs = profmod.build_all(con)
    print(f"    {len(profs)} profile(s) rebuilt.")

    print("4/5 New since last sync:")
    rows = syncmod.diff(con, args.tpid)
    actionable = [r for r in rows if r["reason"] != "up_to_date"]
    if actionable:
        for r in actionable:
            print(f"    +{r['new_since_watermark']:<4} {r['display_name']}")
    else:
        print("    (nothing new beyond the previous watermark)")

    if not args.no_mark:
        n = syncmod.mark_synced(con, args.tpid)
        print(f"5/5 Advanced watermark for {n} account(s).")
    else:
        print("5/5 Watermark NOT advanced (--no-mark).")

    print("\n=== Coverage ===")
    stats = repmod.inventory_stats(con)
    print(f"Meetings: {stats['meetings']} | customer-related: {stats['customer_related']} | "
          f"links: {stats['links']} | profiles: {stats['profiles']}")
    for r in repmod.customer_breakdown(con):
        print(f"  {r['display_name']:<30} {r['meetings']:>4} meetings")


def main(argv=None):
    p = argparse.ArgumentParser(prog="tools.meetings.cli", description="Meeting datastore tool")
    p.add_argument("--db", help="Path to seassist.db (default: live app db)")
    sub = p.add_subparsers(dest="cmd", required=True)

    sub.add_parser("aliases").set_defaults(func=cmd_aliases)

    s = sub.add_parser("stage-raw", help="Stage a raw WorkIQ calendarView output file")
    s.add_argument("--file", required=True)
    s.add_argument("--tpid", help="Optional account hint (linking is by content, not this)")
    s.add_argument("--name")
    s.set_defaults(func=cmd_stage_raw)

    sub.add_parser("ingest", help="Upsert staged meetings").set_defaults(func=cmd_ingest)
    sub.add_parser("link", help="Content-match meetings to accounts").set_defaults(func=cmd_link)

    s = sub.add_parser("build-profile")
    s.add_argument("--all", action="store_true")
    s.add_argument("--tpid")
    s.set_defaults(func=cmd_build_profile)

    sub.add_parser("report").set_defaults(func=cmd_report)

    s = sub.add_parser("show-profile"); s.add_argument("tpid"); s.set_defaults(func=cmd_show_profile)
    s = sub.add_parser("customer"); s.add_argument("tpid"); s.add_argument("--limit", type=int, default=40); s.set_defaults(func=cmd_customer)

    s = sub.add_parser("diff", help="Show meetings since the last synced watermark")
    s.add_argument("--tpid")
    s.add_argument("--json", action="store_true")
    s.set_defaults(func=cmd_diff)

    s = sub.add_parser("mark-synced", help="Advance the per-account meeting watermark")
    s.add_argument("--tpid")
    s.set_defaults(func=cmd_mark_synced)

    s = sub.add_parser("contact-manifest", help="Customer domains + contacts for one account")
    s.add_argument("--tpid", required=True)
    s.add_argument("--json", action="store_true")
    s.set_defaults(func=cmd_contact_manifest)

    s = sub.add_parser("refresh", help="One-shot: ingest -> link -> profiles -> diff -> mark-synced -> report")
    s.add_argument("--tpid", help="Limit diff/mark-synced to one account")
    s.add_argument("--no-mark", action="store_true", help="Do not advance the watermark")
    s.set_defaults(func=cmd_refresh)

    args = p.parse_args(argv)
    args.func(args)


if __name__ == "__main__":
    main()
