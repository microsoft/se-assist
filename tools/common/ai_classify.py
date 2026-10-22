"""AI classifier for weak customer links (feature E).

The deterministic linkers (identity, curated/auto aliases, learned domains) are
high-precision. What remains are *weak* links — an AI-guessed short alias hit, a
thread/series propagation, or a mailbox-search-only surface — where the customer's
name matched but nothing authoritative corroborates it. Those are exactly the links
most likely to be false positives (e.g. a common word matching a chat that has
nothing to do with the customer company).

This module adjudicates that residual weak set with a fast AI model — **Claude Haiku
4.5** via the connected GitHub Copilot API. Copilot is the ONLY model; there is no
`gh models` / gpt-4o-mini fallback. It is:

  * Gated — only weak-tier links are considered, and only up to ``cap`` per run, so a
    Backfill can't fan out into thousands of model calls.
  * Cached — every verdict is stored in ``ai_link_verifications`` keyed by a hash of
    the context sent to the model, so repeated runs are free and deterministic.
  * Best-effort — if Copilot isn't wired or it errors, nothing changes; weak links
    are simply left as-is (never raises) and the summary flags it (``model_available``
    / ``ai_error``) so the desktop app can surface a degraded notice.

Outcomes:
  * confirmed  -> the link is promoted to ``ai-verified`` (tier 'medium', conf 0.80),
                  and — when the weak match was an AI-guessed alias — that alias's
                  confirmed-success counter is incremented. Once an AI alias reaches
                  ``PROMOTE_THRESHOLD`` successes it is promoted so its *future* matches
                  start at 'medium' instead of 'weak'.
  * rejected   -> the link is marked ``ai-rejected`` (tier 'weak', conf 0.10) and
                  excluded from the item's is_customer_related flag (fails loudly and
                  visibly rather than silently mis-filing the item).
"""
from __future__ import annotations

import hashlib
import json
import os
import sqlite3

from tools.teams import aliases as aliasmod
from tools.common import linking as linkingmod
from tools.common import fast_ai

# Label for the fast model. The actual model is resolved from the Copilot env (see
# fast_ai.fast_model_label); Copilot is the only model — no gh-models fallback.
DEFAULT_MODEL = "claude-haiku-4.5"
DEFAULT_CAP = 150

# As with alias generation, one transient classifier failure must not abandon the whole
# medium's weak-link review. We skip the failing item (it stays unadjudicated and is
# retried next run) and continue, giving up only after several consecutive failures.
_MAX_CONSECUTIVE_FAILURES = 3


def _resolve_cap(cap: int | None) -> int:
    """Effective per-run cap: explicit arg wins, else SEASSIST_WEAK_CAP, else default.
    Lets the ingest orchestrator keep incremental ('pull new items') runs light while
    backfill does the heavier pass."""
    if cap is not None:
        return cap
    try:
        env = os.environ.get("SEASSIST_WEAK_CAP")
        if env:
            return max(0, int(env))
    except (TypeError, ValueError):
        pass
    return DEFAULT_CAP

_SYSTEM_PROMPT = (
    "You decide whether a single business item (an email, meeting, or chat) is about "
    "a specific customer company. Judge from the participants' email domains and the "
    "text. A passing mention of an unrelated word that merely looks like the company "
    "name is NOT a match. Answer ONLY with compact JSON: "
    '{"related": true|false, "confidence": 0.0-1.0}.'
)

# Per-kind wiring: (link table, id column, item table).
_KIND = {
    "email": ("email_customer_links", "message_id", "emails"),
    "meeting": ("meeting_customer_links", "event_id", "meetings"),
    "chat": ("teams_chat_customer_links", "chat_id", "teams_chats"),
}


# ── Context extraction ──────────────────────────────────────────────────────────────

def _domains(addrs) -> list[str]:
    out = []
    for a in addrs:
        a = (a or "").strip().lower()
        if "@" in a:
            out.append(a.rsplit("@", 1)[-1])
    return sorted(set(out))


