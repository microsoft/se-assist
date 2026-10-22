"""Shared customer-linking heuristics for the tools/* pipelines.

Covers three concerns used identically by the email, meetings and teams linkers:

  * ``confidence`` — the length-based numeric score for an alias hit (unchanged).
  * method **rank** — which signal wins the single (item, tpid) link row when more
    than one linker fires (a link table has one row per pair, so the strongest
    signal must claim it and weaker ones must not overwrite it).
  * confidence **tier** — a coarse 'strong' | 'medium' | 'weak' label stored on the
    link so downstream consumers can threshold on trust without re-deriving it.

Tier / rank cheat-sheet (highest trust first):

  method            tier     rank   meaning
  manual            strong   100    a human declared this link
  identity-contact  strong    90    a participant is an exact CRM contact of the acct
  ai-verified       medium    72    a weak link the AI classifier confirmed (feature E)
  contact           medium    62    a learned high-dominance customer domain/address
  identity-domain   medium    60    a participant's domain is a unique CRM contact domain
  alias (exact)     medium    50    curated/auto (real account/subsidiary name) matched
  alias (ai)        weak*     35    an AI-guessed short alias matched  (*medium once promoted)
  alias-thread/     weak      30    propagated across a thread/recurring series
    alias-series
  search            weak      20    surfaced by an account's mailbox search only
  ai-rejected       weak       5    the AI classifier said this weak link is NOT related
"""
from __future__ import annotations

import sqlite3

STRONG = "strong"
MEDIUM = "medium"
WEAK = "weak"

# Number of AI-confirmed successes after which an AI-guessed alias is promoted so
# its future matches start at 'medium' instead of 'weak' (feature E).
PROMOTE_THRESHOLD = 3

# The three link tables and their item-id column, for the schema/tier helpers.
LINK_TABLES = {
    "email_customer_links": "message_id",
    "meeting_customer_links": "event_id",
    "teams_chat_customer_links": "chat_id",
}

_RANK = {
    "manual": 100,
    "identity-contact": 90,
    "ai-verified": 72,
    "contact": 62,
    "identity-domain": 60,
    "alias": 50,          # exact (curated/auto) alias
    "alias-ai": 35,       # AI-guessed alias (synthetic rank key, see ``rank``)
    "alias-thread": 30,
    "alias-series": 30,
    "search": 20,
    "ai-rejected": 5,
}


def confidence(alias: str) -> float:
    """Longer, more specific aliases are more trustworthy than short ones.

    Identical across the email, meetings, and teams linkers, so it lives here.
    """
    n = len(alias)
    if n >= 12:
        return 0.95
    if n >= 7:
        return 0.85
    if n >= 4:
        return 0.7
    return 0.55


def rank(method: str, alias_source: str | None = None) -> int:
    """Precedence of a link signal. Higher wins the single per-pair link row.

    ``alias`` rows split by source: an AI-guessed alias outranks nothing but the
    propagated/search/rejected tiers, while an exact (curated/auto) alias sits above
    the identity-domain signal.
    """
    if method == "alias" and alias_source == "ai":
        return _RANK["alias-ai"]
    return _RANK.get(method, 0)


def tier_for(method: str, alias_source: str | None = None, promoted: bool = False) -> str:
    """Coarse trust tier for a link, from its method (+ alias source / promotion)."""
    if method in ("manual", "identity-contact"):
        return STRONG
    if method in ("ai-verified", "contact", "identity-domain"):
        return MEDIUM
    if method == "alias":
        if alias_source == "ai":
            return MEDIUM if promoted else WEAK
        return MEDIUM  # curated / auto (real account or subsidiary name)
    # alias-thread, alias-series, search, ai-rejected, unknown
    return WEAK


# ── Schema helpers (idempotent; safe to call before every linker run) ───────────────

