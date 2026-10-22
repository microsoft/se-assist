"""Customer alias map + chat<->customer matching.

Builds a normalized alias table per tpid from local customer names and saved
aliases, then matches chat topics against those aliases. No customer records
are bundled with the public source.
"""
from __future__ import annotations

import re
import sqlite3
from tools.common.roster import active_tpids

# Account aliases come from the active local roster and saved database rows.
CURATED: dict[str, tuple[str, list[str]]] = {}

# Tokens that are too generic to be reliable standalone aliases when auto-derived.
_STOPWORDS = {
    "inc", "llc", "lp", "ltd", "corp", "corporation", "company", "co", "group",
    "holdings", "holding", "services", "service", "systems", "system", "financial",
    "finance", "capital", "management", "investments", "investment", "partners",
    "the", "and", "of", "global", "international", "solutions", "asset", "america",
    "american", "associates", "association", "advisors", "technology", "technologies",
}


def normalize(text: str | None) -> str:
    """Lower-case, fold & -> and, strip punctuation to spaces, collapse whitespace."""
    s = (text or "").lower()
    s = s.replace("&", " and ")
    s = re.sub(r"[^a-z0-9]+", " ", s)
    return re.sub(r"\s+", " ", s).strip()


def display_name_for(tpid: str) -> str:
    return CURATED.get(tpid, (f"TPID {tpid}", []))[0]


def _roster_tpids(con: sqlite3.Connection) -> set[str]:
    return active_tpids(con)


def known_tpids(con: sqlite3.Connection) -> list[str]:
    """An empty saved roster means no account work, never a curated fallback."""
    return sorted(_roster_tpids(con))


def _auto_aliases_from_customers(con: sqlite3.Connection) -> dict[str, set[str]]:
    """Derive candidate aliases per tpid from distinct customer names."""
    out: dict[str, set[str]] = {}
    rows = con.execute(
        "SELECT DISTINCT tpid, name FROM active_customers WHERE tpid IS NOT NULL AND name IS NOT NULL"
    ).fetchall()
    for r in rows:
        tpid = str(r["tpid"]).strip()
        norm = normalize(r["name"])
        if not norm:
            continue
        # Skip names that reduce to only stopwords/short tokens.
        tokens = [t for t in norm.split() if t not in _STOPWORDS and len(t) > 2]
        if not tokens:
            continue
        out.setdefault(tpid, set()).add(norm)
    return out


def build_alias_table(con: sqlite3.Connection) -> dict[str, int]:
    """Populate teams_customer_aliases from curated seeds + auto-derived names.

    Returns a per-tpid count of active aliases. Curated/manual aliases are preserved.
    """
    auto = _auto_aliases_from_customers(con)
    roster = _roster_tpids(con)
    for tpid, (_display, aliases) in CURATED.items():
        if tpid not in roster:
            continue
        for alias in aliases:
            con.execute(
                """INSERT INTO teams_customer_aliases(tpid, alias, source)
                   VALUES(?,?, 'curated')
                   ON CONFLICT(tpid, alias) DO UPDATE SET source='curated', is_active=1""",
                (tpid, normalize(alias)),
            )
    # Auto-derived (do not clobber curated/manual rows).
    for tpid, names in auto.items():
        for alias in names:
            con.execute(
                """INSERT INTO teams_customer_aliases(tpid, alias, source)
                   VALUES(?,?, 'auto')
                   ON CONFLICT(tpid, alias) DO NOTHING""",
                (tpid, alias),
            )
    con.commit()
    counts: dict[str, int] = {}
    for r in con.execute(
        "SELECT tpid, COUNT(*) n FROM teams_customer_aliases WHERE is_active=1 "
        "AND tpid IN (SELECT tpid FROM tpid_config) GROUP BY tpid"
    ):
        counts[str(r["tpid"])] = r["n"]
    return counts


def load_aliases(con: sqlite3.Connection) -> list[tuple[str, str]]:
    """Return active (tpid, alias) pairs, longest alias first for greedy matching."""
    rows = con.execute(
        "SELECT tpid, alias FROM teams_customer_aliases WHERE is_active=1 "
        "AND tpid IN (SELECT tpid FROM tpid_config)"
    ).fetchall()
    pairs = [(str(r["tpid"]), r["alias"]) for r in rows]
    pairs.sort(key=lambda p: len(p[1]), reverse=True)
    return pairs


class AliasMatcher:
    """Precompiled whole-word alias matcher. Build ONCE per link run, then call
    :meth:`match` for every item (email/meeting/chat).

    Why this exists: the naive approach ran one ``re.search`` per alias per text.
    With a large roster (thousands of accounts -> thousands of aliases) the regex
    cache thrashes and each call recompiles, so linking a big mailbox took many
    minutes and blew the ingestion timeout (customer-matched counts came back 0).

    This matcher instead indexes aliases by their token length and tests only the
    whole-word n-grams actually present in the text against a hash set. That is
    exactly the old semantics — an alias matches iff it appears as consecutive
    whole tokens in the normalized text — but it is O(text tokens) per item instead
    of O(aliases), i.e. ~1000x faster at roster scale, with identical recall.
    """

    def __init__(self, alias_pairs: list[tuple[str, str]]):
        # alias phrase -> set of tpids that share it; plus the max token width so we
        # only build n-grams up to the longest alias length.
        self._alias_tpids: dict[str, set[str]] = {}
        self._max_words = 1
        for tpid, alias in alias_pairs:
            if not alias:
                continue
            self._alias_tpids.setdefault(alias, set()).add(tpid)
            width = alias.count(" ") + 1
            if width > self._max_words:
                self._max_words = width
        self._alias_keys = frozenset(self._alias_tpids)

    def match(self, normalized_text: str) -> dict[str, str]:
        """Return {tpid: matched_alias} for every alias present as a whole-word
        phrase. Each tpid maps to its longest matching alias (ties broken
        alphabetically for a stable, reproducible matched_term)."""
        if not normalized_text or not self._alias_keys:
            return {}
        tokens = normalized_text.split()
        n = len(tokens)
        max_w = self._max_words
        keys = self._alias_keys
        present: set[str] = set()
        for i in range(n):
            phrase = tokens[i]
            if phrase in keys:
                present.add(phrase)
            # Extend the window one token at a time up to the longest alias width.
            upper = i + max_w
            if upper > n:
                upper = n
            for j in range(i + 1, upper):
                phrase = phrase + " " + tokens[j]
                if phrase in keys:
                    present.add(phrase)
        best: dict[str, str] = {}
        # Longest alias wins per tpid; alphabetical tie-break keeps results stable.
        for alias in sorted(present, key=lambda a: (-len(a), a)):
            for tpid in self._alias_tpids[alias]:
                if tpid not in best:
                    best[tpid] = alias
        return best


def build_matcher(con: sqlite3.Connection) -> "AliasMatcher":
    """Load the active alias set and return a reusable matcher for a link run."""
    return AliasMatcher(load_aliases(con))


def match_text(normalized_text: str, alias_pairs: list[tuple[str, str]]) -> dict[str, str]:
    """Return {tpid: matched_alias} for every alias found as a whole-word phrase.

    Backward-compatible convenience wrapper. Hot loops should build an
    :class:`AliasMatcher` once and reuse it instead of calling this per item.
    """
    return AliasMatcher(alias_pairs).match(normalized_text)
