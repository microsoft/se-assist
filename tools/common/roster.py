"""The saved User Home roster is the only active account set."""
from __future__ import annotations

import sqlite3


def active_tpids(con: sqlite3.Connection) -> set[str]:
    return {str(row[0]) for row in con.execute("SELECT tpid FROM tpid_config")}


def require_active_tpid(con: sqlite3.Connection, tpid: str) -> None:
    if str(tpid) not in active_tpids(con):
        raise ValueError(f"Account {tpid} is archived. Re-add its TPID in User Home before working on it.")
