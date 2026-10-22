"""Ingest calendar events into the `meetings` table.

Export files (written by the pull/stage step) are JSON. Accepted shapes:
  - {"searchTpid": "<tpid>", "raw": <WorkIQ response>}   (stage-raw wrapper)
  - a raw WorkIQ fetch response: {"results": [{"data": {"value": [ ... ]}}]}
  - {"value": [ ... ]} or {"meetings": [ ... ]} or a bare list of events

Bodies (agendas) are HTML-stripped, the Microsoft Teams join boilerplate is removed,
and the text is run through the shared secret-redaction patterns before persisting.
"""
from __future__ import annotations

import json
import re
from pathlib import Path

# Reuse the Teams redaction + HTML stripping (single source of truth).
from tools.teams.ingest_messages import redact_secrets, strip_html

_WS_RE = re.compile(r"\s+")

# The Teams meeting "join" block is pure boilerplate (join links, dial-in numbers,
# conference IDs, legal footers). Cut the body at the first such marker so only the
# human-written agenda survives.
_BOILERPLATE_MARKERS = [
    re.compile(r"_{10,}"),                                              # Outlook divider line
    re.compile(r"Microsoft Teams\s+meeting", re.IGNORECASE),
    re.compile(r"Microsoft Teams\s+Need help\?", re.IGNORECASE),
    re.compile(r"Join\s+on\s+your\s+computer", re.IGNORECASE),
    re.compile(r"Join\s+the\s+meeting\s+now", re.IGNORECASE),
    re.compile(r"Meeting\s+ID:\s*\d", re.IGNORECASE),
    re.compile(r"Dial\s+in\s+by\s+phone", re.IGNORECASE),
    re.compile(r"\bJoin\s+with\s+a\s+video\s+conferencing\s+device", re.IGNORECASE),
    re.compile(r"________________________________________"),
]


def clean_meeting_body(content: str | None, content_type: str | None) -> str:
    """Strip HTML, cut the Teams join boilerplate, redact secrets, collapse whitespace."""
    raw = str(content or "")
    if (content_type or "").lower() == "html" or ("<" in raw and ">" in raw):
        text = strip_html(raw)  # also redacts + collapses whitespace
    else:
        text = redact_secrets(raw)
    cut = len(text)
    for pat in _BOILERPLATE_MARKERS:
        m = pat.search(text)
        if m and m.start() < cut:
            cut = m.start()
    text = text[:cut]
    return _WS_RE.sub(" ", text).strip()


def _addr(obj: dict | None) -> tuple[str | None, str | None]:
    ea = ((obj or {}).get("emailAddress")) or {}
    return ea.get("name"), ea.get("address")


def _graph_dt(slot: object) -> str | None:
    """Normalize a Graph date/time slot ({dateTime, timeZone}) to an ISO-8601 string.

    Graph returns `dateTime` as a naive wall-clock string with no timezone designator
    plus a separate `timeZone` field (UTC by default, since we don't send a
    `Prefer: outlook.timezone` header). We append 'Z' when the zone is UTC so the
    stored value is unambiguous and consumers render it in local time correctly.
    Non-UTC zones (rare here) are stored as-is to avoid a lossy conversion.
    """
    if not isinstance(slot, dict):
        return None
    dt = slot.get("dateTime")
    if not dt:
        return None
    dt = str(dt)
    tz = str(slot.get("timeZone") or "").strip().lower()
    has_zone = dt.endswith(("Z", "z")) or bool(re.search(r"[+-]\d{2}:?\d{2}$", dt))
    if tz == "utc" and not has_zone:
        return dt + "Z"
    return dt


def _project_event(m: dict) -> dict:
    body = m.get("body") or {}
    if isinstance(body, dict):
        content, ctype = body.get("content"), body.get("contentType")
    else:
        content, ctype = body, "text"
    body_text = clean_meeting_body(content, ctype)
    body_source = "body"
    if not body_text:
        body_text = redact_secrets(_WS_RE.sub(" ", str(m.get("bodyPreview") or "")).strip())
        body_source = "preview"

    org_name, org_addr = _addr(m.get("organizer"))
    attendees = []
    for a in (m.get("attendees") or []):
        n, addr = _addr(a)
        attendees.append({
            "name": n,
            "address": addr,
            "type": a.get("type"),
            "response": ((a.get("status") or {}).get("response")),
        })

    online = m.get("onlineMeeting") or {}
    loc = (m.get("location") or {}).get("displayName") if isinstance(m.get("location"), dict) else m.get("location")
    return {
        "event_id": m.get("id"),
        "ical_uid": m.get("iCalUId"),
        "series_master_id": m.get("seriesMasterId"),
        "subject": redact_secrets(str(m.get("subject") or "").strip()),
        "organizer_name": org_name,
        "organizer_address": org_addr,
        "attendees_json": json.dumps(attendees, ensure_ascii=False),
        "start_at": _graph_dt(m.get("start")),
        "end_at": _graph_dt(m.get("end")),
        "is_online_meeting": 1 if m.get("isOnlineMeeting") else 0,
        "online_meeting_url": online.get("joinUrl") or m.get("onlineMeetingUrl") or "",
        "location": redact_secrets(str(loc or "").strip()) or None,
        "body_text": body_text,
        "body_source": body_source,
        "body_preview": redact_secrets(_WS_RE.sub(" ", str(m.get("bodyPreview") or "")).strip())[:512],
        "importance": m.get("importance"),
        "sensitivity": m.get("sensitivity"),
        "is_cancelled": 1 if m.get("isCancelled") else 0,
        "web_link": m.get("webLink"),
        "raw": m,
    }


