"""Reporting / querying over the Teams datastore."""
from __future__ import annotations

import sqlite3

from . import aliases as aliasmod


def inventory_stats(con: sqlite3.Connection) -> dict:
    row = con.execute(
        """SELECT
             COUNT(*) total,
             SUM(has_unread) unread,
             SUM(is_customer_related) customer_related,
             SUM(messages_synced) messages_synced
           FROM active_teams_chats"""
    ).fetchone()
    by_type = {
        r["chat_type"]: r["n"]
        for r in con.execute(
            "SELECT chat_type, COUNT(*) n FROM active_teams_chats GROUP BY chat_type"
        )
    }
    msgs = con.execute("SELECT COUNT(*) n FROM active_teams_chat_messages").fetchone()["n"]
    return {
        "total_chats": row["total"] or 0,
        "unread": row["unread"] or 0,
        "customer_related": row["customer_related"] or 0,
        "messages_synced_chats": row["messages_synced"] or 0,
        "messages_stored": msgs,
        "by_type": by_type,
    }


def customer_breakdown(con: sqlite3.Connection) -> list[dict]:
    """Chat + message counts per linked account, most chats first."""
    rows = con.execute(
        """SELECT l.tpid,
                  COUNT(DISTINCT l.chat_id) chats,
                  MAX(c.last_message_at) last_activity,
                  SUM(c.has_unread) unread
           FROM active_teams_chat_customer_links l
           JOIN active_teams_chats c ON c.chat_id = l.chat_id
           GROUP BY l.tpid
           ORDER BY chats DESC"""
    ).fetchall()
    out = []
    for r in rows:
        msg = con.execute(
            """SELECT COUNT(*) n FROM active_teams_chat_messages m
               JOIN active_teams_chat_customer_links l ON l.chat_id = m.chat_id
               WHERE l.tpid=?""",
            (r["tpid"],),
        ).fetchone()["n"]
        out.append(
            {
                "tpid": str(r["tpid"]),
                "display_name": aliasmod.display_name_for(str(r["tpid"])),
                "chats": r["chats"],
                "unread": r["unread"] or 0,
                "messages": msg,
                "last_activity": r["last_activity"],
            }
        )
    return out


def chats_for_customer(con: sqlite3.Connection, tpid: str) -> list[dict]:
    rows = con.execute(
        """SELECT c.chat_id, c.topic, c.chat_type, c.has_unread,
                  c.last_message_at, c.last_message_from, c.last_message_preview,
                  c.messages_synced, l.match_method, l.matched_term, l.confidence
           FROM active_teams_chat_customer_links l
           JOIN active_teams_chats c ON c.chat_id = l.chat_id
           WHERE l.tpid=?
           ORDER BY c.last_message_at DESC""",
        (tpid,),
    ).fetchall()
    return [dict(r) for r in rows]


def unlinked_named_chats(con: sqlite3.Connection, limit: int = 60) -> list[dict]:
    """Named group chats with no customer link — candidates for manual mapping/alias tuning."""
    rows = con.execute(
        """SELECT chat_id, topic, chat_type, last_message_at
           FROM active_teams_chats
           WHERE is_customer_related=0 AND topic IS NOT NULL AND chat_type='group'
           ORDER BY last_message_at DESC
           LIMIT ?""",
        (limit,),
    ).fetchall()
    return [dict(r) for r in rows]


def stale_chats(
    con: sqlite3.Connection, tpid: str | None = None, limit: int = 0
) -> list[dict]:
    """Customer chats whose inventory activity is newer than our last message pull.

    A chat is stale when it has never had messages pulled (no watermark) or when
    teams_chats.last_message_at has advanced past teams_chat_sync.messages_synced_at
    (i.e. new activity arrived since the last pull). This is the differential set —
    exactly the chats that need a message re-fetch. Most-recently-active first.
    """
    params: list = []
    join = ""
    if tpid:
        join = "JOIN active_teams_chat_customer_links l ON l.chat_id = c.chat_id"
    where_tpid = "AND l.tpid = ?" if tpid else ""
    if tpid:
        params.append(tpid)
    sql = f"""SELECT DISTINCT c.chat_id, c.topic, c.last_message_at,
                   s.messages_synced_at, c.messages_synced
            FROM active_teams_chats c
            {join}
            LEFT JOIN teams_chat_sync s ON s.chat_id = c.chat_id
            WHERE c.is_customer_related = 1
              AND c.last_message_at IS NOT NULL
              {where_tpid}
              AND (s.messages_synced_at IS NULL
                   OR c.last_message_at > s.messages_synced_at)
            ORDER BY c.last_message_at DESC"""
    if limit and limit > 0:
        sql += " LIMIT ?"
        params.append(int(limit))
    rows = con.execute(sql, params).fetchall()
    out = []
    for r in rows:
        out.append(
            {
                "chat_id": r["chat_id"],
                "topic": r["topic"],
                "last_message_at": r["last_message_at"],
                "synced_through": r["messages_synced_at"],
                "reason": "never_pulled" if r["messages_synced_at"] is None else "new_activity",
            }
        )
    return out