def _item_context(con: sqlite3.Connection, kind: str, item_id: str) -> tuple[str, list[str]] | None:
    """Return (text, participant_domains) for one item, or None if it's gone."""
    if kind == "email":
        r = con.execute(
            "SELECT subject, from_address, to_json, cc_json, body_text FROM active_emails "
            "WHERE message_id=?", (item_id,)
        ).fetchone()
        if not r:
            return None
        addrs = [r["from_address"]]
        for fld in ("to_json", "cc_json"):
            try:
                for p in json.loads(r[fld] or "[]"):
                    addrs.append(p.get("address"))
            except (ValueError, TypeError):
                pass
        text = f"Subject: {r['subject'] or ''}\n{(r['body_text'] or '')[:600]}"
        return text, _domains(addrs)
    if kind == "meeting":
        r = con.execute(
            "SELECT subject, organizer_address, attendees_json, body_text FROM active_meetings "
            "WHERE event_id=?", (item_id,)
        ).fetchone()
        if not r:
            return None
        addrs = [r["organizer_address"]]
        try:
            for a in json.loads(r["attendees_json"] or "[]"):
                addrs.append(a.get("address"))
        except (ValueError, TypeError):
            pass
        text = f"Meeting: {r['subject'] or ''}\n{(r['body_text'] or '')[:600]}"
        return text, _domains(addrs)
    if kind == "chat":
        r = con.execute(
            "SELECT topic, last_message_preview, raw_json FROM active_teams_chats WHERE chat_id=?",
            (item_id,)
        ).fetchone()
        if not r:
            return None
        addrs = []
        try:
            obj = json.loads(r["raw_json"] or "{}")
            for m in (obj.get("members") or []):
                if isinstance(m, dict):
                    addrs.append(m.get("email") or m.get("userPrincipalName"))
        except (ValueError, TypeError):
            pass
        text = f"Chat topic: {r['topic'] or '(none)'}\n{r['last_message_preview'] or ''}"
        return text, _domains(addrs)
    raise ValueError(f"unknown kind: {kind}")


def _customer_context(con, tpid: str) -> tuple[str, list[str]]:
    """(display_name, aliases) for the candidate account."""
    name = aliasmod.display_name_for(tpid)
    if name.startswith("TPID "):
        row = con.execute(
            "SELECT name FROM active_customers WHERE tpid=? AND name IS NOT NULL LIMIT 1", (tpid,)
        ).fetchone()
        if row and row["name"]:
            name = row["name"]
    aliases = [
        r["alias"] for r in con.execute(
            "SELECT alias FROM teams_customer_aliases WHERE tpid=? AND is_active=1", (tpid,)
        ).fetchall()
    ]
    return name, aliases


def _build_prompt(item_text: str, domains: list[str], cust_name: str, aliases: list[str]) -> str:
    return (
        f"Customer company: {cust_name}\n"
        f"Known aliases: {', '.join(aliases[:20]) or '(none)'}\n"
        f"Item participant domains: {', '.join(domains) or '(none)'}\n"
        f"---\n{item_text}\n---\n"
        "Is this item about that customer company? Reply ONLY JSON."
    )


def _content_hash(prompt: str) -> str:
    return hashlib.sha256(prompt.encode("utf-8")).hexdigest()


# ── Model adapter (injectable for tests) ────────────────────────────────────────────

def _parse_verdict(text: str) -> tuple[bool, float] | None:
    s = (text or "").strip()
    start, end = s.find("{"), s.rfind("}")
    if start == -1 or end == -1 or end <= start:
        return None
    try:
        obj = json.loads(s[start:end + 1])
    except (ValueError, TypeError):
        return None
    if not isinstance(obj, dict) or "related" not in obj:
        return None
    conf = obj.get("confidence")
    try:
        conf = float(conf)
    except (TypeError, ValueError):
        conf = 0.7
    return bool(obj["related"]), max(0.0, min(1.0, conf))


def _copilot_classifier():
    """Return a classify_fn backed by the Copilot fast model (Claude Haiku 4.5), or
    None when the desktop app hasn't wired a Copilot token."""
    if not fast_ai.copilot_available():
        return None

    def classify(prompt: str):
        text = fast_ai.copilot_chat(_SYSTEM_PROMPT, prompt, max_tokens=60)
        return _parse_verdict(text) if text is not None else None

    return classify


def _classifier(model: str):
    """The fast classifier: the connected GitHub Copilot fast model, or None when it
    isn't wired. Copilot is the only model — there is no `gh models` fallback."""
    return _copilot_classifier()


# ── Main entry point ────────────────────────────────────────────────────────────────

