"""Link chats to customer accounts (tpid) by matching topics against aliases."""
from __future__ import annotations

import json
import sqlite3

from . import aliases as aliasmod
from tools.common.linking import confidence as _confidence
from tools.common import identity as identitymod
from tools.common import linking as linkingmod


def link_chats(con: sqlite3.Connection, replace_auto: bool = True) -> dict:
    """Match every chat topic to customer aliases and write teams_chat_customer_links.

    Manual links (match_method='manual') are always preserved. Auto links are
    rebuilt when replace_auto is True.
    """
    pairs = aliasmod.load_aliases(con)
    matcher = aliasmod.AliasMatcher(pairs)
    if replace_auto:
        con.execute("DELETE FROM teams_chat_customer_links WHERE tpid IN (SELECT tpid FROM tpid_config) AND match_method='alias'")

    chats = con.execute("SELECT chat_id, topic FROM active_teams_chats").fetchall()
    link_rows = 0
    matched_chats = 0
    per_tpid: dict[str, int] = {}

    for chat in chats:
        topic = chat["topic"]
        if not topic:
            continue
        norm = aliasmod.normalize(topic)
        hits = matcher.match(norm)
        if not hits:
            continue
        matched_chats += 1
        for tpid, alias in hits.items():
            con.execute(
                """INSERT INTO teams_chat_customer_links
                     (chat_id, tpid, match_method, matched_term, confidence)
                   VALUES (?,?, 'alias', ?, ?)
                   ON CONFLICT(chat_id, tpid) DO UPDATE SET
                     matched_term=excluded.matched_term,
                     confidence=excluded.confidence
                   WHERE teams_chat_customer_links.match_method='alias'""",
                (chat["chat_id"], tpid, alias, _confidence(alias)),
            )
            link_rows += 1
            per_tpid[tpid] = per_tpid.get(tpid, 0) + 1

    # Flag customer-related chats based on existing links (alias or manual).
    con.execute("UPDATE teams_chats SET is_customer_related=0")
    con.execute(
        """UPDATE teams_chats SET is_customer_related=1
           WHERE chat_id IN (
             SELECT DISTINCT chat_id FROM teams_chat_customer_links
             WHERE tpid IN (SELECT tpid FROM tpid_config) AND match_method <> 'ai-rejected')"""
    )
    con.commit()
    return {
        "matched_chats": matched_chats,
        "link_rows": link_rows,
        "per_tpid": per_tpid,
    }


def _member_addresses(raw_json: str | None) -> list[str]:
    """Extract member e-mail addresses from a stored chat inventory record. The
    ListChats export may or may not carry an expanded members[] array; when it does,
    each member typically has an ``email`` (guests/external contacts always do)."""
    if not raw_json:
        return []
    try:
        obj = json.loads(raw_json)
    except (ValueError, TypeError):
        return []
    out: list[str] = []
    members = obj.get("members") if isinstance(obj, dict) else None
    if isinstance(members, list):
        for m in members:
            if not isinstance(m, dict):
                continue
            email = m.get("email") or m.get("userPrincipalName") or ""
            email = str(email).strip().lower()
            if "@" in email:
                out.append(email)
    return out


def link_by_identity(con: sqlite3.Connection, tpid: str | None = None) -> dict:
    """Identity-first linking for chats: link a chat to an account when a chat member
    is an exact CRM contact of that account (``identity-contact``, strong) or sits on a
    domain that maps unambiguously to a single account's CRM contacts
    (``identity-domain``, medium).

    Best-effort: chat member e-mails are only available when the ListChats export
    carried an expanded members[] array. When absent this simply links nothing.
    Rebuilds identity rows each run; never downgrades a higher-ranked link."""
    linkingmod.ensure_link_schema(con)
    if tpid is None:
        con.execute(
            "DELETE FROM teams_chat_customer_links "
            "WHERE tpid IN (SELECT tpid FROM tpid_config) AND match_method IN ('identity-contact','identity-domain')"
        )
    else:
        con.execute(
            "DELETE FROM teams_chat_customer_links "
            "WHERE tpid IN (SELECT tpid FROM tpid_config) AND match_method IN ('identity-contact','identity-domain') AND tpid=?",
            (tpid,),
        )

    addr_map, domain_map = identitymod.contact_maps(con)
    if tpid:
        addr_map = {a: t for a, t in addr_map.items() if t == tpid}
        domain_map = {d: t for d, t in domain_map.items() if t == tpid}
    if not addr_map and not domain_map:
        con.commit()
        return {"related_chats": 0, "new_links": 0}

    src_map = linkingmod.alias_source_map(con)
    rows = con.execute("SELECT chat_id, raw_json FROM active_teams_chats").fetchall()
    linked = 0
    related = 0
    for r in rows:
        hits: dict[str, tuple[str, str, float]] = {}
        for a in _member_addresses(r["raw_json"]):
            t = addr_map.get(a)
            if t:
                hits[t] = ("identity-contact", f"contact:{a}", 0.98)
                continue
            dom = a.rsplit("@", 1)[-1]
            t = domain_map.get(dom)
            if t and t not in hits:
                hits[t] = ("identity-domain", f"domain:{dom}", 0.90)
        if not hits:
            continue
        related += 1
        for t, (method, term, conf) in hits.items():
            if _upsert_identity(con, r["chat_id"], t, method, term, conf, src_map):
                linked += 1

    con.execute("UPDATE teams_chats SET is_customer_related=0")
    con.execute(
        """UPDATE teams_chats SET is_customer_related=1
           WHERE chat_id IN (
             SELECT DISTINCT chat_id FROM teams_chat_customer_links
             WHERE tpid IN (SELECT tpid FROM tpid_config) AND match_method <> 'ai-rejected')"""
    )
    con.commit()
    return {"related_chats": related, "new_links": linked}


def _upsert_identity(con, chat_id, tpid, method, term, conf, src_map) -> bool:
    new_rank = linkingmod.rank(method)
    cur = con.execute(
        "SELECT match_method, matched_term FROM active_teams_chat_customer_links "
        "WHERE chat_id=? AND tpid=?",
        (chat_id, tpid),
    ).fetchone()
    tier = linkingmod.tier_for(method)
    if cur is None:
        con.execute(
            """INSERT INTO teams_chat_customer_links
                 (chat_id, tpid, match_method, matched_term, confidence, tier)
               VALUES (?,?,?,?,?,?)""",
            (chat_id, tpid, method, term, conf, tier),
        )
        return True
    cur_src = src_map.get((str(tpid), cur["matched_term"] or "")) if cur["match_method"] == "alias" else None
    if new_rank > linkingmod.rank(cur["match_method"], cur_src):
        con.execute(
            """UPDATE teams_chat_customer_links
               SET match_method=?, matched_term=?, confidence=?, tier=?
               WHERE chat_id=? AND tpid=?""",
            (method, term, conf, tier, chat_id, tpid),
        )
    return False


def add_manual_link(con: sqlite3.Connection, chat_id: str, tpid: str) -> None:
    con.execute(
        """INSERT INTO teams_chat_customer_links
             (chat_id, tpid, match_method, matched_term, confidence)
           VALUES (?,?, 'manual', NULL, 1.0)
           ON CONFLICT(chat_id, tpid) DO UPDATE SET match_method='manual', confidence=1.0""",
        (chat_id, tpid),
    )
    con.execute(
        "UPDATE teams_chats SET is_customer_related=1 WHERE chat_id=?", (chat_id,)
    )
    con.commit()
