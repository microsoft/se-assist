"""Build the per-account people graph from the Teams + email datastores.

For each TPID we aggregate everyone who appears in that account's customer-linked
Teams chats and emails, classify them, and write `customer_account_team`:

  org classification
  ------------------
  - email participants are classified by their address domain:
      @microsoft.com         -> 'microsoft'  (the internal v-team)
      a known customer domain -> 'customer'
      any other external      -> 'partner'
  - Teams senders (names only, no domain) are matched against the GLOBAL email
    identity roster (built from every customer-linked email across all accounts):
      name matches a microsoft.com identity -> 'microsoft'
      name matches a customer/partner identity -> that org
      no match -> 'unverified' (likely internal v-team, but unconfirmed)

The headline deliverable is org='microsoft' — the internal Microsoft team members
associated with each account.
"""
from __future__ import annotations

import json
import re
import sqlite3
from collections import defaultdict

from tools.teams import aliases as aliasmod
from tools.common.roster import require_active_tpid

_MS_DOMAIN = "microsoft.com"


def _norm_name(name: str | None) -> str:
    """Normalize 'Gerch, Nick' and 'Nick Gerch' to the same key (sorted tokens)."""
    s = (name or "").lower().replace(",", " ")
    toks = [t for t in re.sub(r"[^a-z ]", " ", s).split() if len(t) > 1]
    return " ".join(sorted(toks))


def _clean_display(name: str | None) -> str:
    """Prefer 'First Last' display; flip 'Last, First' -> 'First Last'."""
    s = (name or "").strip()
    if "," in s:
        parts = [p.strip() for p in s.split(",", 1)]
        if len(parts) == 2 and parts[0] and parts[1]:
            return f"{parts[1]} {parts[0]}"
    return s


def _domain(addr: str | None) -> str:
    a = (addr or "").lower().strip()
    return a.split("@", 1)[1] if "@" in a else ""


def _customer_domains(con: sqlite3.Connection) -> dict[str, str]:
    """Map an external email domain -> tpid, from customer-linked emails (non-Microsoft)."""
    out: dict[str, str] = {}
    rows = con.execute(
        """SELECT DISTINCT l.tpid, e.from_address
           FROM active_emails e JOIN active_email_customer_links l ON l.message_id = e.message_id
           WHERE e.from_address IS NOT NULL"""
    ).fetchall()
    counts: dict[tuple[str, str], int] = defaultdict(int)
    for r in rows:
        d = _domain(r["from_address"])
        if d and d != _MS_DOMAIN:
            counts[(d, str(r["tpid"]))] += 1
    # assign each domain to the tpid it appears with most (handles stray cross-posts)
    best: dict[str, tuple[str, int]] = {}
    for (d, tpid), n in counts.items():
        if d not in best or n > best[d][1]:
            best[d] = (tpid, n)
    return {d: tpid for d, (tpid, _n) in best.items()}


def _global_roster(con: sqlite3.Connection):
    """Build name-key -> (org, email, display) from every customer-linked email
    participant (sender + to + cc). org is microsoft|customer|partner."""
    cust_dom = _customer_domains(con)
    roster: dict[str, dict] = {}

    def consider(name, addr):
        d = _domain(addr)
        if not d:
            return
        org = "microsoft" if d == _MS_DOMAIN else ("customer" if d in cust_dom else "partner")
        nk = _norm_name(name)
        if not nk:
            return
        cur = roster.get(nk)
        # microsoft identity wins; otherwise first seen
        if cur is None or (org == "microsoft" and cur["org"] != "microsoft"):
            roster[nk] = {"org": org, "email": (addr or "").lower(), "display": _clean_display(name)}

    rows = con.execute(
        """SELECT DISTINCT e.from_name, e.from_address, e.to_json, e.cc_json
           FROM active_emails e JOIN active_email_customer_links l ON l.message_id = e.message_id"""
    ).fetchall()
    for r in rows:
        consider(r["from_name"], r["from_address"])
        for fld in ("to_json", "cc_json"):
            try:
                for p in json.loads(r[fld] or "[]"):
                    consider(p.get("name"), p.get("address"))
            except (ValueError, TypeError):
                pass
    return roster, cust_dom


def _max(a, b):
    if not a:
        return b
    if not b:
        return a
    return a if a > b else b


