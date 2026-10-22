"""Ingest customer email messages into the `emails` table.

Export files (written by the pull/stage step) are JSON. Accepted shapes:
  - {"searchTpid": "<tpid>", "messages": [ <graph message> ... ]}
  - a raw WorkIQ fetch response: {"results": [{"data": {"value": [ ... ]}}]}
  - {"value": [ ... ]} or a bare list of messages

Bodies are cleaned (HTML stripped, quoted reply chains + signatures removed) and run
through the shared secret-redaction patterns before being persisted.
"""
from __future__ import annotations

import json
import re
from pathlib import Path

# Reuse the Teams redaction + HTML stripping (single source of truth).
from tools.teams.ingest_messages import redact_secrets, strip_html

# Markers that begin a quoted reply chain / signature — cut the body at the first hit.
_REPLY_MARKERS = [
    re.compile(r"\n-----\s*Original Message\s*-----", re.IGNORECASE),
    re.compile(r"\n_{10,}"),                                  # Outlook divider line
    re.compile(r"\nFrom:\s.+?\nSent:\s", re.IGNORECASE | re.DOTALL),
    re.compile(r"\nOn\s.{0,120}?\swrote:", re.IGNORECASE | re.DOTALL),
    re.compile(r"\nSent from my \w+", re.IGNORECASE),
    re.compile(r"\nGet Outlook for \w+", re.IGNORECASE),
]
_WS_RE = re.compile(r"\s+")


def clean_email_body(content: str | None, content_type: str | None) -> str:
    """Strip HTML (if needed), cut quoted reply chains/signatures, redact, collapse."""
    raw = str(content or "")
    if (content_type or "").lower() == "html" or "<" in raw and ">" in raw:
        # strip_html also redacts + collapses whitespace; re-expand newlines first so
        # the reply-marker cut below can still see structure.
        text = strip_html(raw)
    else:
        text = redact_secrets(raw)
    # Cut at the earliest reply/signature marker.
    cut = len(text)
    for pat in _REPLY_MARKERS:
        m = pat.search(text)
        if m and m.start() < cut:
            cut = m.start()
    text = text[:cut]
    return _WS_RE.sub(" ", text).strip()


def _addr(obj: dict | None) -> tuple[str | None, str | None]:
    ea = ((obj or {}).get("emailAddress")) or {}
    return ea.get("name"), ea.get("address")


def _project_email(m: dict) -> dict:
    body = m.get("body") or {}
    if isinstance(body, dict):
        content, ctype = body.get("content"), body.get("contentType")
    else:
        content, ctype = body, "text"
    body_text = clean_email_body(content, ctype)
    body_source = "body"
    if not body_text:
        # Fall back to the short preview when the full body is absent/empty.
        body_text = redact_secrets(_WS_RE.sub(" ", str(m.get("bodyPreview") or "")).strip())
        body_source = "preview"
    from_name, from_addr = _addr(m.get("from") or m.get("sender"))
    to = [
        {"name": n, "address": a}
        for n, a in (_addr(r) for r in (m.get("toRecipients") or []))
    ]
    cc = [
        {"name": n, "address": a}
        for n, a in (_addr(r) for r in (m.get("ccRecipients") or []))
    ]
    return {
        "message_id": m.get("id"),
        "conversation_id": m.get("conversationId"),
        "internet_message_id": m.get("internetMessageId"),
        "subject": redact_secrets(str(m.get("subject") or "").strip()),
        "from_name": from_name,
        "from_address": from_addr,
        "to_json": json.dumps(to, ensure_ascii=False),
        "cc_json": json.dumps(cc, ensure_ascii=False),
        "sent_at": m.get("sentDateTime"),
        "received_at": m.get("receivedDateTime") or m.get("sentDateTime"),
        "body_text": body_text,
        "body_source": body_source,
        "has_attachments": 1 if m.get("hasAttachments") else 0,
        "importance": m.get("importance"),
        "web_link": m.get("webLink"),
        "raw": m,
    }