def ensure_link_schema(con: sqlite3.Connection) -> None:
    """Add the ``tier`` column to whichever link tables exist and create the AI
    verification / promotion support tables. Mirrors migration 016 so the Python
    pipelines work even when run against a datastore the desktop app hasn't migrated
    (e.g. tests, or a tool invoked before app startup). Idempotent."""
    for table in LINK_TABLES:
        if not _table_exists(con, table):
            continue
        cols = {r["name"] for r in con.execute(f"PRAGMA table_info({table})")}
        if "tier" not in cols:
            con.execute(f"ALTER TABLE {table} ADD COLUMN tier TEXT")
    con.execute(
        """CREATE TABLE IF NOT EXISTS ai_link_verifications (
             kind TEXT NOT NULL, item_id TEXT NOT NULL, tpid TEXT NOT NULL,
             content_hash TEXT, verdict INTEGER NOT NULL, confidence REAL,
             model TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
             PRIMARY KEY (kind, item_id, tpid))"""
    )
    con.execute(
        """CREATE TABLE IF NOT EXISTS customer_alias_promotions (
             tpid TEXT NOT NULL, alias TEXT NOT NULL,
             success_count INTEGER NOT NULL DEFAULT 0,
             last_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
             PRIMARY KEY (tpid, alias))"""
    )
    con.commit()


def _table_exists(con: sqlite3.Connection, name: str) -> bool:
    return con.execute(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", (name,)
    ).fetchone() is not None


def alias_source_map(con: sqlite3.Connection) -> dict[tuple[str, str], str]:
    """{(tpid, normalized_alias): source} for active aliases, for tier assignment."""
    try:
        rows = con.execute(
            "SELECT tpid, alias, source FROM teams_customer_aliases WHERE is_active=1"
        ).fetchall()
    except sqlite3.OperationalError:
        return {}
    return {(str(r["tpid"]), r["alias"]): (r["source"] or "auto") for r in rows}


def promoted_alias_set(con: sqlite3.Connection) -> set[tuple[str, str]]:
    """{(tpid, alias)} for AI aliases with enough confirmed successes to be promoted."""
    try:
        rows = con.execute(
            "SELECT tpid, alias FROM customer_alias_promotions WHERE success_count >= ?",
            (PROMOTE_THRESHOLD,),
        ).fetchall()
    except sqlite3.OperationalError:
        return set()
    return {(str(r["tpid"]), r["alias"]) for r in rows}


def assign_tiers(con: sqlite3.Connection, table: str) -> int:
    """Recompute the ``tier`` column for every row in a link table from its method,
    the matched alias's source, and any AI promotion. Returns rows updated."""
    if table not in LINK_TABLES:
        raise ValueError(f"unknown link table: {table}")
    id_col = LINK_TABLES[table]
    src = alias_source_map(con)
    promoted = promoted_alias_set(con)
    rows = con.execute(
        f"SELECT {id_col} AS iid, tpid, match_method, matched_term FROM {table} "
        "WHERE tpid IN (SELECT tpid FROM tpid_config)"
    ).fetchall()
    updated = 0
    for r in rows:
        method = r["match_method"]
        source = None
        is_promoted = False
        if method == "alias":
            key = (str(r["tpid"]), r["matched_term"] or "")
            source = src.get(key, "auto")
            is_promoted = key in promoted
        tier = tier_for(method, source, is_promoted)
        con.execute(
            f"UPDATE {table} SET tier=? WHERE {id_col}=? AND tpid=?",
            (tier, r["iid"], r["tpid"]),
        )
        updated += 1
    con.commit()
    return updated


def record_promotion(con: sqlite3.Connection, tpid: str, alias: str) -> int:
    """Increment the confirmed-success counter for an AI alias; return new count."""
    con.execute(
        """INSERT INTO customer_alias_promotions(tpid, alias, success_count, last_at)
           VALUES(?,?,1, CURRENT_TIMESTAMP)
           ON CONFLICT(tpid, alias) DO UPDATE SET
             success_count = success_count + 1, last_at = CURRENT_TIMESTAMP""",
        (tpid, alias),
    )
    row = con.execute(
        "SELECT success_count FROM customer_alias_promotions WHERE tpid=? AND alias=?",
        (tpid, alias),
    ).fetchone()
    return int(row[0]) if row else 0
