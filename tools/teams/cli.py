"""Command-line interface for the Teams datastore tool.

Run from the repo root, e.g.:
    python -m tools.teams.cli report
    python -m tools.teams.cli sync          # ingest chats + aliases + link
    python -m tools.teams.cli fetch-manifest --limit 50
    python -m tools.teams.cli build-profile --all
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from . import aliases as aliasmod
from . import ai_aliases as aialiasmod
from . import build_profile as profilemod
from . import db as dbmod
from . import ingest_chats, ingest_messages, link_customers, report
from tools.common import linking as linkingmod
from tools.common import ai_classify as aiclassifymod

EXPORTS = Path(__file__).resolve().parent / "exports"


def _con(args):
    con = dbmod.connect(args.db)
    dbmod.ensure_schema(con)
    return con


def cmd_init_db(args):
    con = _con(args)
    print("Schema ensured at", args.db or dbmod.default_db_path())
    con.close()


def cmd_aliases(args):
    con = _con(args)
    counts = aliasmod.build_alias_table(con)
    print("Alias table built. Active aliases per account:")
    for tpid, n in sorted(counts.items(), key=lambda x: -x[1]):
        print(f"  {aliasmod.display_name_for(tpid):32} (tpid {tpid}): {n}")
    con.close()


def cmd_gen_aliases(args):
    """Generate short AI aliases per customer (fallback: exact name) before linking."""
    con = _con(args)
    # Ensure curated + auto (exact-name) rows exist first so a standalone run is complete.
    aliasmod.build_alias_table(con)
    summary = aialiasmod.refresh_ai_aliases(
        con,
        model=args.model,
        batch_size=args.batch,
        max_new=args.max_new,
    )
    if args.json:
        print(json.dumps(summary, ensure_ascii=False))
    else:
        avail = "yes" if summary["model_available"] else "no (exact-name fallback)"
        print(f"AI aliases — model {summary['model']} available: {avail}")
        print(
            f"  customers: {summary['customers']} | ai: {summary['ai_generated']} | "
            f"cached: {summary['from_cache']} | fallback: {summary['fallback']} | "
            f"remaining: {summary['remaining']}"
        )
    con.close()


def cmd_ingest_chats(args):
    con = _con(args)
    d = args.dir or EXPORTS
    res = ingest_chats.ingest_dir(con, d)
    print(f"Ingested chats from {d}: {res}")
    con.close()


def cmd_link(args):
    con = _con(args)
    res = link_customers.link_chats(con)
    ires = link_customers.link_by_identity(con)
    linkingmod.assign_tiers(con, "teams_chat_customer_links")
    print(f"Linked {res['matched_chats']} chats ({res['link_rows']} links); "
          f"identity {ires['new_links']} new link(s).")
    for tpid, n in sorted(res["per_tpid"].items(), key=lambda x: -x[1]):
        print(f"  {aliasmod.display_name_for(tpid):32} (tpid {tpid}): {n} chats")
    con.close()


def cmd_ingest_messages(args):
    con = _con(args)
    d = args.dir or (EXPORTS / "messages")
    res = ingest_messages.ingest_dir(con, d)
    print(f"Ingested messages from {d}: {res}")
    con.close()


def cmd_mark_pulled(args):
    """Advance the watermark for chats that returned only system events (no messages)."""
    con = _con(args)
    ids = list(args.chat_ids or [])
    if args.from_json:
        data = json.loads(Path(args.from_json).read_text(encoding="utf-8"))
        ids += [d["chat_id"] if isinstance(d, dict) else d for d in data]
    for cid in ids:
        ingest_messages.mark_pulled(con, cid)
    print(f"Marked {len(ids)} chat(s) as pulled (watermark advanced, no messages stored).")
    con.close()


def cmd_sync(args):
    """One-shot: aliases + ingest chats + link (alias + identity + AI-verify)."""
    con = _con(args)
    aliasmod.build_alias_table(con)
    chat_res = ingest_chats.ingest_dir(con, args.dir or EXPORTS)
    link_res = link_customers.link_chats(con)
    ident_res = link_customers.link_by_identity(con)
    linkingmod.assign_tiers(con, "teams_chat_customer_links")
    vres = aiclassifymod.verify_weak_links(con, "chat")
    print(f"Chats: {chat_res}")
    print(f"Linked: {link_res['matched_chats']} chats, {link_res['link_rows']} links; "
          f"identity {ident_res['new_links']} new; "
          f"AI-verify {vres['confirmed']}/{vres['rejected']} of {vres['candidates']} weak")
    con.close()


def cmd_report(args):
    con = _con(args)
    stats = report.inventory_stats(con)
    print("=== INVENTORY ===")
    print(json.dumps(stats, indent=2))
    print("\n=== CUSTOMER BREAKDOWN ===")
    for c in report.customer_breakdown(con):
        print(
            f"{c['display_name']:32} (tpid {c['tpid']:>9}) | "
            f"{c['chats']:3} chats | {c['unread']:3} unread | "
            f"{c['messages']:5} msgs | last {c['last_activity'] or 'n/a'}"
        )
    con.close()


def cmd_customer(args):
    con = _con(args)
    rows = report.chats_for_customer(con, args.tpid)
    print(f"=== {aliasmod.display_name_for(args.tpid)} (tpid {args.tpid}) — {len(rows)} chats ===")
    for r in rows:
        unread = " [UNREAD]" if r["has_unread"] else ""
        print(
            f"[{(r['last_message_at'] or '')[:10]}] {(r['topic'] or '(unnamed)')[:50]:50} "
            f"| {r['match_method']}:{r['matched_term'] or ''}{unread}"
        )
    con.close()


def cmd_unlinked(args):
    con = _con(args)
    rows = report.unlinked_named_chats(con, args.limit)
    print(f"=== {len(rows)} unlinked named group chats (candidates) ===")
    for r in rows:
        print(f"[{(r['last_message_at'] or '')[:10]}] {r['topic']}")
    con.close()


def cmd_fetch_manifest(args):
    """Emit chat IDs of customer chats still needing message bodies (for the agent)."""
    con = _con(args)
    params: list = []
    q = """SELECT DISTINCT c.chat_id, c.topic, c.last_message_at
           FROM active_teams_chats c
           JOIN active_teams_chat_customer_links l ON l.chat_id = c.chat_id
           WHERE l.match_method <> 'ai-rejected' AND c.messages_synced=0"""
    if args.tpid:
        q += " AND l.tpid = ?"
        params.append(args.tpid)
    if not args.all:
        q += " AND c.last_message_at IS NOT NULL"
    q += " ORDER BY c.last_message_at DESC"
    if args.limit:
        q += f" LIMIT {int(args.limit)}"
    rows = con.execute(q, params).fetchall()
    manifest = [{"chat_id": r["chat_id"], "topic": r["topic"], "last": r["last_message_at"]} for r in rows]
    print(json.dumps(manifest, indent=2, ensure_ascii=False))
    con.close()


def cmd_stage_raw(args):
    """Copy a raw ListChatMessages tool-output file into exports/messages and map it."""
    import re as _re
    import shutil

    msg_dir = EXPORTS / "messages"
    msg_dir.mkdir(parents=True, exist_ok=True)
    src = Path(args.file)
    if not src.exists():
        print(f"File not found: {src}", file=sys.stderr)
        return
    safe = _re.sub(r"[^a-z0-9]+", "_", (args.name or src.stem).lower()).strip("_") + ".json"
    dest = msg_dir / safe
    shutil.copyfile(src, dest)
    map_path = msg_dir / "_map.json"
    mapping = {}
    if map_path.exists():
        try:
            mapping = json.loads(map_path.read_text(encoding="utf-8"))
        except (ValueError, OSError):
            mapping = {}
    mapping[safe] = args.chat_id
    map_path.write_text(json.dumps(mapping, indent=2), encoding="utf-8")
    print(f"Staged {dest.name} -> {args.chat_id}")
    con = None


def cmd_diff(args):
    """Show the differential: customer chats with new activity since last message pull."""
    con = _con(args)
    rows = report.stale_chats(con, args.tpid, getattr(args, "limit", 0) or 0)
    if args.json:
        manifest = [{"chat_id": r["chat_id"], "topic": r["topic"]} for r in rows]
        print(json.dumps(manifest, indent=2, ensure_ascii=False))
    else:
        never = sum(1 for r in rows if r["reason"] == "never_pulled")
        upd = len(rows) - never
        print(f"=== {len(rows)} chat(s) need a message pull "
              f"({never} new, {upd} updated) ===")
        for r in rows:
            tag = "NEW" if r["reason"] == "never_pulled" else "UPD"
            print(
                f"[{tag}] {(r['last_message_at'] or '')[:16]} "
                f"{(r['topic'] or '(unnamed)')[:48]:48} "
                f"(synced through {r['synced_through'] or 'never'})"
            )
        if rows:
            print("\nNext: fetch ListChatMessages for each chat_id above, stage-raw them, "
                  "then run ingest-messages. Use --json for a machine-readable manifest.")
    con.close()


def cmd_build_profile(args):
    con = _con(args)
    if args.all:
        res = profilemod.build_all(con)
        print(f"Built {len(res)} profiles:")
        for r in res:
            print(f"  {r['display_name']:32}: {r['chats']} chats, {r['messages']} msgs")
    elif args.tpid:
        r = profilemod.build_profile(con, args.tpid)
        print(f"Built profile for {r['display_name']}: {r['chats']} chats, {r['messages']} msgs")
    else:
        print("Provide --all or a tpid", file=sys.stderr)
    con.close()


def cmd_show_profile(args):
    con = _con(args)
    row = con.execute(
        "SELECT profile_markdown FROM active_teams_customer_profile WHERE tpid=?", (args.tpid,)
    ).fetchone()
    print(row["profile_markdown"] if row else f"No profile for tpid {args.tpid}. Run build-profile first.")
    con.close()


def main(argv=None):
    # Ensure Unicode (emoji, accented names) prints on Windows consoles (cp1252).
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8")
        except (AttributeError, ValueError):
            pass

    p = argparse.ArgumentParser(prog="tools.teams.cli", description="Teams chat datastore tool")
    p.add_argument("--db", help="Path to seassist.db (default: %%APPDATA%%/se-assist/seassist.db)")
    sub = p.add_subparsers(dest="cmd", required=True)

    sub.add_parser("init-db").set_defaults(func=cmd_init_db)
    sub.add_parser("aliases").set_defaults(func=cmd_aliases)

    s = sub.add_parser("gen-aliases", help="Generate short AI aliases per customer (fallback: exact name)")
    s.add_argument("--model", default=aialiasmod.DEFAULT_MODEL, help="Copilot fast-model label (informational; actual model comes from the Copilot env)")
    s.add_argument("--batch", type=int, default=aialiasmod.DEFAULT_BATCH, help="Names per model call")
    s.add_argument("--max-new", type=int, default=aialiasmod.DEFAULT_MAX_NEW, dest="max_new",
                   help="Cap new (uncached) names generated this run")
    s.add_argument("--json", action="store_true", help="Emit a machine-readable summary")
    s.set_defaults(func=cmd_gen_aliases)

    s = sub.add_parser("ingest-chats"); s.add_argument("--dir"); s.set_defaults(func=cmd_ingest_chats)
    sub.add_parser("link").set_defaults(func=cmd_link)
    s = sub.add_parser("ingest-messages"); s.add_argument("--dir"); s.set_defaults(func=cmd_ingest_messages)

    s = sub.add_parser("mark-pulled", help="Advance watermark for empty (system-event-only) chats")
    s.add_argument("chat_ids", nargs="*", help="One or more chat_ids")
    s.add_argument("--from-json", help="JSON file/manifest of chat_ids (or [{chat_id:..}])")
    s.set_defaults(func=cmd_mark_pulled)
    s = sub.add_parser("sync"); s.add_argument("--dir"); s.set_defaults(func=cmd_sync)
    sub.add_parser("report").set_defaults(func=cmd_report)

    s = sub.add_parser("customer"); s.add_argument("tpid"); s.set_defaults(func=cmd_customer)
    s = sub.add_parser("unlinked"); s.add_argument("--limit", type=int, default=60); s.set_defaults(func=cmd_unlinked)

    s = sub.add_parser("fetch-manifest")
    s.add_argument("--limit", type=int, default=0)
    s.add_argument("--tpid", help="Only chats linked to this account tpid")
    s.add_argument("--all", action="store_true", help="Include chats with no last_message_at")
    s.set_defaults(func=cmd_fetch_manifest)

    s = sub.add_parser("stage-raw", help="Copy a raw ListChatMessages output file and map it to a chat_id")
    s.add_argument("--file", required=True, help="Path to the raw tool-output file")
    s.add_argument("--chat-id", required=True, dest="chat_id")
    s.add_argument("--name", help="Optional base name for the staged file")
    s.set_defaults(func=cmd_stage_raw)

    s = sub.add_parser("diff", help="Show customer chats with new activity since last message pull")
    s.add_argument("--tpid", help="Only chats linked to this account tpid")
    s.add_argument("--limit", type=int, default=0, help="Max chats to return (0 = all)")
    s.add_argument("--json", action="store_true", help="Emit a machine-readable chat manifest")
    s.set_defaults(func=cmd_diff)

    s = sub.add_parser("build-profile")
    s.add_argument("tpid", nargs="?")
    s.add_argument("--all", action="store_true")
    s.set_defaults(func=cmd_build_profile)

    s = sub.add_parser("show-profile"); s.add_argument("tpid"); s.set_defaults(func=cmd_show_profile)

    args = p.parse_args(argv)
    args.func(args)


if __name__ == "__main__":
    main()