def _walk_messages(obj) -> list[dict]:
    """Extract message dicts from any accepted export shape."""
    if isinstance(obj, list):
        return [m for m in obj if isinstance(m, dict) and m.get("id")]
    if not isinstance(obj, dict):
        return []
    if isinstance(obj.get("messages"), list):
        return [m for m in obj["messages"] if isinstance(m, dict) and m.get("id")]
    out: list[dict] = []
    # raw WorkIQ: {"results":[{"data":{"value":[...]}}]}
    for res in obj.get("results", []) or []:
        data = (res or {}).get("data") or {}
        for m in data.get("value", []) or []:
            if isinstance(m, dict) and m.get("id"):
                out.append(m)
    # plain Graph collection
    if not out and isinstance(obj.get("value"), list):
        out = [m for m in obj["value"] if isinstance(m, dict) and m.get("id")]
    return out


def load_export(path: str | Path) -> tuple[str | None, list[dict]]:
    obj = json.loads(Path(path).read_text(encoding="utf-8"))
    search_tpid = obj.get("searchTpid") if isinstance(obj, dict) else None
    # stage-raw wraps the raw WorkIQ output under "raw"; unwrap it for message extraction.
    inner = obj.get("raw") if isinstance(obj, dict) and "raw" in obj else obj
    return search_tpid, _walk_messages(inner)


def upsert_emails(con, messages: list[dict]) -> int:
    n = 0
    for raw in messages:
        e = _project_email(raw)
        if not e["message_id"]:
            continue
        con.execute(
            """INSERT INTO emails
                 (message_id, conversation_id, internet_message_id, subject,
                  from_name, from_address, to_json, cc_json, sent_at, received_at,
                  folder, body_text, body_source, has_attachments, importance,
                  web_link, raw_json, synced_at)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?, CURRENT_TIMESTAMP)
               ON CONFLICT(message_id) DO UPDATE SET
                 conversation_id=excluded.conversation_id,
                 subject=excluded.subject,
                 from_name=excluded.from_name,
                 from_address=excluded.from_address,
                 to_json=excluded.to_json,
                 cc_json=excluded.cc_json,
                 sent_at=excluded.sent_at,
                 received_at=excluded.received_at,
                 -- Never overwrite a non-empty body with an empty one (e.g. a full-body
                 -- pull whose body cleaned to empty and lacked a preview fallback).
                 body_text=CASE WHEN excluded.body_text IS NULL OR excluded.body_text=''
                                THEN emails.body_text ELSE excluded.body_text END,
                 body_source=CASE WHEN excluded.body_text IS NULL OR excluded.body_text=''
                                  THEN emails.body_source ELSE excluded.body_source END,
                 has_attachments=excluded.has_attachments,
                 importance=excluded.importance,
                 web_link=excluded.web_link,
                 -- Keep the richer raw_json (the linker matches the full body from it);
                 -- never replace a longer payload with a shorter one (e.g. re-ingesting
                 -- a preview-only export over a previously pulled full body).
                 raw_json=CASE WHEN LENGTH(COALESCE(excluded.raw_json,'')) >= LENGTH(COALESCE(emails.raw_json,''))
                               THEN excluded.raw_json ELSE emails.raw_json END,
                 synced_at=CURRENT_TIMESTAMP""",
            (
                e["message_id"], e["conversation_id"], e["internet_message_id"],
                e["subject"], e["from_name"], e["from_address"], e["to_json"],
                e["cc_json"], e["sent_at"], e["received_at"], None,
                e["body_text"], e["body_source"], e["has_attachments"],
                e["importance"], e["web_link"],
                redact_secrets(json.dumps(e["raw"], ensure_ascii=False)),
            ),
        )
        n += 1
    con.commit()
    return n


def ingest_dir(con, messages_dir: str | Path) -> dict:
    d = Path(messages_dir)
    if not d.exists():
        return {"files": 0, "emails": 0}
    files = [f for f in sorted(d.glob("*.json")) if f.name != "_map.json"]
    total = 0
    for f in files:
        _tpid, messages = load_export(f)
        if _tpid and not con.execute("SELECT 1 FROM tpid_config WHERE tpid=?", (str(_tpid),)).fetchone():
            continue
        total += upsert_emails(con, messages)
    return {"files": len(files), "emails": total}