def build_for_tpid(con: sqlite3.Connection, tpid: str, roster: dict, cust_dom: dict) -> int:
    require_active_tpid(con, tpid)
    # person key = normalized name; aggregate across email + teams
    people: dict[str, dict] = {}

    def get(name):
        nk = _norm_name(name)
        if not nk:
            return None
        p = people.get(nk)
        if p is None:
            p = {
                "name": _clean_display(name), "email": None, "org": None,
                "email_sends": 0, "email_cc": 0, "teams_msgs": 0, "last": None,
                "sources": set(),
            }
            people[nk] = p
        return p

    # ---- Email participants on this account ----
    emails = con.execute(
        """SELECT e.from_name, e.from_address, e.to_json, e.cc_json, e.received_at
           FROM active_emails e JOIN active_email_customer_links l ON l.message_id = e.message_id
           WHERE l.tpid = ?""",
        (tpid,),
    ).fetchall()
    for e in emails:
        sender = get(e["from_name"])
        if sender:
            sender["email_sends"] += 1
            sender["sources"].add("email")
            sender["last"] = _max(sender["last"], e["received_at"])
            _apply_email_org(sender, e["from_address"], cust_dom)
        for fld in ("to_json", "cc_json"):
            try:
                for pr in json.loads(e[fld] or "[]"):
                    p = get(pr.get("name"))
                    if not p:
                        continue
                    p["email_cc"] += 1
                    p["sources"].add("email")
                    p["last"] = _max(p["last"], e["received_at"])
                    _apply_email_org(p, pr.get("address"), cust_dom)
            except (ValueError, TypeError):
                pass

    # ---- Teams senders on this account ----
    chats = con.execute(
        """SELECT m.sender_name, m.sent_at
           FROM active_teams_chat_messages m
           JOIN active_teams_chat_customer_links l ON l.chat_id = m.chat_id
           WHERE l.tpid = ? AND m.sender_name IS NOT NULL""",
        (tpid,),
    ).fetchall()
    for t in chats:
        p = get(t["sender_name"])
        if not p:
            continue
        p["teams_msgs"] += 1
        p["sources"].add("teams")
        p["last"] = _max(p["last"], t["sent_at"])
        if p["org"] is None:
            nk = _norm_name(t["sender_name"])
            hit = roster.get(nk)
            p["org"] = hit["org"] if hit else "unverified"
            if hit and not p["email"]:
                p["email"] = hit["email"]

    # finalize org defaults
    for p in people.values():
        if p["org"] is None:
            p["org"] = "unverified"

    con.execute("DELETE FROM customer_account_team WHERE tpid = ?", (tpid,))
    for p in people.values():
        engagement = p["email_sends"] * 3 + p["teams_msgs"] + p["email_cc"]
        con.execute(
            """INSERT INTO customer_account_team
                 (tpid, person_name, person_email, org, email_sends, email_cc,
                  teams_msgs, last_activity, sources, engagement)
               VALUES (?,?,?,?,?,?,?,?,?,?)
               ON CONFLICT(tpid, person_name) DO UPDATE SET
                 person_email=excluded.person_email, org=excluded.org,
                 email_sends=excluded.email_sends, email_cc=excluded.email_cc,
                 teams_msgs=excluded.teams_msgs, last_activity=excluded.last_activity,
                 sources=excluded.sources, engagement=excluded.engagement""",
            (
                tpid, p["name"], p["email"], p["org"], p["email_sends"], p["email_cc"],
                p["teams_msgs"], p["last"], ",".join(sorted(p["sources"])), engagement,
            ),
        )
    con.commit()
    return len(people)


def _apply_email_org(person: dict, addr: str | None, cust_dom: dict) -> None:
    d = _domain(addr)
    if not d:
        return
    org = "microsoft" if d == _MS_DOMAIN else ("customer" if d in cust_dom else "partner")
    # microsoft identity is authoritative; otherwise set if unknown
    if person["org"] is None or (org == "microsoft" and person["org"] != "microsoft"):
        person["org"] = org
    if not person["email"] and addr:
        person["email"] = addr.lower()


def build_all(con: sqlite3.Connection) -> list[dict]:
    roster, cust_dom = _global_roster(con)
    tpids = [
        str(r["tpid"])
        for r in con.execute(
            """SELECT tpid FROM active_teams_chat_customer_links
               UNION SELECT tpid FROM active_email_customer_links"""
        )
    ]
    tpids = sorted(set(tpids))
    out = []
    for t in tpids:
        n = build_for_tpid(con, t, roster, cust_dom)
        ms = con.execute(
            "SELECT COUNT(*) n FROM active_customer_account_team WHERE tpid=? AND org='microsoft'",
            (t,),
        ).fetchone()["n"]
        out.append({"tpid": t, "display_name": aliasmod.display_name_for(t), "people": n, "microsoft": ms})
    return out
