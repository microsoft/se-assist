"""Reporting / querying over the email datastore."""
from __future__ import annotations

import sqlite3

from tools.teams import aliases as aliasmod


def inventory_stats(con: sqlite3.Connection) -> dict:
    total = con.execute("SELECT COUNT(*) n FROM active_emails").fetchone()["n"]
    customer = con.execute(
        "SELECT COUNT(*) n FROM active_emails WHERE is_customer_related=1"
    ).fetchone()["n"]
    links = con.execute("SELECT COUNT(*) n FROM active_email_customer_links").fetchone()["n"]
    profiles = con.execute("SELECT COUNT(*) n FROM active_email_customer_profile").fetchone()["n"]
    return {
        "emails": total,
        "customer_related": customer,
        "links": links,
        "profiles": profiles,
    }


def customer_breakdown(con: sqlite3.Connection) -> list[dict]:
    rows = con.execute(
        """SELECT l.tpid,
                  COUNT(DISTINCT l.message_id) emails,
                  COUNT(DISTINCT e.conversation_id) threads,
                  MAX(e.received_at) last_activity
           FROM active_email_customer_links l
           JOIN active_emails e ON e.message_id = l.message_id
           GROUP BY l.tpid
           ORDER BY emails DESC"""
    ).fetchall()
    return [
        {
            "tpid": str(r["tpid"]),
            "display_name": aliasmod.display_name_for(str(r["tpid"])),
            "emails": r["emails"],
            "threads": r["threads"],
            "last_activity": r["last_activity"],
        }
        for r in rows
    ]


def emails_for_customer(con: sqlite3.Connection, tpid: str, limit: int = 40) -> list[dict]:
    rows = con.execute(
        """SELECT e.message_id, e.subject, e.from_name, e.from_address, e.received_at,
                  l.match_method, l.confidence
           FROM active_email_customer_links l
           JOIN active_emails e ON e.message_id = l.message_id
           WHERE l.tpid = ?
           ORDER BY (e.received_at IS NULL), e.received_at DESC
           LIMIT ?""",
        (tpid, limit),
    ).fetchall()
    return [dict(r) for r in rows]
