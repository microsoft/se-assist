"""AI-assisted customer alias generation.

Auto-aliases derived from the customers table are the *full legal name* only, so a
fresh user's emails/meetings/chats that mention a company by its short name or a
subsidiary brand ("Athene", "Ellie Mae", "P72") never link. This module asks a fast AI
model — **Claude Haiku 4.5** via the GitHub Copilot API — for short, high-precision
aliases per customer name and stores them alongside the auto/curated aliases.

The connected GitHub Copilot is the ONLY model used; there is no `gh models` /
gpt-4o-mini fallback. When Copilot isn't wired (or its calls fail) alias generation is
skipped and the run continues in a degraded state on the exact-name baseline below.

Design:
  - Purely ADDITIVE. The exact (normalized) customer name is always written as an
    'auto' alias, so if Copilot is unavailable the linker still works exactly as before
    — that is the deterministic degraded baseline (NOT an alternate AI model).
  - Per-name cache (`customer_alias_ai`) so repeated Backfill / Pull-new-items runs
    don't re-query the model: only brand-new customer names hit the API.
  - Best-effort. Copilot missing, unauthenticated, rate-limited, or returning garbage
    never raises — we fall back to exact names and report it in the summary
    (``model_available`` / ``ai_error``) so the desktop app can surface a degraded notice.
"""
from __future__ import annotations

import json
import re
import sqlite3

from .aliases import _STOPWORDS, normalize
from tools.common import fast_ai

# Label for the fast model. The actual model is resolved from the Copilot env (see
# fast_ai.fast_model_label); this is only the default/display label.
DEFAULT_MODEL = "claude-haiku-4.5"

# Bound the work a single Backfill / Pull-new run will spend calling the model, so a
# first run over thousands of freshly-synced child accounts can't hang the ingest.
# Anything past the cap keeps its exact-name alias now and gets AI aliases on the next
# run (results are cached, so runs converge).
DEFAULT_MAX_NEW = 400
DEFAULT_BATCH = 20

# A single transient model failure (a rate-limit blip, a dropped connection, one
# malformed reply) must NOT throw away the whole run's progress. We skip the failing
# batch (its names keep the exact-name fallback and stay uncached so a later run retries
# them) and carry on, committing successful batches as we go. Only when several calls
# fail back-to-back do we treat the model as down and stop early.
_MAX_CONSECUTIVE_FAILURES = 3

_SYSTEM_PROMPT = (
    "You generate short, INFORMAL search aliases for matching a company in free-form "
    "business text (email subjects, meeting titles, chat topics). The company's "
    "official and subsidiary names are already known from CRM, so return only the "
    "informal short forms a colleague would actually type: stock tickers, "
    "acronyms/initialisms, and common nicknames. Output ONLY compact JSON. No prose, "
    "no markdown fences."
)

_CACHE_SCHEMA = """
CREATE TABLE IF NOT EXISTS customer_alias_ai (
  tpid TEXT NOT NULL,
  name_norm TEXT NOT NULL,
  aliases TEXT NOT NULL DEFAULT '[]',
  model TEXT,
  generated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (tpid, name_norm)
);
"""


def _ensure_cache(con: sqlite3.Connection) -> None:
    con.execute(_CACHE_SCHEMA)


def model_available() -> bool:
    """True when the connected GitHub Copilot fast model (Claude Haiku 4.5) is wired.

    Copilot is the only model — there is no `gh models` / gpt-4o-mini fallback."""
    return fast_ai.copilot_available()


def _effective_model(model: str) -> str:
    """The model id actually used: the Copilot fast model label when wired."""
    return fast_ai.fast_model_label() or model


def _meaningful(name_norm: str) -> bool:
    """Mirror the auto-alias guard: skip names that reduce to only stopwords."""
    return any(t for t in name_norm.split() if t not in _STOPWORDS and len(t) > 2)


