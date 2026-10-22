"""Shared SQLite access for the tools/* pipelines.

Every pipeline opens the same live seassist.db with the same pragmas and resolves
its path the same way; only the schema differs. Those common pieces live here.
Each domain's db.py keeps its own SCHEMA_SQL (and any backfill) and calls
ensure_schema() with it.
"""
from __future__ import annotations

import os
import sqlite3
from pathlib import Path


def default_db_path() -> Path:
    """Return the live Electron app database path.

    Honours SEASSIST_DB, then the Windows APPDATA location the desktop app uses,
    then a home-dir fallback for non-Windows dev environments.
    """
    env = os.environ.get("SEASSIST_DB")
    if env:
        return Path(env)
    appdata = os.environ.get("APPDATA")
    if appdata:
        return Path(appdata) / "se-assist" / "seassist.db"
    return Path.home() / ".se-assist" / "seassist.db"


def connect(db_path: str | os.PathLike | None = None) -> sqlite3.Connection:
    """Open seassist.db with pragmas tuned for concurrent access with the app."""
    path = Path(db_path) if db_path else default_db_path()
    if not path.exists():
        raise FileNotFoundError(
            f"seassist.db not found at {path}. Set SEASSIST_DB or pass --db."
        )
    con = sqlite3.connect(str(path), timeout=30)
    con.row_factory = sqlite3.Row
    con.execute("PRAGMA journal_mode = WAL")
    con.execute("PRAGMA foreign_keys = ON")
    con.execute("PRAGMA busy_timeout = 30000")
    return con


def ensure_schema(con: sqlite3.Connection, schema_sql: str, *extra_sql: str) -> None:
    """Apply a domain's schema (idempotent), plus any extra scripts (e.g. backfills)."""
    con.executescript(schema_sql)
    for extra in extra_sql:
        if extra:
            con.executescript(extra)
    con.commit()
