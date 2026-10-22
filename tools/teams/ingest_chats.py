"""Ingest chat inventory exports (microsoft-teams-ListChats output) into teams_chats."""
from __future__ import annotations

import json
import re
import sqlite3
from pathlib import Path


def _extract_json_object(text: str) -> dict:
    """Parse a tool-output file that may have a trailing 'CorrelationId: ...' note."""
    text = text.strip()
    # Trim any trailing non-JSON note the MCP tool appends after the closing brace.
    depth = 0
    end = None
    in_str = False
    esc = False
    start = text.find("{")
    if start == -1:
        raise ValueError("No JSON object found in export")
    for i in range(start, len(text)):
        ch = text[i]
        if in_str:
            if esc:
                esc = False
            elif ch == "\\":
                esc = True
            elif ch == '"':
                in_str = False
            continue
        if ch == '"':
            in_str = True
        elif ch == "{":
            depth += 1
        elif ch == "}":
            depth -= 1
            if depth == 0:
                end = i + 1
                break
    if end is None:
        raise ValueError("Unbalanced JSON object in export")
    return json.loads(text[start:end])


def load_chats_export(path: str | Path) -> list[dict]:
    data = _extract_json_object(Path(path).read_text(encoding="utf-8"))
    if isinstance(data, list):
        return data
    # Two producers feed this: the ListChats MCP tool emits {"chats":[...]}, while the
    # in-app WorkIQ ingestion (desktop/services/m365-ingest.js) fetches /me/chats and
    # writes {"value":[...]}. Accept both so neither path silently ingests nothing.
    chats = data.get("chats")
    if chats is None:
        chats = data.get("value")
    return chats or []


def classify_type(chat_id: str, topic: str | None, chat_type: str | None = None) -> str:
    # Trust the Graph-provided chatType when present (oneOnOne/group/meeting); fall
    # back to inferring from the chat id / topic for exports that omit it.
    if chat_type in ("oneOnOne", "group", "meeting"):
        return chat_type
    if "meeting_" in chat_id:
        return "meeting"
    if "@unq.gbl.spaces" in chat_id:
        return "oneOnOne"
    if topic:
        return "group"
    return "unnamed"


def upsert_chats(con: sqlite3.Connection, chats: list[dict]) -> dict[str, int]:
    inserted = 0
    updated = 0
    for c in chats:
        chat_id = c.get("id")
        if not chat_id:
            continue
        topic = c.get("topic") or None
        lm = c.get("lastMessagePreview") or {}
        chat_type = classify_type(chat_id, topic, c.get("chatType"))
        exists = con.execute(
            "SELECT 1 FROM active_teams_chats WHERE chat_id=?", (chat_id,)
        ).fetchone()
        # /me/chats (in-app pull) does not expand lastMessagePreview, but it does
        # select lastUpdatedDateTime — use it as the activity timestamp so these
        # chats sort correctly and are eligible for the message-body pull manifest
        # (which requires a non-null last_message_at).
        last_at = lm.get("createdDateTime") or c.get("lastUpdatedDateTime")
        con.execute(
            """INSERT INTO teams_chats
                 (chat_id, topic, chat_type, has_unread, last_message_at,
                  last_message_from, last_message_preview, raw_json, synced_at)
               VALUES (?,?,?,?,?,?,?,?, CURRENT_TIMESTAMP)
               ON CONFLICT(chat_id) DO UPDATE SET
                 topic=excluded.topic,
                 chat_type=excluded.chat_type,
                 has_unread=excluded.has_unread,
                 last_message_at=excluded.last_message_at,
                 last_message_from=excluded.last_message_from,
                 last_message_preview=excluded.last_message_preview,
                 raw_json=excluded.raw_json,
                 synced_at=CURRENT_TIMESTAMP""",
            (
                chat_id,
                topic,
                chat_type,
                1 if c.get("hasUnreadMessages") else 0,
                last_at,
                lm.get("from") or None,
                (lm.get("body") or None),
                json.dumps(c, ensure_ascii=False),
            ),
        )
        if exists:
            updated += 1
        else:
            inserted += 1
    con.commit()
    total = con.execute("SELECT COUNT(*) n FROM active_teams_chats").fetchone()["n"]
    return {"inserted": inserted, "updated": updated, "total": total}


def ingest_dir(con: sqlite3.Connection, exports_dir: str | Path) -> dict[str, int]:
    """Ingest every chat-inventory export in a directory.

    Matches both producers: legacy ``chats*.json`` (ListChats MCP output) and the
    in-app WorkIQ pull's ``inventory*.json`` (from /me/chats). Without the second
    pattern the in-app ingestion silently loaded zero chats.
    """
    d = Path(exports_dir)
    files = sorted(set(d.glob("chats*.json")) | set(d.glob("inventory*.json")))
    agg = {"inserted": 0, "updated": 0, "total": 0, "files": 0}
    for f in files:
        res = upsert_chats(con, load_chats_export(f))
        agg["inserted"] += res["inserted"]
        agg["updated"] += res["updated"]
        agg["total"] = res["total"]
        agg["files"] += 1
    return agg
