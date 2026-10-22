"""Ingest full message bodies for customer chats into teams_chat_messages.

Message export files are written (by the fetch step) as JSON:
    {"chatId": "<chat_id>", "messages": [ ...ListChatMessages output... ]}
or the raw ListChatMessages tool object with an added top-level "chatId".
"""
from __future__ import annotations

import json
import re
import sqlite3
from pathlib import Path

from .ingest_chats import _extract_json_object

_TAG_RE = re.compile(r"<[^>]*>")
_WS_RE = re.compile(r"\s+")

# Defensive secret redaction — Teams messages occasionally contain pasted
# credentials (JWT/Bearer tokens, API keys, connection strings). Scrub them
# before they are persisted to the datastore (body_text and raw_json).
_SECRET_PATTERNS = [
    re.compile(r"\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}"),  # JWT
    re.compile(r"\bBearer\s+[A-Za-z0-9._~+/=-]{20,}", re.IGNORECASE),             # Bearer token
    re.compile(r"\b(?:gh[pousr]|github_pat)_[A-Za-z0-9_]{20,}"),                  # GitHub token
    re.compile(r"\bxox[baprs]-[A-Za-z0-9-]{10,}"),                                 # Slack token
    re.compile(r"\bAKIA[0-9A-Z]{16}\b"),                                          # AWS access key
    re.compile(r"AccountKey=[A-Za-z0-9+/=]{20,}"),                                # Azure storage key
    re.compile(r"-----BEGIN [A-Z ]*PRIVATE KEY-----"),                           # private key
]
_REDACTED = "[REDACTED-SECRET]"


def redact_secrets(value: str | None) -> str:
    s = str(value or "")
    for pat in _SECRET_PATTERNS:
        s = pat.sub(_REDACTED, s)
    return s


def strip_html(value: str | None) -> str:
    s = str(value or "")
    s = _TAG_RE.sub(" ", s)
    s = (
        s.replace("&nbsp;", " ")
        .replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&#39;", "'")
        .replace("&quot;", '"')
    )
    return redact_secrets(_WS_RE.sub(" ", s).strip())


def _project_message(m: dict) -> dict:
    body = m.get("body") or {}
    if isinstance(body, str):
        content, content_type = body, "text"
    else:
        content = body.get("content")
        content_type = body.get("contentType") or "text"
    frm = m.get("from") or m.get("sender") or {}
    user = (frm.get("user") if isinstance(frm, dict) else None) or {}
    app = (frm.get("application") if isinstance(frm, dict) else None) or {}
    sender_name = (
        m.get("senderDisplayName")
        or (frm.get("displayName") if isinstance(frm, dict) else None)
        or user.get("displayName")
        or app.get("displayName")
    )
    sender_id = user.get("id") or (frm.get("id") if isinstance(frm, dict) else None)
    return {
        "message_id": m.get("id"),
        "sender_name": sender_name,
        "sender_id": sender_id,
        "sent_at": m.get("createdDateTime") or m.get("sent_at"),
        "content_type": content_type,
        "body_text": strip_html(content),
        "raw": m,
    }


def load_export(path: str | Path) -> tuple[str | None, list[dict]]:
    obj = _extract_json_object(Path(path).read_text(encoding="utf-8"))
    chat_id = obj.get("chatId") or obj.get("chat_id")
    messages = obj.get("messages")
    if messages is None and isinstance(obj.get("value"), list):
        messages = obj["value"]
    if messages is None:
        messages = []
    return chat_id, messages


def upsert_messages(con: sqlite3.Connection, chat_id: str, messages: list[dict]) -> int:
    n = 0
    for raw in messages:
        m = _project_message(raw)
        if not m["message_id"]:
            continue
        # Skip system events and image/attachment-only posts (no readable text).
        if not (m["body_text"] or "").strip():
            continue
        con.execute(
            """INSERT INTO teams_chat_messages
                 (message_id, chat_id, sender_name, sender_id, sent_at,
                  content_type, body_text, raw_json, synced_at)
               VALUES (?,?,?,?,?,?,?,?, CURRENT_TIMESTAMP)
               ON CONFLICT(message_id) DO UPDATE SET
                 sender_name=excluded.sender_name,
                 sender_id=excluded.sender_id,
                 sent_at=excluded.sent_at,
                 content_type=excluded.content_type,
                 body_text=excluded.body_text,
                 raw_json=excluded.raw_json,
                 synced_at=CURRENT_TIMESTAMP""",
            (
                m["message_id"],
                chat_id,
                m["sender_name"],
                m["sender_id"],
                m["sent_at"],
                m["content_type"],
                m["body_text"],
                redact_secrets(json.dumps(m["raw"], ensure_ascii=False)),
            ),
        )
        n += 1
    con.execute(
        "UPDATE teams_chats SET messages_synced=1 WHERE chat_id=?", (chat_id,)
    )
    _advance_watermark(con, chat_id)
    con.commit()
    return n


def _advance_watermark(con: sqlite3.Connection, chat_id: str) -> None:
    """Set the differential watermark to the chat's latest known activity
    (max of inventory last_message_at and newest stored message)."""
    con.execute(
        """INSERT INTO teams_chat_sync (chat_id, messages_synced_at, last_pulled_at)
           VALUES (
             ?,
             (SELECT MAX(v) FROM (
                SELECT last_message_at AS v FROM active_teams_chats WHERE chat_id = ?
                UNION ALL
                SELECT MAX(sent_at) AS v FROM active_teams_chat_messages WHERE chat_id = ?
             )),
             CURRENT_TIMESTAMP
           )
           ON CONFLICT(chat_id) DO UPDATE SET
             messages_synced_at = excluded.messages_synced_at,
             last_pulled_at = CURRENT_TIMESTAMP""",
        (chat_id, chat_id, chat_id),
    )


def mark_pulled(con: sqlite3.Connection, chat_id: str) -> None:
    """Advance the watermark without storing messages — for chats that returned
    only system/attachment events. Stops them from churning in the differential."""
    _advance_watermark(con, chat_id)
    con.commit()


def ingest_dir(con: sqlite3.Connection, messages_dir: str | Path) -> dict:
    d = Path(messages_dir)
    if not d.exists():
        return {"files": 0, "messages": 0, "chats": 0}
    # Optional filename -> chatId map, for raw tool-output files that lack an inline chatId.
    name_map: dict[str, str] = {}
    map_path = d / "_map.json"
    if map_path.exists():
        try:
            name_map = json.loads(map_path.read_text(encoding="utf-8"))
        except (ValueError, OSError):
            name_map = {}
    files = [f for f in sorted(d.glob("*.json")) if f.name != "_map.json"]
    total_msgs = 0
    chats = 0
    for f in files:
        chat_id, messages = load_export(f)
        if not chat_id:
            chat_id = name_map.get(f.name)
        if not chat_id:
            continue
        total_msgs += upsert_messages(con, chat_id, messages)
        chats += 1
    return {"files": len(files), "messages": total_msgs, "chats": chats}
