"""Account archive boundaries for Python ingestion and enrichment."""
import sqlite3

import pytest

from tools.teams import aliases
from tools.email import build_profile as email_profiles
from tools.meetings import build_profile as meeting_profiles
from tools.teams import build_profile as teams_profiles
from tools.account_team import build as account_team


@pytest.fixture
def con():
    db = sqlite3.connect(":memory:")
    db.row_factory = sqlite3.Row
    db.executescript(
        "CREATE TABLE tpid_config(tpid TEXT PRIMARY KEY);"
        "CREATE TABLE customers(tpid TEXT,name TEXT);"
        "CREATE VIEW active_customers AS SELECT * FROM customers WHERE tpid IN (SELECT tpid FROM tpid_config);"
        "CREATE TABLE teams_customer_aliases(tpid TEXT,alias TEXT,source TEXT,is_active INTEGER DEFAULT 1,PRIMARY KEY(tpid,alias));"
    )
    db.executemany("INSERT INTO customers VALUES(?,?)", [(str(1000 + i), f"Customer {i}") for i in range(260)])
    db.executemany("INSERT INTO tpid_config VALUES(?)", [(str(1000 + i),) for i in range(17)])
    yield db
    db.close()


def test_alias_enrichment_uses_only_saved_roster_and_preserves_archived_aliases(con):
    con.execute("INSERT INTO teams_customer_aliases VALUES('1017','historical alias','manual',1)")
    counts = aliases.build_alias_table(con)
    assert len(counts) == 17
    assert len(aliases.known_tpids(con)) == 17
    assert all(tpid != "1017" for tpid, _alias in aliases.load_aliases(con))
    assert con.execute("SELECT is_active FROM teams_customer_aliases WHERE tpid='1017'").fetchone()[0] == 1
    con.execute("DELETE FROM tpid_config")
    assert aliases.build_alias_table(con) == {}
    assert aliases.known_tpids(con) == []
    assert aliases.load_aliases(con) == []
    con.execute("INSERT INTO tpid_config VALUES('1017')")
    assert ("1017", "historical alias") in aliases.load_aliases(con)


def test_public_source_has_no_bundled_customer_alias_records():
    assert aliases.CURATED == {}


def test_alias_enrichment_derives_customer_names_and_preserves_local_aliases(con):
    con.executemany(
        "INSERT INTO teams_customer_aliases VALUES('1000',?,?,1)",
        [("local account alias", "curated"), ("manual account alias", "manual")],
    )
    counts = aliases.build_alias_table(con)
    assert counts["1000"] == 3
    assert ("1000", "customer 0") in aliases.load_aliases(con)
    assert ("1000", "local account alias") in aliases.load_aliases(con)
    assert ("1000", "manual account alias") in aliases.load_aliases(con)
    matcher = aliases.build_matcher(con)
    assert matcher.match(aliases.normalize("Meeting with Customer 0")) == {"1000": "customer 0"}


@pytest.mark.parametrize("build", [email_profiles.build_profile, meeting_profiles.build_profile, teams_profiles.build_profile])
def test_per_account_profile_writes_reject_archived_accounts_before_processing(con, build):
    with pytest.raises(ValueError, match="archived"):
        build(con, "1017")


def test_account_team_rebuild_rejects_archived_account_before_deleting_its_history(con):
    with pytest.raises(ValueError, match="archived"):
        account_team.build_for_tpid(con, "1017", {}, {})
