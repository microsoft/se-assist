"""Tests for the fast-model adapter (Claude Haiku 4.5 via the Copilot API) used by the
lightweight ingestion AI steps. The connected GitHub Copilot is the ONLY model — there
is no `gh models` / gpt-4o-mini fallback; when Copilot is absent the steps degrade to
the deterministic exact-name baseline."""
import json

import pytest

from tools.common import fast_ai
from tools.common import ai_classify
from tools.teams import ai_aliases


COPILOT_ENV = {
    "SEASSIST_COPILOT_TOKEN": "tok-123",
    "SEASSIST_COPILOT_API": "https://api.githubcopilot.com/",
    "SEASSIST_FAST_MODEL": "claude-haiku-4.5",
}


def _set_copilot(monkeypatch, **overrides):
    env = {**COPILOT_ENV, **overrides}
    for k in ("SEASSIST_COPILOT_TOKEN", "SEASSIST_COPILOT_API", "SEASSIST_FAST_MODEL"):
        if env.get(k) is None:
            monkeypatch.delenv(k, raising=False)
        else:
            monkeypatch.setenv(k, env[k])


def test_config_absent_without_env(monkeypatch):
    for k in ("SEASSIST_COPILOT_TOKEN", "SEASSIST_COPILOT_API", "SEASSIST_FAST_MODEL"):
        monkeypatch.delenv(k, raising=False)
    assert fast_ai.copilot_config() is None
    assert fast_ai.copilot_available() is False
    assert fast_ai.fast_model_label() is None
    # With no config, a call short-circuits to None. There is no fallback model.
    assert fast_ai.copilot_chat("s", "u", max_tokens=10) is None


def test_config_present_trims_and_defaults(monkeypatch):
    _set_copilot(monkeypatch, SEASSIST_FAST_MODEL=None)
    token, api, model = fast_ai.copilot_config()
    assert token == "tok-123"
    assert api == "https://api.githubcopilot.com"  # trailing slash stripped
    assert model == fast_ai.DEFAULT_FAST_MODEL == "claude-haiku-4.5"
    assert fast_ai.fast_model_label() == "claude-haiku-4.5"


def test_copilot_chat_success(monkeypatch):
    _set_copilot(monkeypatch)
    captured = {}

    def fake_post(api, token, body):
        captured["api"] = api
        captured["token"] = token
        captured["body"] = body
        payload = {"choices": [{"message": {"content": "  hello  "}}]}
        return 200, json.dumps(payload)

    monkeypatch.setattr(fast_ai, "_post", fake_post)
    out = fast_ai.copilot_chat("sys", "user", max_tokens=42, temperature=0.0)
    assert out == "hello"
    assert captured["token"] == "tok-123"
    assert captured["body"]["model"] == "claude-haiku-4.5"
    assert captured["body"]["max_tokens"] == 42
    assert captured["body"]["messages"][0]["role"] == "system"


def test_copilot_chat_non_200_returns_none(monkeypatch):
    _set_copilot(monkeypatch)
    monkeypatch.setattr(fast_ai, "_post", lambda *a: (500, "boom"))
    assert fast_ai.copilot_chat("s", "u", max_tokens=10) is None


def test_copilot_chat_adapts_to_temperature_400(monkeypatch):
    _set_copilot(monkeypatch)
    calls = []

    def fake_post(api, token, body):
        calls.append(dict(body))
        if len(calls) == 1:
            return 400, "Unsupported value: 'temperature' is not supported."
        return 200, json.dumps({"choices": [{"message": {"content": "ok"}}]})

    monkeypatch.setattr(fast_ai, "_post", fake_post)
    out = fast_ai.copilot_chat("s", "u", max_tokens=10, temperature=0.0)
    assert out == "ok"
    assert "temperature" in calls[0]
    assert "temperature" not in calls[1]  # dropped on retry


def test_copilot_chat_adapts_max_tokens_400(monkeypatch):
    _set_copilot(monkeypatch)
    calls = []

    def fake_post(api, token, body):
        calls.append(dict(body))
        if len(calls) == 1:
            return 400, "Use 'max_completion_tokens' instead of 'max_tokens'."
        return 200, json.dumps({"choices": [{"message": {"content": "ok"}}]})

    monkeypatch.setattr(fast_ai, "_post", fake_post)
    assert fast_ai.copilot_chat("s", "u", max_tokens=10) == "ok"
    assert "max_completion_tokens" in calls[1]
    assert "max_tokens" not in calls[1]


def test_aliases_use_copilot(monkeypatch):
    """When Copilot is wired, _call_model routes through the Copilot API."""
    _set_copilot(monkeypatch)
    monkeypatch.setattr(
        fast_ai, "copilot_chat",
        lambda system, user, **kw: json.dumps({"1": ["acme"]}),
    )
    out = ai_aliases._call_model(["Acme Corporation"], ai_aliases.DEFAULT_MODEL)
    assert out == {"1": ["acme"]}