def verify_weak_links(
    con: sqlite3.Connection,
    kind: str,
    classify_fn=None,
    model: str = DEFAULT_MODEL,
    cap: int | None = None,
) -> dict:
    """Adjudicate weak-tier links for one medium (email/meeting/chat).

    ``classify_fn`` may be injected (tests); default is the connected GitHub Copilot
    fast model (Claude Haiku 4.5). When Copilot isn't wired this is a no-op. Returns a
    summary dict. Never raises."""
    if kind not in _KIND:
        raise ValueError(f"unknown kind: {kind}")
    table, id_col, _item_table = _KIND[kind]
    linkingmod.ensure_link_schema(con)
    cap = _resolve_cap(cap)

    summary = {"kind": kind, "candidates": 0, "checked": 0, "confirmed": 0,
               "rejected": 0, "from_cache": 0, "promoted_aliases": 0,
               "model_available": False, "ai_error": False}

    injected = classify_fn is not None
    if classify_fn is None:
        classify_fn = _classifier(model)
    if classify_fn is None:
        return summary  # no model, best-effort no-op
    summary["model_available"] = True
    # Record the model actually used (the Copilot fast model, Claude Haiku 4.5).
    eff_model = model if injected else (fast_ai.fast_model_label() or model)
    summary["model"] = eff_model

    # Weak links not already adjudicated. Ordered stably so a capped run is repeatable.
    cands = con.execute(
        f"""SELECT {id_col} AS iid, tpid, matched_term FROM {table}
            WHERE tier='weak' AND match_method NOT IN ('ai-verified','ai-rejected')
              AND tpid IN (SELECT tpid FROM tpid_config)
            ORDER BY {id_col}, tpid""",
    ).fetchall()
    summary["candidates"] = len(cands)

    src_map = linkingmod.alias_source_map(con)
    cache = {
        (r["item_id"], r["tpid"]): (r["content_hash"], r["verdict"], r["confidence"])
        for r in con.execute(
            "SELECT item_id, tpid, content_hash, verdict, confidence "
            "FROM ai_link_verifications WHERE kind=?", (kind,)
        ).fetchall()
    }

    checked = 0
    consecutive_failures = 0
    for c in cands:
        if checked >= cap:
            break
        iid, tpid, term = c["iid"], str(c["tpid"]), c["matched_term"]
        ctx = _item_context(con, kind, iid)
        if ctx is None:
            continue
        item_text, domains = ctx
        cust_name, aliases = _customer_context(con, tpid)
        prompt = _build_prompt(item_text, domains, cust_name, aliases)
        chash = _content_hash(prompt)

        cached = cache.get((iid, tpid))
        if cached and cached[0] == chash:
            verdict, conf = bool(cached[1]), cached[2]
            summary["from_cache"] += 1
        else:
            res = classify_fn(prompt)
            checked += 1
            summary["checked"] += 1
            if res is None:
                # Injected test stubs signal "skip this one"; a real model failure is
                # treated as transient — skip and continue so verdicts we already have
                # persist, and only stop after several consecutive failures.
                if injected:
                    continue
                consecutive_failures += 1
                if consecutive_failures >= _MAX_CONSECUTIVE_FAILURES:
                    # Copilot was wired but its calls failed back-to-back — flag it so
                    # the desktop app can surface a degraded-imports notice.
                    summary["ai_error"] = True
                    break
                continue
            consecutive_failures = 0
            verdict, conf = res
            con.execute(
                """INSERT INTO ai_link_verifications
                     (kind, item_id, tpid, content_hash, verdict, confidence, model)
                   VALUES (?,?,?,?,?,?,?)
                   ON CONFLICT(kind, item_id, tpid) DO UPDATE SET
                     content_hash=excluded.content_hash, verdict=excluded.verdict,
                     confidence=excluded.confidence, model=excluded.model,
                     created_at=CURRENT_TIMESTAMP""",
                (kind, iid, tpid, chash, 1 if verdict else 0, conf, eff_model),
            )
            # Persist incrementally so a later failure/interruption keeps this verdict.
            if summary["checked"] % 10 == 0:
                con.commit()

        if verdict:
            con.execute(
                f"""UPDATE {table}
                    SET match_method='ai-verified', tier='medium', confidence=0.80
                    WHERE {id_col}=? AND tpid=?""",
                (iid, tpid),
            )
            summary["confirmed"] += 1
            # Promote the underlying AI alias so its future matches start at 'medium'.
            if term and src_map.get((tpid, term)) == "ai":
                n = linkingmod.record_promotion(con, tpid, term)
                if n == linkingmod.PROMOTE_THRESHOLD:
                    summary["promoted_aliases"] += 1
        else:
            con.execute(
                f"""UPDATE {table}
                    SET match_method='ai-rejected', tier='weak', confidence=0.10
                    WHERE {id_col}=? AND tpid=?""",
                (iid, tpid),
            )
            summary["rejected"] += 1

    con.commit()
    _reflag(con, kind)
    con.commit()
    return summary


def _reflag(con: sqlite3.Connection, kind: str) -> None:
    """Recompute the item's customer-related flag, excluding ai-rejected links."""
    if kind == "email":
        con.execute("UPDATE emails SET is_customer_related=0")
        con.execute(
            "UPDATE emails SET is_customer_related=1 WHERE message_id IN "
            "(SELECT DISTINCT message_id FROM email_customer_links WHERE match_method <> 'ai-rejected')"
        )
    elif kind == "meeting":
        con.execute("UPDATE meetings SET is_customer_related=0")
        con.execute(
            "UPDATE meetings SET is_customer_related=1 WHERE event_id IN "
            "(SELECT DISTINCT event_id FROM meeting_customer_links WHERE match_method <> 'ai-rejected')"
        )
    elif kind == "chat":
        con.execute("UPDATE teams_chats SET is_customer_related=0")
        con.execute(
            "UPDATE teams_chats SET is_customer_related=1 WHERE chat_id IN "
            "(SELECT DISTINCT chat_id FROM teams_chat_customer_links WHERE match_method <> 'ai-rejected')"
        )
