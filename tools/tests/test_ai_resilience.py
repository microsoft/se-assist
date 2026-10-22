"""Resilience tests for the ingestion AI steps.

These lock in the fix for the "pull new items takes 15 minutes every time" bug: a
single transient model failure used to `break` the whole run and cache nothing, so
every ingestion redid all the work from scratch. The alias/verify passes must now
skip a transient failure, persist what already succeeded, and converge across runs.
"""
import sqlite3

import pytest

from tools.teams import ai_aliases
from tools.common import ai_classify


def _mem_db():
    con = sqlite3.connect(":memory:")
    con.row_factory = sqlite3.Row
    con.execute("CREATE TABLE customers (tpid TEXT, name TEXT)")
    con.execute("CREATE TABLE tpid_config (tpid TEXT PRIMARY KEY)")
    con.execute("CREATE VIEW active_customers AS SELECT * FROM customers WHERE tpid IN (SELECT tpid FROM tpid_config)")
    con.execute(
        "CREATE TABLE teams_customer_aliases ("
        " tpid TEXT NOT NULL, alias TEXT NOT NULL, source TEXT,"
        " is_active INTEGER NOT NULL DEFAULT 1, PRIMARY KEY (tpid, alias))"
    )
    return con


def _seed(con, names):
    for tpid, name in names:
        con.execute("INSERT INTO customers(tpid, name) VALUES(?,?)", (tpid, name))
        con.execute("INSERT OR IGNORE INTO tpid_config(tpid) VALUES(?)", (tpid,))
    con.commit()


@pytest.fixture(autouse=True)
def _model_is_available(monkeypatch):
    """Alias tests monkeypatch _call_model, so treat a model as available regardless of
    whether `gh`/Copilot happen to be reachable in the test environment."""
    monkeypatch.setattr(ai_aliases, "model_available", lambda: True)
    monkeypatch.setattr(ai_aliases.fast_ai, "fast_model_label", lambda: None)


def test_alias_partial_failure_still_caches(monkeypatch):
    """One failing batch must not discard batches that already succeeded."""
    con = _mem_db()
    _seed(con, [("t1", "Alpha Inc"), ("t2", "Beta LLC"), ("t3", "Gamma Corp")])

    calls = {"n": 0}

    def fake_call(names, model):
        calls["n"] += 1
        if calls["n"] == 1:
            return None  # transient failure on the very first batch
        return {"1": ["nick"]}  # batch_size=1 -> single id "1"

    monkeypatch.setattr(ai_aliases, "_call_model", fake_call)

    summary = ai_aliases.refresh_ai_aliases(con, batch_size=1, max_new=10)

    cached = con.execute("SELECT COUNT(*) FROM customer_alias_ai").fetchone()[0]
    assert cached == 2, "successful batches must persist despite an earlier failure"
    assert summary["ai_generated"] == 2
    assert summary["fallback"] == 1
    assert summary["model_available"] is True


def test_alias_circuit_breaker_stops_after_consecutive_failures(monkeypatch):
    """A truly-down model gives up after N consecutive failures, not after every name."""
    con = _mem_db()
    distinctive = [
        "Contoso", "Fabrikam", "Northwind Traders", "Adventure Works",
        "Tailspin Toys", "Wingtip Retail", "Litware", "Proseware",
        "Wide World Importers", "Coho Vineyard",
    ]
    _seed(con, [(f"t{i}", nm) for i, nm in enumerate(distinctive)])

    calls = {"n": 0}

    def always_fail(names, model):
        calls["n"] += 1
        return None

    monkeypatch.setattr(ai_aliases, "_call_model", always_fail)

    summary = ai_aliases.refresh_ai_aliases(con, batch_size=1, max_new=10)

    assert calls["n"] == ai_aliases._MAX_CONSECUTIVE_FAILURES
    assert summary["ai_generated"] == 0
    assert summary["ai_error"] is True  # feeds the desktop degraded-imports notice
    assert con.execute("SELECT COUNT(*) FROM customer_alias_ai").fetchone()[0] == 0


def test_alias_second_run_uses_cache(monkeypatch):
    """After a good run, a second run hits the cache and never calls the model again —
    this is what makes 'Pull new items' fast instead of redoing everything."""
    con = _mem_db()
    _seed(con, [("t1", "Alpha Inc"), ("t2", "Beta LLC")])

    calls = {"n": 0}

    def ok(names, model):
        calls["n"] += 1
        return {str(i + 1): ["nick"] for i in range(len(names))}

    monkeypatch.setattr(ai_aliases, "_call_model", ok)

    first = ai_aliases.refresh_ai_aliases(con, batch_size=20, max_new=10)
    assert first["ai_generated"] == 2
    calls_after_first = calls["n"]
    assert calls_after_first >= 1

    second = ai_aliases.refresh_ai_aliases(con, batch_size=20, max_new=10)
    assert second["from_cache"] == 2
    assert second["ai_generated"] == 0
    assert calls["n"] == calls_after_first, "cached run must not call the model"


def test_weak_cap_env_override(monkeypatch):
    """SEASSIST_WEAK_CAP lets the orchestrator make incremental runs lighter."""
    monkeypatch.delenv("SEASSIST_WEAK_CAP", raising=False)
    assert ai_classify._resolve_cap(None) == ai_classify.DEFAULT_CAP
    assert ai_classify._resolve_cap(7) == 7  # explicit arg wins

    monkeypatch.setenv("SEASSIST_WEAK_CAP", "42")
    assert ai_classify._resolve_cap(None) == 42
    assert ai_classify._resolve_cap(5) == 5  # explicit arg still wins over env

    monkeypatch.setenv("SEASSIST_WEAK_CAP", "not-a-number")
    assert ai_classify._resolve_cap(None) == ai_classify.DEFAULT_CAP


if __name__ == "__main__":
    raise SystemExit(pytest.main([__file__, "-v"]))
