"""Reporting / querying over the meeting datastore."""
from __future__ import annotations

import sqlite3

from tools.teams import aliases as aliasmod


def inventory_stats(con: sqlite3.Connection) -> dict:
    total = con.execute("SELECT COUNT(*) n FROM active_meetings").fetchone()["n"]
    customer = con.execute(
        "SELECT COUNT(*) n FROM active_meetings WHERE is_customer_related=1"
    ).fetchone()["n"]
    links = con.execute("SELECT COUNT(*) n FROM active_meeting_customer_links").fetchone()["n"]
    profiles = con.execute("SELECT COUNT(*) n FROM active_meeting_customer_profile").fetchone()["n"]
    return {
        "meetings": total,
        "customer_related": customer,
        "links": links,
        "profiles": profiles,
    }


def customer_breakdown(con: sqlite3.Connection) -> list[dict]:
    rows = con.execute(
        """SELECT l.tpid,
                  COUNT(DISTINCT l.event_id) meetings,
                  MAX(m.start_at) last_activity
           FROM active_meeting_customer_links l
           JOIN active_meetings m ON m.event_id = l.event_id
           GROUP BY l.tpid
           ORDER BY meetings DESC"""
    ).fetchall()
    return [
        {
            "tpid": str(r["tpid"]),
            "display_name": aliasmod.display_name_for(str(r["tpid"])),
            "meetings": r["meetings"],
            "last_activity": r["last_activity"],
        }
        for r in rows
    ]


def meetings_for_customer(con: sqlite3.Connection, tpid: str, limit: int = 40) -> list[dict]:
    rows = con.execute(
        """SELECT m.event_id, m.subject, m.organizer_name, m.start_at,
                  m.is_online_meeting, l.match_method, l.confidence
           FROM active_meeting_customer_links l
           JOIN active_meetings m ON m.event_id = l.event_id
           WHERE l.tpid = ?
           ORDER BY (m.start_at IS NULL), m.start_at DESC
           LIMIT ?""",
        (tpid, limit),
    ).fetchall()
    return [dict(r) for r in rows]
