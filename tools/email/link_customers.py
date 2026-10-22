"""Link emails to customer accounts (tpid).

Two signals, both idempotent:
  - alias  : the email's subject + sender + cleaned body matches a curated/auto account
             alias (reuses the shared teams_customer_aliases map).
  - search : a recall guarantee — every email surfaced by an account's mailbox search is
             linked to that account (lower confidence) even if the alias isn't in the
             stored preview/body.

Manual links are always preserved; alias links are rebuilt on each run.
"""
from __future__ import annotations

import json
import sqlite3

from tools.teams import aliases as aliasmod
from tools.teams.ingest_messages import strip_html
from tools.common.linking import confidence as _confidence


def _match_blob(row) -> str:
    """Full searchable text for an email: subject + sender + the COMPLETE body
    (including quoted reply history), derived from raw_json. Unlike the stored
    display body_text — which is trimmed at the first quoted-reply marker — this
    keeps the quoted history, where a customer's name is often mentioned. Used
    only for linking, never shown."""
    parts = [row["subject"] or "", row["from_name"] or ""]
    raw = row["raw_json"]
    if raw:
        try:
            obj = json.loads(raw)
            body = obj.get("body") or {}
            content = body.get("content") if isinstance(body, dict) else body
            if content:
                parts.append(strip_html(content))
        except (ValueError, TypeError):
            pass
    # Fall back to the trimmed body if raw was unavailable.
    if len(parts) == 2:
        parts.append(row["body_text"] or "")
    return " ".join(parts)


def link_emails(con: sqlite3.Connection, replace_auto: bool = True) -> dict:
    """Content-match every email against the account alias map -> email_customer_links.

    After direct matching, propagate links across conversation threads: if any email in
    a thread matched an account, link every email in that thread to it. Same thread =
    same customer, so this lifts recall (preview text often omits the name on replies)
    while staying high-precision.
    """
    pairs = aliasmod.load_aliases(con)
    matcher = aliasmod.AliasMatcher(pairs)
    if replace_auto:
        con.execute("DELETE FROM email_customer_links WHERE tpid IN (SELECT tpid FROM tpid_config) AND match_method IN ('alias','alias-thread')")

    rows = con.execute(
        "SELECT message_id, conversation_id, subject, from_name, body_text, raw_json FROM active_emails"
    ).fetchall()
    link_rows = 0
    matched = 0
    # (conversation_id -> {tpid: best_alias}) for thread propagation.
    conv_hits: dict[str, dict[str, str]] = {}
    for r in rows:
        norm = aliasmod.normalize(_match_blob(r))
        hits = matcher.match(norm)
        if not hits:
            continue
        matched += 1
        for tpid, alias in hits.items():
            _upsert_alias_link(con, r["message_id"], tpid, alias)
            link_rows += 1
            cid = r["conversation_id"]
            if cid:
                conv_hits.setdefault(cid, {})
                # keep the longest (most specific) alias seen for the thread
                if tpid not in conv_hits[cid] or len(alias) > len(conv_hits[cid][tpid]):
                    conv_hits[cid][tpid] = alias

    # Thread propagation: link every email in a matched conversation.
    propagated = 0
    for cid, tmap in conv_hits.items():
        members = con.execute(
            "SELECT message_id FROM active_emails WHERE conversation_id = ?", (cid,)
        ).fetchall()
        for m in members:
            for tpid, alias in tmap.items():
                if _upsert_alias_link(con, m["message_id"], tpid, alias, thread=True):
                    propagated += 1

    _reflag(con)
    con.commit()
    return {"matched_emails": matched, "link_rows": link_rows, "thread_propagated": propagated}


def _upsert_alias_link(con, message_id, tpid, alias, thread: bool = False) -> bool:
    """Insert an alias link. Returns True if a new row was created."""
    method = "alias-thread" if thread else "alias"
    cur = con.execute(
        "SELECT match_method FROM active_email_customer_links WHERE message_id=? AND tpid=?",
        (message_id, tpid),
    ).fetchone()
    if cur is None:
        con.execute(
            """INSERT INTO email_customer_links
                 (message_id, tpid, match_method, matched_term, confidence)
               VALUES (?,?,?,?,?)""",
            (message_id, tpid, method, alias, _confidence(alias) - (0.1 if thread else 0)),
        )
        return True
    # Direct alias match upgrades a thread-propagated row; never downgrade.
    if not thread and cur["match_method"] == "alias-thread":
        con.execute(
            """UPDATE email_customer_links
               SET match_method='alias', matched_term=?, confidence=?
               WHERE message_id=? AND tpid=?""",
            (alias, _confidence(alias), message_id, tpid),
        )
    return False


def add_manual_link(con: sqlite3.Connection, message_id: str, tpid: str) -> None:
    con.execute(
        """INSERT INTO email_customer_links
             (message_id, tpid, match_method, matched_term, confidence)
           VALUES (?,?, 'manual', NULL, 1.0)
           ON CONFLICT(message_id, tpid) DO UPDATE SET match_method='manual', confidence=1.0""",
        (message_id, tpid),
    )
    _reflag(con)
    con.commit()


def _reflag(con: sqlite3.Connection) -> None:
    con.execute("UPDATE emails SET is_customer_related=0")
    con.execute(
        """UPDATE emails SET is_customer_related=1
           WHERE message_id IN (
             SELECT DISTINCT message_id FROM email_customer_links
             WHERE tpid IN (SELECT tpid FROM tpid_config) AND match_method <> 'ai-rejected')"""
    )