def _walk_events(obj) -> list[dict]:
    """Extract event dicts from any accepted export shape."""
    if isinstance(obj, list):
        return [m for m in obj if isinstance(m, dict) and m.get("id")]
    if not isinstance(obj, dict):
        return []
    for key in ("meetings", "events", "value"):
        if isinstance(obj.get(key), list):
            return [m for m in obj[key] if isinstance(m, dict) and m.get("id")]
    out: list[dict] = []
    # raw WorkIQ: {"results":[{"data":{"value":[...]}}]}
    for res in obj.get("results", []) or []:
        data = (res or {}).get("data") or {}
        for m in data.get("value", []) or []:
            if isinstance(m, dict) and m.get("id"):
                out.append(m)
    return out


def load_export(path: str | Path) -> tuple[str | None, list[dict]]:
    obj = json.loads(Path(path).read_text(encoding="utf-8"))
    search_tpid = obj.get("searchTpid") if isinstance(obj, dict) else None
    inner = obj.get("raw") if isinstance(obj, dict) and "raw" in obj else obj
    return search_tpid, _walk_events(inner)


def upsert_meetings(con, events: list[dict]) -> int:
    n = 0
    for raw in events:
        e = _project_event(raw)
        if not e["event_id"]:
            continue
        con.execute(
            """INSERT INTO meetings
                 (event_id, ical_uid, series_master_id, subject, organizer_name,
                  organizer_address, attendees_json, start_at, end_at, is_online_meeting,
                  online_meeting_url, location, body_text, body_source, body_preview,
                  importance, sensitivity, is_cancelled, web_link, raw_json, synced_at)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?, CURRENT_TIMESTAMP)
               ON CONFLICT(event_id) DO UPDATE SET
                 ical_uid=excluded.ical_uid,
                 series_master_id=excluded.series_master_id,
                 subject=excluded.subject,
                 organizer_name=excluded.organizer_name,
                 organizer_address=excluded.organizer_address,
                 attendees_json=excluded.attendees_json,
                 start_at=excluded.start_at,
                 end_at=excluded.end_at,
                 is_online_meeting=excluded.is_online_meeting,
                 online_meeting_url=excluded.online_meeting_url,
                 location=excluded.location,
                 -- Never overwrite a non-empty body with an empty one.
                 body_text=CASE WHEN excluded.body_text IS NULL OR excluded.body_text=''
                                THEN meetings.body_text ELSE excluded.body_text END,
                 body_source=CASE WHEN excluded.body_text IS NULL OR excluded.body_text=''
                                  THEN meetings.body_source ELSE excluded.body_source END,
                 body_preview=excluded.body_preview,
                 importance=excluded.importance,
                 sensitivity=excluded.sensitivity,
                 is_cancelled=excluded.is_cancelled,
                 web_link=excluded.web_link,
                 raw_json=CASE WHEN LENGTH(COALESCE(excluded.raw_json,'')) >= LENGTH(COALESCE(meetings.raw_json,''))
                               THEN excluded.raw_json ELSE meetings.raw_json END,
                 synced_at=CURRENT_TIMESTAMP""",
            (
                e["event_id"], e["ical_uid"], e["series_master_id"], e["subject"],
                e["organizer_name"], e["organizer_address"], e["attendees_json"],
                e["start_at"], e["end_at"], e["is_online_meeting"],
                e["online_meeting_url"], e["location"], e["body_text"],
                e["body_source"], e["body_preview"], e["importance"],
                e["sensitivity"], e["is_cancelled"], e["web_link"],
                redact_secrets(json.dumps(e["raw"], ensure_ascii=False)),
            ),
        )
        n += 1
    con.commit()
    return n


def ingest_dir(con, messages_dir: str | Path) -> dict:
    d = Path(messages_dir)
    if not d.exists():
        return {"files": 0, "meetings": 0}
    files = [f for f in sorted(d.glob("*.json")) if f.name != "_map.json"]
    total = 0
    for f in files:
        _tpid, events = load_export(f)
        total += upsert_meetings(con, events)
    return {"files": len(files), "meetings": total}
