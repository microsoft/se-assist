"""CLI for the email -> customer intelligence datastore.

Run from the repo root:  python -m tools.email.cli <command>

Pull workflow (per account, via the WorkIQ MCP in an agent session):
  1. (agent) workiq-fetch /me/messages?$search="<alias>"&$select=...&$top=100
  2. stage-raw --file "<temp output>" --tpid <tpid> --name <NN_label>
  3. ingest        # upsert emails + record search-hint links
  4. link          # content-match emails -> accounts (alias)
  5. build-profile --all
  6. report
"""
from __future__ import annotations

import argparse
import io
import json
import shutil
import sys
from pathlib import Path

from . import db as dbmod
from . import build_profile as profmod
from . import link_customers as linkmod
from . import report as repmod
from . import ingest_emails as ingestmod
from . import sync as syncmod
from . import contacts as contactsmod
from tools.teams import aliases as aliasmod
from tools.common import linking as linkingmod
from tools.common import ai_classify as aiclassifymod

ROOT = Path(__file__).resolve().parents[2]
EXPORTS = ROOT / "tools" / "email" / "exports"
MESSAGES_DIR = EXPORTS / "messages"

try:
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")
except Exception:
    pass


def _con(args):
    con = dbmod.connect(getattr(args, "db", None))
    dbmod.ensure_schema(con)
    return con


def cmd_aliases(args):
    con = _con(args)
    counts = aliasmod.build_alias_table(con)
    print(f"Alias table built for {len(counts)} accounts (shared with Teams).")


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
    # Wrap the raw WorkIQ output with the account hint so ingest can record search links.
    raw = src.read_text(encoding="utf-8")
    try:
        obj = json.loads(raw)
    except ValueError:
        print("Could not parse the source file as JSON.")
        return
    wrapped = {"searchTpid": args.tpid, "raw": obj}
    dst.write_text(json.dumps(wrapped, ensure_ascii=False), encoding="utf-8")
    _tpid, msgs = ingestmod.load_export(dst)
    print(f"Staged {dst.name} -> tpid {args.tpid} ({len(msgs)} message(s))")


def cmd_ingest(args):
    con = _con(args)
    d = MESSAGES_DIR
    if not d.exists():
        print("No exports/messages directory yet.")
        return
    files = [f for f in sorted(d.glob("*.json")) if f.name != "_map.json"]
    total_emails = 0
    for f in files:
        _search_tpid, messages = ingestmod.load_export(f)
        total_emails += ingestmod.upsert_emails(con, messages)
    # NOTE: we intentionally do NOT create "search-hint" links here. The mailbox
    # $search used to pull candidates is imprecise (it pads results with generic
    # recent items), so linking every searched email to its search account produces
    # noise. Accounts are assigned solely by alias content-match in `link`.
    print(f"Ingested {total_emails} email(s) from {len(files)} file(s).")


def cmd_link(args):
    con = _con(args)
    aliasmod.build_alias_table(con)
    res = linkmod.link_emails(con)
    cres = contactsmod.link_by_contacts(con)
    ires = contactsmod.link_by_identity(con)
    linkingmod.assign_tiers(con, "email_customer_links")
    print(f"Linked {res['matched_emails']} email(s) via alias; {res['link_rows']} alias link(s). "
          f"Contact-linked {cres['related_emails']} email(s); {cres['new_links']} new contact link(s). "
          f"Identity-linked {ires['related_emails']} email(s); {ires['new_links']} new link(s).")


def cmd_build_profile(args):
    con = _con(args)
    if args.tpid:
        r = profmod.build_profile(con, args.tpid)
        print(f"{r['display_name']:<32}: {r['emails']} emails, {r['threads']} threads")
    else:
        for r in profmod.build_all(con):
            print(f"  {r['display_name']:<30}: {r['emails']} emails, {r['threads']} threads")


def cmd_report(args):
    con = _con(args)
    stats = repmod.inventory_stats(con)
    print(f"Emails: {stats['emails']} | customer-related: {stats['customer_related']} | "
          f"links: {stats['links']} | profiles: {stats['profiles']}")
    print("Per account:")
    for r in repmod.customer_breakdown(con):
        print(f"  {r['display_name']:<30} {r['emails']:>4} emails · {r['threads']:>3} threads · last {r['last_activity'] or 'n/a'}")


def cmd_show_profile(args):
    con = _con(args)
    row = con.execute(
        "SELECT profile_markdown FROM active_email_customer_profile WHERE tpid=?", (args.tpid,)
    ).fetchone()
    print(row["profile_markdown"] if row else f"No email profile for tpid {args.tpid}")


def cmd_customer(args):
    con = _con(args)
    for e in repmod.emails_for_customer(con, args.tpid, limit=args.limit):
        print(f"  {e['received_at'] or 'n/a'} | {e['match_method']:<6} | {e['from_name'] or '?':<22} | {(e['subject'] or '')[:60]}")