def _clean_alias(raw: str, name_norm: str, known_norms: set[str] | None = None) -> str | None:
    """Normalize and vet a single model-suggested alias. Returns None if unusable.

    ``known_norms`` are the normalized official/subsidiary names already known for this
    account from CRM (the customers table). AI aliases that merely restate one of those
    are dropped — subsidiaries are grounded in CRM data, so the model is reserved for
    informal forms (tickers, acronyms, nicknames) it can add on top."""
    alias = normalize(raw)
    if not alias:
        return None
    compact = alias.replace(" ", "")
    if len(compact) < 2 or len(alias) > 40:
        return None
    if alias in _STOPWORDS:
        return None
    if alias == name_norm:  # the exact name is stored separately as 'auto'
        return None
    if known_norms and alias in known_norms:  # already an official/subsidiary CRM name
        return None
    return alias


def _parse_batch_response(text: str) -> dict[str, list[str]]:
    """Extract {id: [aliases]} from the model's reply, tolerating stray text/fences."""
    s = (text or "").strip()
    start, end = s.find("{"), s.rfind("}")
    if start == -1 or end == -1 or end <= start:
        return {}
    try:
        obj = json.loads(s[start : end + 1])
    except (ValueError, TypeError):
        return {}
    out: dict[str, list[str]] = {}
    if isinstance(obj, dict):
        for k, v in obj.items():
            if isinstance(v, list):
                out[str(k)] = [str(x) for x in v if isinstance(x, (str, int))]
    return out


def _call_model(names: list[str], model: str) -> dict[str, list[str]] | None:
    """Ask the connected GitHub Copilot (Claude Haiku 4.5) for aliases for a batch of
    names. Returns None on any failure or when Copilot isn't wired — there is no
    `gh models` / gpt-4o-mini fallback."""
    if not fast_ai.copilot_available():
        return None
    numbered = "\n".join(f"{i + 1}: {n}" for i, n in enumerate(names))
    prompt = (
        "For each numbered company below, return the short INFORMAL aliases a colleague "
        "would type — that are NOT the company's official name or a subsidiary/brand "
        "name (we already have those from CRM). Rules:\n"
        "- only stock tickers, acronyms/initialisms, and common nicknames\n"
        "- lowercase; no legal suffixes (inc, llc, lp, ltd, corp, holdings)\n"
        "- no generic words (capital, group, financial, partners, the, and)\n"
        "- 0-4 aliases each; omit anything not distinctive\n"
        "- do NOT include the full legal name or a subsidiary/brand name\n"
        "Return ONLY a JSON object mapping each id (as a string) to an array of "
        "alias strings.\n\n"
        f"Companies:\n{numbered}"
    )
    text = fast_ai.copilot_chat(_SYSTEM_PROMPT, prompt, max_tokens=800)
    return _parse_batch_response(text) if text is not None else None


def _write_aliases(con: sqlite3.Connection, tpid: str, aliases: list[str]) -> None:
    for alias in aliases:
        con.execute(
            """INSERT INTO teams_customer_aliases(tpid, alias, source)
               VALUES(?,?, 'ai')
               ON CONFLICT(tpid, alias) DO NOTHING""",
            (tpid, alias),
        )