def test_aliases_no_copilot_returns_none(monkeypatch):
    """No Copilot env → _call_model returns None (no gh fallback) and model_available
    is False, so the run degrades to the exact-name baseline."""
    for k in ("SEASSIST_COPILOT_TOKEN", "SEASSIST_COPILOT_API"):
        monkeypatch.delenv(k, raising=False)
    assert ai_aliases.model_available() is False
    assert ai_aliases._call_model(["Acme"], ai_aliases.DEFAULT_MODEL) is None


def test_aliases_copilot_failure_returns_none(monkeypatch):
    """A Copilot miss returns None (transient) — NOT an empty dict that would cache junk."""
    _set_copilot(monkeypatch)
    monkeypatch.setattr(fast_ai, "copilot_chat", lambda *a, **k: None)
    assert ai_aliases._call_model(["Acme"], ai_aliases.DEFAULT_MODEL) is None


def test_classifier_uses_copilot(monkeypatch):
    _set_copilot(monkeypatch)
    monkeypatch.setattr(
        fast_ai, "copilot_chat",
        lambda system, user, **kw: json.dumps({"related": True, "confidence": 0.9}),
    )
    fn = ai_classify._classifier(ai_classify.DEFAULT_MODEL)
    assert fn is not None
    assert fn("prompt") == (True, 0.9)


def test_classifier_none_when_no_copilot(monkeypatch):
    """No Copilot env → no classifier at all (there is no gh fallback)."""
    for k in ("SEASSIST_COPILOT_TOKEN", "SEASSIST_COPILOT_API"):
        monkeypatch.delenv(k, raising=False)
    assert ai_classify._classifier("m") is None


def test_full_alias_run_via_copilot(monkeypatch):
    """End-to-end: with Copilot wired, refresh_ai_aliases generates + caches aliases
    and records the Copilot fast model."""
    import sqlite3

    _set_copilot(monkeypatch)
    monkeypatch.setattr(
        fast_ai, "copilot_chat",
        lambda system, user, **kw: json.dumps({"1": ["acme"], "2": ["nw"]}),
    )

    con = sqlite3.connect(":memory:")
    con.row_factory = sqlite3.Row
    con.execute("CREATE TABLE customers (tpid TEXT, name TEXT)")
    con.execute(
        "CREATE TABLE teams_customer_aliases (tpid TEXT NOT NULL, alias TEXT NOT NULL,"
        " source TEXT, is_active INTEGER NOT NULL DEFAULT 1, PRIMARY KEY (tpid, alias))"
    )
    con.execute("INSERT INTO customers VALUES('t1','Acme Corporation')")
    con.execute("INSERT INTO customers VALUES('t2','Northwind Traders')")
    con.executescript("CREATE TABLE tpid_config(tpid TEXT PRIMARY KEY); INSERT INTO tpid_config VALUES('t1'),('t2'); "
                      "CREATE VIEW active_customers AS SELECT * FROM customers WHERE tpid IN (SELECT tpid FROM tpid_config);")
    con.commit()

    summary = ai_aliases.refresh_ai_aliases(con, batch_size=20, max_new=10)
    assert summary["model_available"] is True
    assert summary["model"] == "claude-haiku-4.5"
    assert summary["ai_generated"] == 2
    assert summary["ai_error"] is False
    rows = con.execute("SELECT model FROM customer_alias_ai").fetchall()
    assert rows and all(r["model"] == "claude-haiku-4.5" for r in rows)


def test_alias_run_degrades_without_copilot(monkeypatch):
    """No Copilot → exact-name baseline still written, model_available False, and the
    names stay uncached (fallback) so a later connected run can generate real aliases."""
    import sqlite3

    for k in ("SEASSIST_COPILOT_TOKEN", "SEASSIST_COPILOT_API"):
        monkeypatch.delenv(k, raising=False)

    con = sqlite3.connect(":memory:")
    con.row_factory = sqlite3.Row
    con.execute("CREATE TABLE customers (tpid TEXT, name TEXT)")
    con.execute(
        "CREATE TABLE teams_customer_aliases (tpid TEXT NOT NULL, alias TEXT NOT NULL,"
        " source TEXT, is_active INTEGER NOT NULL DEFAULT 1, PRIMARY KEY (tpid, alias))"
    )
    con.execute("INSERT INTO customers VALUES('t1','Acme Corporation')")
    con.executescript("CREATE TABLE tpid_config(tpid TEXT PRIMARY KEY); INSERT INTO tpid_config VALUES('t1'); "
                      "CREATE VIEW active_customers AS SELECT * FROM customers WHERE tpid IN (SELECT tpid FROM tpid_config);")
    con.commit()

    summary = ai_aliases.refresh_ai_aliases(con, batch_size=20, max_new=10)
    assert summary["model_available"] is False
    assert summary["ai_generated"] == 0
    assert summary["fallback"] == 1
    # The exact normalized name is written as an 'auto' alias regardless of AI.
    autos = con.execute(
        "SELECT alias FROM teams_customer_aliases WHERE tpid='t1' AND source='auto'"
    ).fetchall()
    assert autos, "exact-name baseline alias must still be written when degraded"


if __name__ == "__main__":
    raise SystemExit(pytest.main([__file__, "-v"]))