def cmd_manifest(args):
    """Emit the per-account search manifest (alias -> search query) for the pull step."""
    con = _con(args) if args.stale else None
    stale_tpids = None
    if con is not None:
        stale = syncmod.diff(con)
        stale_tpids = {r["tpid"] for r in stale if r["reason"] != "up_to_date"}
    out = []
    for tpid, (display, aliases) in aliasmod.CURATED.items():
        if stale_tpids is not None and tpid not in stale_tpids:
            continue
        terms = " OR ".join(f'"{a}"' for a in aliases if len(a) >= 3)
        out.append({"tpid": tpid, "display_name": display, "search": terms})
    if args.json:
        print(json.dumps(out, ensure_ascii=False, indent=1))
    else:
        for m in out:
            print(f"{m['tpid']:<10} {m['display_name']:<30} {m['search']}")


def cmd_diff(args):
    con = _con(args)
    rows = syncmod.diff(con, args.tpid)
    if args.json:
        print(json.dumps(rows, ensure_ascii=False, indent=1))
        return
    actionable = [r for r in rows if r["reason"] != "up_to_date"]
    print(f"=== {len(actionable)} account(s) with new/never-synced email "
          f"({sum(r['new_since_watermark'] for r in actionable)} new emails) ===")
    for r in rows:
        flag = {"never_synced": "[NEW]", "new_mail": "[UPD]", "up_to_date": "  ok "}[r["reason"]]
        print(f"{flag} {r['display_name']:<30} +{r['new_since_watermark']:<4} "
              f"(synced through {r['synced_through'] or 'never'})")


def cmd_mark_synced(args):
    con = _con(args)
    n = syncmod.mark_synced(con, args.tpid)
    print(f"Advanced watermark for {n} account(s).")


def cmd_contact_manifest(args):
    """Emit the customer domains + external contacts to drive a contact-based search."""
    con = _con(args)
    info = contactsmod.domains_for_tpid(con, args.tpid)
    searches = [f'"{d}"' for d in info["domains"]]
    payload = {
        "tpid": args.tpid,
        "display_name": aliasmod.display_name_for(args.tpid),
        "domains": info["domains"],
        "contacts": info["contacts"],
        "searches": searches,
    }
    if args.json:
        print(json.dumps(payload, ensure_ascii=False, indent=1))
    else:
        print(f"{payload['display_name']} ({args.tpid})")
        print(f"  domains : {', '.join(info['domains']) or '(none — no single-account customer domain)'}")
        print(f"  contacts: {len(info['contacts'])} external address(es)")
        print(f"  search  : {' OR '.join(searches) or '(nothing to search by)'}")


def cmd_link_contacts(args):
    con = _con(args)
    res = contactsmod.link_by_contacts(con, args.tpid)
    print(f"Contact-linked {res['related_emails']} email(s); {res['new_links']} new link(s) "
          f"(domains={res['domains']}, contacts={res['contacts']}).")


def cmd_refresh(args):
    """One-shot end-to-end refresh after staging new email pulls:
    ingest -> link (alias + contact) -> build profiles -> rebuild account team
    -> show what's new (diff) -> advance watermarks -> report."""
    con = _con(args)

    print("1/6 Ingesting staged exports…")
    d = MESSAGES_DIR
    files = [f for f in sorted(d.glob("*.json")) if f.name != "_map.json"] if d.exists() else []
    total = 0
    for f in files:
        _t, messages = ingestmod.load_export(f)
        total += ingestmod.upsert_emails(con, messages)
    print(f"    ingested {total} email(s) from {len(files)} file(s).")

    print("2/6 Linking (identity + alias + thread + contact)…")
    aliasmod.build_alias_table(con)
    res = linkmod.link_emails(con)
    cres = contactsmod.link_by_contacts(con)
    ires = contactsmod.link_by_identity(con)
    linkingmod.assign_tiers(con, "email_customer_links")
    vres = aiclassifymod.verify_weak_links(con, "email")
    print(f"    alias {res['link_rows']} link(s); contact {cres['new_links']} new; "
          f"identity {ires['new_links']} new; "
          f"AI-verify {vres['confirmed']}✓/{vres['rejected']}✗ of {vres['candidates']} weak.")

    print("3/6 Building email profiles…")
    profs = profmod.build_all(con)
    print(f"    {len(profs)} profile(s) rebuilt.")

    print("4/6 Rebuilding account team…")
    try:
        from tools.account_team import build as teambuild
        con.executescript(_ACCOUNT_TEAM_SCHEMA)
        team = teambuild.build_all(con)
        ms = sum(t["microsoft"] for t in team)
        print(f"    {len(team)} account(s); {ms} Microsoft team members total.")
    except Exception as exc:  # account_team is optional
        print(f"    skipped account team rebuild: {exc}")

    print("5/6 New since last sync:")
    rows = syncmod.diff(con, args.tpid)
    actionable = [r for r in rows if r["reason"] != "up_to_date"]
    if actionable:
        for r in actionable:
            print(f"    +{r['new_since_watermark']:<4} {r['display_name']}")
    else:
        print("    (nothing new beyond the previous watermark)")

    if not args.no_mark:
        n = syncmod.mark_synced(con, args.tpid)
        print(f"6/6 Advanced watermark for {n} account(s).")
    else:
        print("6/6 Watermark NOT advanced (--no-mark).")

    print("\n=== Coverage ===")
    stats = repmod.inventory_stats(con)
    print(f"Emails: {stats['emails']} | customer-related: {stats['customer_related']} | "
          f"links: {stats['links']} | profiles: {stats['profiles']}")
    for r in repmod.customer_breakdown(con):
        print(f"  {r['display_name']:<30} {r['emails']:>4} emails · {r['threads']:>3} threads")


