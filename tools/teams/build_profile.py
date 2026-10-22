"""Build a comprehensive per-customer profile from linked chats and messages.

Aggregates chat topics, participants, recent message excerpts and simple signal
extraction (questions, action items, links) into teams_customer_profile — a markdown
brief plus structured facts_json for meeting preparation.
"""
from __future__ import annotations

import json
import re
import sqlite3
from collections import Counter
from datetime import datetime, timezone

from . import aliases as aliasmod
from . import report
from tools.common.roster import require_active_tpid

_ACTION_RE = re.compile(
    r"\b(action item|next step|follow up|follow-up|to do|todo|will send|i'll|we'll|"
    r"please|can you|need to|let's|deadline|due |by (mon|tue|wed|thu|fri|next))",
    re.IGNORECASE,
)
_LINK_RE = re.compile(r"https?://[^\s)>\]]+", re.IGNORECASE)


def _recent_messages(con: sqlite3.Connection, tpid: str, limit: int = 40) -> list[dict]:
    rows = con.execute(
        """SELECT m.sender_name, m.sent_at, m.body_text, c.topic
           FROM active_teams_chat_messages m
           JOIN active_teams_chat_customer_links l ON l.chat_id = m.chat_id
           JOIN active_teams_chats c ON c.chat_id = m.chat_id
           WHERE l.tpid=? AND m.body_text IS NOT NULL AND m.body_text != ''
           ORDER BY m.sent_at DESC
           LIMIT ?""",
        (tpid, limit),
    ).fetchall()
    return [dict(r) for r in rows]


def _extract_signals(messages: list[dict]) -> dict:
    actions, questions, links = [], [], []
    participants: Counter[str] = Counter()
    for m in messages:
        body = (m["body_text"] or "").strip()
        if not body:
            continue
        if m.get("sender_name"):
            participants[m["sender_name"]] += 1
        for url in _LINK_RE.findall(body):
            links.append(url)
        snippet = body[:220]
        if _ACTION_RE.search(body):
            actions.append({"sender": m.get("sender_name"), "at": m.get("sent_at"), "text": snippet})
        if "?" in body:
            questions.append({"sender": m.get("sender_name"), "at": m.get("sent_at"), "text": snippet})
    return {
        "participants": participants.most_common(15),
        "action_items": actions[:15],
        "open_questions": questions[:15],
        "links": list(dict.fromkeys(links))[:25],
    }


def build_profile(con: sqlite3.Connection, tpid: str) -> dict:
    require_active_tpid(con, tpid)
    display = aliasmod.display_name_for(tpid)
    chats = report.chats_for_customer(con, tpid)
    messages = _recent_messages(con, tpid, limit=60)
    signals = _extract_signals(messages)
    last_activity = chats[0]["last_message_at"] if chats else None
    msg_count = con.execute(
        """SELECT COUNT(*) n FROM active_teams_chat_messages m
           JOIN active_teams_chat_customer_links l ON l.chat_id = m.chat_id WHERE l.tpid=?""",
        (tpid,),
    ).fetchone()["n"]

    facts = {
        "tpid": tpid,
        "display_name": display,
        "chat_count": len(chats),
        "message_count": msg_count,
        "last_activity": last_activity,
        "participants": signals["participants"],
        "action_items": signals["action_items"],
        "open_questions": signals["open_questions"],
        "links": signals["links"],
    }
    markdown = _render_markdown(display, tpid, chats, signals, msg_count)

    con.execute(
        """INSERT INTO teams_customer_profile
             (tpid, display_name, chat_count, message_count, last_activity_at,
              facts_json, profile_markdown, generated_at)
           VALUES (?,?,?,?,?,?,?, CURRENT_TIMESTAMP)
           ON CONFLICT(tpid) DO UPDATE SET
             display_name=excluded.display_name,
             chat_count=excluded.chat_count,
             message_count=excluded.message_count,
             last_activity_at=excluded.last_activity_at,
             facts_json=excluded.facts_json,
             profile_markdown=excluded.profile_markdown,
             generated_at=CURRENT_TIMESTAMP""",
        (
            tpid,
            display,
            len(chats),
            msg_count,
            last_activity,
            json.dumps(facts, ensure_ascii=False),
            markdown,
        ),
    )
    con.commit()
    return {"tpid": tpid, "display_name": display, "chats": len(chats), "messages": msg_count}


def _render_markdown(display, tpid, chats, signals, msg_count) -> str:
    now = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC")
    lines = [
        f"# Customer Profile — {display}",
        f"_TPID {tpid} · generated {now}_",
        "",
        f"- **Linked chats:** {len(chats)}",
        f"- **Messages analyzed:** {msg_count}",
        f"- **Last activity:** {chats[0]['last_message_at'] if chats else 'n/a'}",
        "",
        "## Key participants",
    ]
    if signals["participants"]:
        for name, n in signals["participants"][:10]:
            lines.append(f"- {name} ({n} msgs)")
    else:
        lines.append("- _No message bodies ingested yet._")

    lines += ["", "## Linked chats"]
    for c in chats[:30]:
        unread = " 🔴" if c.get("has_unread") else ""
        topic = c.get("topic") or "(unnamed)"
        lines.append(f"- **{topic}**{unread} — last {c.get('last_message_at') or 'n/a'} ({c.get('chat_type')})")

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
            "SELECT DISTINCT tpid FROM active_teams_chat_customer_links ORDER BY tpid"
        )
    ]
    return [build_profile(con, t) for t in tpids]
