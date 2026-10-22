"""Build a per-customer meeting profile from linked meetings.

Aggregates organizers/attendees, recent meeting subjects, agendas, action items, and
links into meeting_customer_profile (markdown + structured facts_json), parallel to the
email profile.
"""
from __future__ import annotations

import json
import sqlite3
from collections import Counter
from datetime import datetime, timezone

from tools.teams import aliases as aliasmod
from tools.teams.build_profile import _ACTION_RE, _LINK_RE
from tools.common.roster import require_active_tpid


def _meetings_for_tpid(con: sqlite3.Connection, tpid: str, limit: int = 80) -> list[dict]:
    rows = con.execute(
        """SELECT m.subject, m.organizer_name, m.organizer_address, m.start_at,
                  m.attendees_json, m.body_text, m.is_online_meeting, m.location
           FROM active_meetings m
           JOIN active_meeting_customer_links l ON l.event_id = m.event_id
           WHERE l.tpid = ?
           ORDER BY (m.start_at IS NULL), m.start_at DESC
           LIMIT ?""",
        (tpid, limit),
    ).fetchall()
    return [dict(r) for r in rows]


def _extract_signals(meetings: list[dict]) -> dict:
    actions, links = [], []
    organizers: Counter[str] = Counter()
    attendees: Counter[str] = Counter()
    for m in meetings:
        org = m.get("organizer_name")
        if org:
            organizers[org] += 1
        try:
            for a in json.loads(m.get("attendees_json") or "[]"):
                name = a.get("name") or a.get("address")
                if name:
                    attendees[name] += 1
        except (ValueError, TypeError):
            pass
        body = (m.get("body_text") or "").strip()
        subject = (m.get("subject") or "").strip()
        blob = f"{subject}. {body}"
        for url in _LINK_RE.findall(body):
            links.append(url)
        snippet = (body or subject)[:220]
        if _ACTION_RE.search(blob):
            actions.append({"organizer": org, "at": m.get("start_at"), "text": snippet})
    return {
        "organizers": organizers.most_common(15),
        "attendees": attendees.most_common(20),
        "action_items": actions[:15],
        "links": list(dict.fromkeys(links))[:25],
    }


def build_profile(con: sqlite3.Connection, tpid: str) -> dict:
    require_active_tpid(con, tpid)
    display = aliasmod.display_name_for(tpid)
    meetings = _meetings_for_tpid(con, tpid, limit=120)
    signals = _extract_signals(meetings)
    agg = con.execute(
        """SELECT COUNT(*) n, MAX(m.start_at) last_at
           FROM active_meetings m
           JOIN active_meeting_customer_links l ON l.event_id = m.event_id
           WHERE l.tpid = ?""",
        (tpid,),
    ).fetchone()
    meeting_count = agg["n"] or 0
    last_at = agg["last_at"]

    facts = {
        "tpid": tpid,
        "display_name": display,
        "meeting_count": meeting_count,
        "last_activity": last_at,
        "organizers": signals["organizers"],
        "attendees": signals["attendees"],
        "action_items": signals["action_items"],
        "links": signals["links"],
    }
    markdown = _render_markdown(display, tpid, meetings, signals, meeting_count, last_at)

    con.execute(
        """INSERT INTO meeting_customer_profile
             (tpid, display_name, meeting_count, last_activity_at,
              facts_json, profile_markdown, generated_at)
           VALUES (?,?,?,?,?,?, CURRENT_TIMESTAMP)
           ON CONFLICT(tpid) DO UPDATE SET
             display_name=excluded.display_name,
             meeting_count=excluded.meeting_count,
             last_activity_at=excluded.last_activity_at,
             facts_json=excluded.facts_json,
             profile_markdown=excluded.profile_markdown,
             generated_at=CURRENT_TIMESTAMP""",
        (
            tpid, display, meeting_count, last_at,
            json.dumps(facts, ensure_ascii=False), markdown,
        ),
    )
    con.commit()
    return {"tpid": tpid, "display_name": display, "meetings": meeting_count}


def _render_markdown(display, tpid, meetings, signals, meeting_count, last_at) -> str:
    now = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC")
    lines = [
        f"# Meeting Profile — {display}",
        f"_TPID {tpid} · generated {now}_",
        "",
        f"- **Linked meetings:** {meeting_count}",
        f"- **Last meeting:** {last_at or 'n/a'}",
        "",
        "## Frequent organizers",
    ]
    if signals["organizers"]:
        for name, n in signals["organizers"][:10]:
            lines.append(f"- {name} ({n} meetings)")
    else:
        lines.append("- _No organizers captured yet._")

    lines += ["", "## Recent meetings"]
    seen = set()
    shown = 0
    for m in meetings:
        subj = (m.get("subject") or "(no subject)").strip()
        key = subj.lower()
        if key in seen:
            continue
        seen.add(key)
        when = (m.get("start_at") or "n/a")[:16]
        lines.append(f"- **{subj}** — {when} (organizer: {m.get('organizer_name') or '?'})")
        shown += 1
        if shown >= 20:
            break

    lines += ["", "## Action items / follow-ups"]
    if signals["action_items"]:
        for a in signals["action_items"][:10]:
            lines.append(f"- _{a['organizer'] or '?'}_: {a['text']}")
    else:
        lines.append("- _None detected._")

    if signals["links"]:
        lines += ["", "## Shared links"]
        for url in signals["links"][:15]:
            lines.append(f"- {url}")

    return "\n".join(lines)


def build_all(con: sqlite3.Connection) -> list[dict]:
    tpids = [
        str(r["tpid"])
        for r in con.execute(
            "SELECT DISTINCT tpid FROM active_meeting_customer_links ORDER BY tpid"
        )
    ]
    return [build_profile(con, t) for t in tpids]
