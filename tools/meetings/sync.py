"""Differential / incremental meeting sync via a per-account watermark.

`meeting_sync.synced_through` holds the newest `start_at` we had ingested for an account
the last time it was marked synced. `diff` reports, per account, how many linked meetings
have arrived since that watermark (or that it was never synced). `mark_synced` advances
the watermark.
"""
from __future__ import annotations

import sqlite3

from tools.teams import aliases as aliasmod


def _current_max(con: sqlite3.Connection, tpid: str) -> str | None:
    row = con.execute(
        """SELECT MAX(m.start_at) v
           FROM active_meetings m JOIN active_meeting_customer_links l ON l.event_id = m.event_id
           WHERE l.tpid = ?""",
        (tpid,),
    ).fetchone()
    return row["v"] if row else None


def _watermark(con: sqlite3.Connection, tpid: str) -> str | None:
    row = con.execute(
        "SELECT synced_through FROM meeting_sync WHERE scope_key = ?", (tpid,)
    ).fetchone()
    return row["synced_through"] if row else None


def _new_count(con: sqlite3.Connection, tpid: str, watermark: str | None) -> int:
    if watermark is None:
        return con.execute(
            """SELECT COUNT(*) n
               FROM active_meetings m JOIN active_meeting_customer_links l ON l.event_id = m.event_id
               WHERE l.tpid = ?""",
            (tpid,),
        ).fetchone()["n"]
    return con.execute(
        """SELECT COUNT(*) n
           FROM active_meetings m JOIN active_meeting_customer_links l ON l.event_id = m.event_id
           WHERE l.tpid = ? AND m.start_at > ?""",
        (tpid, watermark),
    ).fetchone()["n"]


def diff(con: sqlite3.Connection, tpid: str | None = None) -> list[dict]:
    tpids = [tpid] if tpid else aliasmod.known_tpids(con)
    out = []
    for t in tpids:
        wm = _watermark(con, t)
        cur = _current_max(con, t)
        new = _new_count(con, t, wm)
        if wm is None:
            reason = "never_synced"
        elif cur and cur > wm:
            reason = "new_meetings"
        else:
            reason = "up_to_date"
        out.append(
            {
                "tpid": t,
                "display_name": aliasmod.display_name_for(t),
                "synced_through": wm,
                "latest": cur,
                "new_since_watermark": new,
                "reason": reason,
            }
        )
    out.sort(key=lambda r: (r["reason"] == "up_to_date", -r["new_since_watermark"]))
    return out


def mark_synced(con: sqlite3.Connection, tpid: str | None = None) -> int:
    tpids = [tpid] if tpid else aliasmod.known_tpids(con)
    n = 0
    for t in tpids:
        cur = _current_max(con, t)
        if cur is None:
            continue
        con.execute(
            """INSERT INTO meeting_sync (scope_key, synced_through, last_run_at)
               VALUES (?,?, CURRENT_TIMESTAMP)
               ON CONFLICT(scope_key) DO UPDATE SET
                 synced_through = excluded.synced_through,
                 last_run_at = CURRENT_TIMESTAMP""",
            (t, cur),
        )
        n += 1
    con.commit()
    return n