def refresh_ai_aliases(
    con: sqlite3.Connection,
    model: str = DEFAULT_MODEL,
    batch_size: int = DEFAULT_BATCH,
    max_new: int = DEFAULT_MAX_NEW,
) -> dict:
    """Ensure every synced customer name has (a) its exact-name alias and (b) AI-derived
    short aliases when a model is available. Returns a summary dict.
    """
    _ensure_cache(con)

    rows = con.execute(
        "SELECT DISTINCT tpid, name FROM active_customers "
        "WHERE tpid IS NOT NULL AND tpid <> '' AND name IS NOT NULL"
    ).fetchall()

    # (tpid, name_norm) -> original name, de-duplicated on the normalized form.
    wanted: dict[tuple[str, str], str] = {}
    # tpid -> {all normalized account names for that tpid, incl. child/subsidiary
    # accounts} so AI aliases that merely restate a known CRM name are dropped.
    known_by_tpid: dict[str, set[str]] = {}
    for r in rows:
        tpid = str(r["tpid"]).strip()
        name_norm = normalize(r["name"])
        if not tpid or not name_norm:
            continue
        known_by_tpid.setdefault(tpid, set()).add(name_norm)
        if not _meaningful(name_norm):
            continue
        wanted.setdefault((tpid, name_norm), r["name"])

    # Guaranteed fallback: the exact normalized name is always a usable alias.
    for (tpid, name_norm) in wanted:
        con.execute(
            """INSERT INTO teams_customer_aliases(tpid, alias, source)
               VALUES(?,?, 'auto')
               ON CONFLICT(tpid, alias) DO NOTHING""",
            (tpid, name_norm),
        )

    cached = {
        (str(r["tpid"]), str(r["name_norm"])): r["aliases"]
        for r in con.execute("SELECT tpid, name_norm, aliases FROM customer_alias_ai")
    }

    # The model id actually used for this run — the Copilot fast model (Claude Haiku
    # 4.5). Copilot is the only model; no gh-models fallback.
    eff_model = _effective_model(model)

    summary = {
        "customers": len(wanted),
        "from_cache": 0,
        "ai_generated": 0,
        "fallback": 0,
        "remaining": 0,
        "model": eff_model,
        "model_available": False,
        # True when Copilot was wired but its calls failed enough to stop AI generation
        # (circuit-breaker) — the desktop app treats this as a degraded-imports signal.
        "ai_error": False,
    }

    # Re-apply cached AI aliases (table may have been rebuilt / rows deactivated).
    to_generate: list[tuple[str, str]] = []
    for key in wanted:
        if key in cached:
            try:
                aliases = [a for a in json.loads(cached[key]) if isinstance(a, str)]
            except (ValueError, TypeError):
                aliases = []
            _write_aliases(con, key[0], aliases)
            summary["from_cache"] += 1
        else:
            to_generate.append(key)

    if not to_generate:
        con.commit()
        summary["model_available"] = model_available()
        return summary

    if not model_available():
        # No model: exact-name fallback already written above. Leave uncached so a
        # later run with a model available can still generate real aliases.
        con.commit()
        summary["fallback"] = len(to_generate)
        return summary

    summary["model_available"] = True
    batch = to_generate[:max_new]
    summary["remaining"] = len(to_generate) - len(batch)
    summary["fallback"] = summary["remaining"]

    consecutive_failures = 0
    i = 0
    while i < len(batch):
        chunk = batch[i : i + batch_size]
        names = [wanted[k] for k in chunk]
        result = _call_model(names, model)
        if result is None:
            # Transient failure: keep this chunk's exact-name fallback and leave it
            # uncached so the next run retries it, but DON'T discard batches we already
            # generated — just move on. Give up only if the model looks truly down.
            consecutive_failures += 1
            summary["fallback"] += len(chunk)
            i += batch_size
            if consecutive_failures >= _MAX_CONSECUTIVE_FAILURES:
                summary["fallback"] += len(batch) - i
                summary["model_available"] = summary["ai_generated"] > 0
                # Copilot was wired but its calls failed back-to-back — flag it so the
                # desktop app can surface a degraded-imports notice.
                summary["ai_error"] = True
                break
            continue
        consecutive_failures = 0
        for idx, key in enumerate(chunk):
            tpid, name_norm = key
            raw = result.get(str(idx + 1), [])
            known_norms = known_by_tpid.get(tpid, set())
            aliases: list[str] = []
            seen: set[str] = set()
            for a in raw:
                cleaned = _clean_alias(a, name_norm, known_norms)
                if cleaned and cleaned not in seen:
                    seen.add(cleaned)
                    aliases.append(cleaned)
                if len(aliases) >= 5:
                    break
            _write_aliases(con, tpid, aliases)
            con.execute(
                """INSERT INTO customer_alias_ai(tpid, name_norm, aliases, model)
                   VALUES(?,?,?,?)
                   ON CONFLICT(tpid, name_norm) DO UPDATE SET
                     aliases=excluded.aliases, model=excluded.model,
                     generated_at=CURRENT_TIMESTAMP""",
                (tpid, name_norm, json.dumps(aliases), eff_model),
            )
            summary["ai_generated"] += 1
        # Commit each successful batch so partial progress is durable even if a later
        # batch fails or the process is interrupted — this is what lets runs converge.
        con.commit()
        i += batch_size

    con.commit()
    return summary
