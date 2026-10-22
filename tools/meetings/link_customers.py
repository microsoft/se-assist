"""Link meetings to customer accounts (tpid).

Signals (idempotent):
  - alias        : the meeting's subject + organizer + attendee names + body matches a
                   curated/auto account alias (reuses the shared teams_customer_aliases map).
  - alias-series : recall lift — if any instance of a recurring series matched an account,
                   link every instance in that series (same series = same customer).

Manual links are always preserved; alias links are rebuilt on each run.
"""
from __future__ import annotations

import json
import sqlite3

from tools.teams import aliases as aliasmod
from tools.teams.ingest_messages import strip_html
from tools.common.linking import confidence as _confidence


def _match_blob(row) -> str:
    """Full searchable text for a meeting: subject + organizer + attendee names + the
    COMPLETE body (from raw_json, including any boilerplate trimmed from the display
    body). Used only for linking, never shown."""
    parts = [row["subject"] or "", row["organizer_name"] or ""]
    try:
        for a in json.loads(row["attendees_json"] or "[]"):
            if a.get("name"):
                parts.append(a["name"])
    except (ValueError, TypeError):
        pass
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
    else:
        parts.append(row["body_text"] or "")
    return " ".join(parts)


def _series_key(row) -> str | None:
    return row["series_master_id"] or row["ical_uid"] or None


def link_meetings(con: sqlite3.Connection, replace_auto: bool = True) -> dict:
    """Content-match every meeting against the account alias map -> meeting_customer_links.

    After direct matching, propagate links across recurring series: if any instance of a
    series matched an account, link every instance to it. Same series = same customer.
    """
    pairs = aliasmod.load_aliases(con)
    matcher = aliasmod.AliasMatcher(pairs)
    if replace_auto:
        con.execute("DELETE FROM meeting_customer_links WHERE tpid IN (SELECT tpid FROM tpid_config) AND match_method IN ('alias','alias-series')")

    rows = con.execute(
        """SELECT event_id, series_master_id, ical_uid, subject, organizer_name,
                  attendees_json, body_text, raw_json
           FROM active_meetings"""
    ).fetchall()
    link_rows = 0
    matched = 0
    # series_key -> {tpid: best_alias} for series propagation.
    series_hits: dict[str, dict[str, str]] = {}
    for r in rows:
        norm = aliasmod.normalize(_match_blob(r))
        hits = matcher.match(norm)
        if not hits:
            continue
        matched += 1
        skey = _series_key(r)
        for tpid, alias in hits.items():
            _upsert_alias_link(con, r["event_id"], tpid, alias)
            link_rows += 1
            if skey:
                series_hits.setdefault(skey, {})
                if tpid not in series_hits[skey] or len(alias) > len(series_hits[skey][tpid]):
                    series_hits[skey][tpid] = alias

    # Series propagation: link every instance of a matched recurring series.
    propagated = 0
    for skey, tmap in series_hits.items():
        members = con.execute(
            "SELECT event_id FROM active_meetings WHERE series_master_id = ? OR ical_uid = ?",
            (skey, skey),
        ).fetchall()
        for m in members:
            for tpid, alias in tmap.items():
                if _upsert_alias_link(con, m["event_id"], tpid, alias, series=True):
                    propagated += 1

    _reflag(con)
    con.commit()
    return {"matched_meetings": matched, "link_rows": link_rows, "series_propagated": propagated}


def _upsert_alias_link(con, event_id, tpid, alias, series: bool = False) -> bool:
    """Insert an alias link. Returns True if a new row was created."""
    method = "alias-series" if series else "alias"
    cur = con.execute(
        "SELECT match_method FROM active_meeting_customer_links WHERE event_id=? AND tpid=?",
        (event_id, tpid),
    ).fetchone()
    if cur is None:
        con.execute(
            """INSERT INTO meeting_customer_links
                 (event_id, tpid, match_method, matched_term, confidence)
               VALUES (?,?,?,?,?)""",
            (event_id, tpid, method, alias, _confidence(alias) - (0.1 if series else 0)),
        )
        return True
    # Direct alias match upgrades a series-propagated row; never downgrade.
    if not series and cur["match_method"] == "alias-series":
        con.execute(
            """UPDATE meeting_customer_links
               SET match_method='alias', matched_term=?, confidence=?
               WHERE event_id=? AND tpid=?""",
            (alias, _confidence(alias), event_id, tpid),
        )
    return False


def add_manual_link(con: sqlite3.Connection, event_id: str, tpid: str) -> None:
    con.execute(
        """INSERT INTO meeting_customer_links
             (event_id, tpid, match_method, matched_term, confidence)
           VALUES (?,?, 'manual', NULL, 1.0)
           ON CONFLICT(event_id, tpid) DO UPDATE SET match_method='manual', confidence=1.0""",
        (event_id, tpid),
    )
    _reflag(con)
    con.commit()


def _reflag(con: sqlite3.Connection) -> None:
    con.execute("UPDATE meetings SET is_customer_related=0")
    con.execute(
        """UPDATE meetings SET is_customer_related=1
           WHERE event_id IN (
             SELECT DISTINCT event_id FROM meeting_customer_links
             WHERE tpid IN (SELECT tpid FROM tpid_config) AND match_method <> 'ai-rejected')"""
    )
