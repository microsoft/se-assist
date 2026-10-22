"""Build a per-customer email profile from linked emails.

Aggregates participants, asks/questions, action items, links, and recent threads into
email_customer_profile (markdown + structured facts_json), parallel to the Teams profile.
"""
from __future__ import annotations

import json
import sqlite3
from collections import Counter
from datetime import datetime, timezone

from tools.teams import aliases as aliasmod
from tools.teams.build_profile import _ACTION_RE, _LINK_RE
from tools.common.roster import require_active_tpid


def _emails_for_tpid(con: sqlite3.Connection, tpid: str, limit: int = 80) -> list[dict]:
    rows = con.execute(
        """SELECT e.subject, e.from_name, e.from_address, e.received_at,
                  e.conversation_id, e.body_text
           FROM active_emails e
           JOIN active_email_customer_links l ON l.message_id = e.message_id
           WHERE l.tpid = ?
           ORDER BY (e.received_at IS NULL), e.received_at DESC
           LIMIT ?""",
        (tpid, limit),
    ).fetchall()
    return [dict(r) for r in rows]


def _extract_signals(emails: list[dict]) -> dict:
    actions, questions, links = [], [], []
    participants: Counter[str] = Counter()
    for e in emails:
        name = e.get("from_name")
        if name:
            participants[name] += 1
        body = (e.get("body_text") or "").strip()
        subject = (e.get("subject") or "").strip()
        blob = f"{subject}. {body}"
        for url in _LINK_RE.findall(body):
            links.append(url)
        snippet = (body or subject)[:220]
        if _ACTION_RE.search(blob):
            actions.append({"sender": name, "at": e.get("received_at"), "text": snippet})
        if "?" in blob:
            questions.append({"sender": name, "at": e.get("received_at"), "text": snippet})
    return {
        "participants": participants.most_common(15),
        "action_items": actions[:15],
        "open_questions": questions[:15],
        "links": list(dict.fromkeys(links))[:25],
    }


def build_profile(con: sqlite3.Connection, tpid: str) -> dict:
    require_active_tpid(con, tpid)
    display = aliasmod.display_name_for(tpid)
    emails = _emails_for_tpid(con, tpid, limit=120)
    signals = _extract_signals(emails)
    agg = con.execute(
        """SELECT COUNT(*) n,
                  COUNT(DISTINCT e.conversation_id) threads,
                  MAX(e.received_at) last_at
           FROM active_emails e
           JOIN active_email_customer_links l ON l.message_id = e.message_id
           WHERE l.tpid = ?""",
        (tpid,),
    ).fetchone()
    email_count = agg["n"] or 0
    thread_count = agg["threads"] or 0
    last_at = agg["last_at"]

    facts = {
        "tpid": tpid,
        "display_name": display,
        "email_count": email_count,
        "thread_count": thread_count,
        "last_activity": last_at,
        "participants": signals["participants"],
        "action_items": signals["action_items"],
        "open_questions": signals["open_questions"],
        "links": signals["links"],
    }
    markdown = _render_markdown(display, tpid, emails, signals, email_count, thread_count, last_at)

    con.execute(
        """INSERT INTO email_customer_profile
             (tpid, display_name, email_count, thread_count, last_activity_at,
              facts_json, profile_markdown, generated_at)
           VALUES (?,?,?,?,?,?,?, CURRENT_TIMESTAMP)
           ON CONFLICT(tpid) DO UPDATE SET
             display_name=excluded.display_name,
             email_count=excluded.email_count,
             thread_count=excluded.thread_count,
             last_activity_at=excluded.last_activity_at,
             facts_json=excluded.facts_json,
             profile_markdown=excluded.profile_markdown,
             generated_at=CURRENT_TIMESTAMP""",
        (
            tpid, display, email_count, thread_count, last_at,
            json.dumps(facts, ensure_ascii=False), markdown,
        ),
    )
    con.commit()
    return {"tpid": tpid, "display_name": display, "emails": email_count, "threads": thread_count}


def _render_markdown(display, tpid, emails, signals, email_count, thread_count, last_at) -> str:
    now = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC")
    lines = [
        f"# Email Profile — {display}",
        f"_TPID {tpid} · generated {now}_",
        "",
        f"- **Linked emails:** {email_count}",
        f"- **Threads:** {thread_count}",
        f"- **Last activity:** {last_at or 'n/a'}",
        "",
        "## Key correspondents",
    ]
    if signals["participants"]:
        for name, n in signals["participants"][:10]:
            lines.append(f"- {name} ({n} emails)")
    else:
        lines.append("- _No senders captured yet._")

    lines += ["", "## Recent subjects"]
    seen = set()
    shown = 0
    for e in emails:
        subj = (e.get("subject") or "(no subject)").strip()
        key = subj.lower().lstrip("re: ").lstrip("fw: ")
        if key in seen:
            continue
        seen.add(key)
        lines.append(f"- **{subj}** — {e.get('received_at') or 'n/a'} ({e.get('from_name') or '?'})")
        shown += 1
        if shown >= 20:
            break

    lines += ["", "## Open questions"]
    if signals["open_questions"]:
        for q in signals["open_questions"][:10]:
            lines.append(f"- _{q['sender'] or '?'}_: {q['text']}")
    else:
        lines.append("- _None detected._")

    lines += ["", "## Action items / follow-ups"]
    if signals["action_items"]:
        for a in signals["action_items"][:10]:
            lines.append(f"- _{a['sender'] or '?'}_: {a['text']}")
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
            "SELECT DISTINCT tpid FROM active_email_customer_links ORDER BY tpid"
        )
    ]
    return [build_profile(con, t) for t in tpids]