# Mirror of customer_account_team (migration 006) so refresh works before the app applies it.
_ACCOUNT_TEAM_SCHEMA = """
CREATE TABLE IF NOT EXISTS customer_account_team (
  tpid TEXT NOT NULL,
  person_name TEXT NOT NULL,
  person_email TEXT,
  org TEXT NOT NULL DEFAULT 'unverified',
  email_sends INTEGER NOT NULL DEFAULT 0,
  email_cc INTEGER NOT NULL DEFAULT 0,
  teams_msgs INTEGER NOT NULL DEFAULT 0,
  last_activity TEXT,
  sources TEXT NOT NULL DEFAULT '',
  engagement INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (tpid, person_name)
);
CREATE INDEX IF NOT EXISTS idx_account_team_tpid ON customer_account_team(tpid, org, engagement DESC);
"""


def main(argv=None):
    p = argparse.ArgumentParser(prog="tools.email.cli")
    p.add_argument("--db", help="Path to seassist.db (default: live app db)")
    sub = p.add_subparsers(dest="cmd", required=True)

    sub.add_parser("aliases").set_defaults(func=cmd_aliases)

    s = sub.add_parser("stage-raw", help="Stage a raw WorkIQ fetch output file for an account")
    s.add_argument("--file", required=True)
    s.add_argument("--tpid", required=True)
    s.add_argument("--name")
    s.set_defaults(func=cmd_stage_raw)

    sub.add_parser("ingest", help="Upsert staged emails + record search links").set_defaults(func=cmd_ingest)
    sub.add_parser("link", help="Content-match emails to accounts").set_defaults(func=cmd_link)

    s = sub.add_parser("build-profile")
    s.add_argument("--all", action="store_true")
    s.add_argument("--tpid")
    s.set_defaults(func=cmd_build_profile)

    sub.add_parser("report").set_defaults(func=cmd_report)

    s = sub.add_parser("show-profile"); s.add_argument("tpid"); s.set_defaults(func=cmd_show_profile)
    s = sub.add_parser("customer"); s.add_argument("tpid"); s.add_argument("--limit", type=int, default=40); s.set_defaults(func=cmd_customer)

    s = sub.add_parser("manifest", help="Print per-account mailbox search queries")
    s.add_argument("--json", action="store_true")
    s.add_argument("--stale", action="store_true", help="Only accounts with new/never-synced email")
    s.set_defaults(func=cmd_manifest)

    s = sub.add_parser("diff", help="Show emails arrived since the last synced watermark")
    s.add_argument("--tpid")
    s.add_argument("--json", action="store_true")
    s.set_defaults(func=cmd_diff)

    s = sub.add_parser("mark-synced", help="Advance the per-account email watermark")
    s.add_argument("--tpid")
    s.set_defaults(func=cmd_mark_synced)

    s = sub.add_parser("contact-manifest", help="Customer domains + contacts to search by, for one account")
    s.add_argument("--tpid", required=True)
    s.add_argument("--json", action="store_true")
    s.set_defaults(func=cmd_contact_manifest)

    s = sub.add_parser("link-contacts", help="Link emails by customer-domain/contact participants")
    s.add_argument("--tpid")
    s.set_defaults(func=cmd_link_contacts)

    s = sub.add_parser("refresh", help="One-shot: ingest staged pulls -> link -> profiles -> account team -> diff -> mark-synced -> report")
    s.add_argument("--tpid", help="Limit diff/mark-synced to one account")
    s.add_argument("--no-mark", action="store_true", help="Do not advance the watermark")
    s.set_defaults(func=cmd_refresh)

    args = p.parse_args(argv)
    args.func(args)


if __name__ == "__main__":
    main()
