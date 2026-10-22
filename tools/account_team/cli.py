"""CLI for the per-account people graph (internal Microsoft team + contacts).

  python -m tools.account_team.cli build        # (re)build for all accounts
  python -m tools.account_team.cli show <tpid>  # print the team for one account
  python -m tools.account_team.cli report       # internal-team size per account
"""
from __future__ import annotations

import argparse
import sqlite3
import sys

from tools.email import db as dbmod  # reuse the same db connector + pragmas
from . import build as buildmod
from tools.teams import aliases as aliasmod

# customer_account_team mirror (in case the migration hasn't been applied yet).
SCHEMA = """
CREATE TABLE IF NOT EXISTS customer_account_team (
  tpid TEXT NOT NULL,
  person_name TEXT NOT NULL,
  person_email TEXT,
  org TEXT NOT NULL DEFAULT 'unverified',
  email_sends INTEGER NOT NULL DEFAULT 0,
  email_cc INTEGER NOT NULL DEFAULT 0,
  teams_msgs INTEGER NOT NULL DEFAULT 0,
  last_activity TEXT,
  sources TEXT NOT NULL DEFAULT '',
  engagement INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (tpid, person_name)
);
CREATE INDEX IF NOT EXISTS idx_account_team_tpid ON customer_account_team(tpid, org, engagement DESC);
"""

try:
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")
except Exception:
    pass


def _con(args) -> sqlite3.Connection:
    con = dbmod.connect(getattr(args, "db", None))
    con.executescript(SCHEMA)
    con.commit()
    return con


def cmd_build(args):
    con = _con(args)
    for r in buildmod.build_all(con):
        print(f"  {r['display_name']:<30}: {r['people']:>3} people · {r['microsoft']:>2} Microsoft")


def cmd_show(args):
    con = _con(args)
    rows = con.execute(
        """SELECT person_name, person_email, org, email_sends, email_cc, teams_msgs,
                  last_activity, sources, engagement
           FROM active_customer_account_team WHERE tpid=?
           ORDER BY (org='microsoft') DESC, engagement DESC""",
        (args.tpid,),
    ).fetchall()
    print(f"Account team for {aliasmod.display_name_for(args.tpid)} (tpid {args.tpid}):")
    cur = None
    for r in rows:
        if args.org and r["org"] != args.org:
            continue
        if r["org"] != cur:
            cur = r["org"]
            print(f"\n[{cur.upper()}]")
        em = f" <{r['person_email']}>" if r["person_email"] else ""
        print(f"  {r['person_name']:<26}{em:<34} "
              f"email:{r['email_sends']}/cc:{r['email_cc']} teams:{r['teams_msgs']} "
              f"· last {(r['last_activity'] or '')[:10]} [{r['sources']}]")


def cmd_report(args):
    con = _con(args)
    rows = con.execute(
        """SELECT tpid,
                  SUM(org='microsoft') ms,
                  SUM(org='customer') cust,
                  SUM(org='partner') partner,
                  SUM(org='unverified') unv,
                  COUNT(*) total
           FROM active_customer_account_team GROUP BY tpid ORDER BY ms DESC"""
    ).fetchall()
    print(f"{'Account':<30} {'MSFT':>4} {'Cust':>4} {'Prtnr':>5} {'Unv':>4} {'Total':>5}")
    for r in rows:
        print(f"{aliasmod.display_name_for(str(r['tpid'])):<30} {r['ms']:>4} {r['cust']:>4} "
              f"{r['partner']:>5} {r['unv']:>4} {r['total']:>5}")


def main(argv=None):
    p = argparse.ArgumentParser(prog="tools.account_team.cli")
    p.add_argument("--db")
    sub = p.add_subparsers(dest="cmd", required=True)
    sub.add_parser("build").set_defaults(func=cmd_build)
    s = sub.add_parser("show"); s.add_argument("tpid"); s.add_argument("--org"); s.set_defaults(func=cmd_show)
    sub.add_parser("report").set_defaults(func=cmd_report)
    args = p.parse_args(argv)
    args.func(args)


if __name__ == "__main__":
    main()
