"""Contact-driven meeting association.

Recall expansion that does NOT rely on the customer's name appearing in the subject.
The signal is the *external* participants: if a person at the customer's domain (or a
known external contact address) organized or attended a meeting, that meeting is about
the customer — even when the subject never names them. Meeting attendee lists are an
especially strong signal because they carry customer-domain emails directly.

Internal Microsoft people are NEVER a customer-identity signal (the core SE/account team
is on every account). Only external customer-domain participants count.

Precision model (dominance-based), identical to tools/email/contacts.py:
  - Per external domain, compute the account it is most associated with.
  - Domain linking uses HIGH-dominance domains (share >= 0.9).
  - Address linking maps a specific external address to the dominant account of its
    domain (share >= 0.6).
"""
from __future__ import annotations

import json
import sqlite3
from collections import Counter, defaultdict

from tools.common import identity as identitymod
from tools.common import linking as linkingmod

_PARTNER_DOMAINS = {
    "cyclotron.com", "meetascent.com", "ascent.io", "insight.com", "cdw.com",
    "wwt.com", "slalom.com", "avanade.com", "accenture.com", "ey.com",
    "deloitte.com", "pwc.com", "kpmg.com",
}

_DOMAIN_MIN_SHARE = 0.90
_ADDR_MIN_SHARE = 0.60


def _domain(addr: str | None) -> str:
    a = (addr or "").lower().strip()
    return a.split("@", 1)[1] if "@" in a else ""


def _valid_external_domain(d: str) -> bool:
    if not d or "." not in d:
        return False
    if d.startswith("microsoft."):
        return False
    if len(d.rsplit(".", 1)[-1]) < 2:
        return False
    return d not in _PARTNER_DOMAINS


def _participant_addresses(row) -> list[str]:
    addrs: list[str] = []
    if row["organizer_address"]:
        addrs.append(row["organizer_address"].lower())
    try:
        for a in json.loads(row["attendees_json"] or "[]"):
            addr = (a.get("address") or "").lower()
            if addr:
                addrs.append(addr)
    except (ValueError, TypeError):
        pass
    return addrs


def _dominance(con: sqlite3.Connection):
    rows = con.execute(
        """SELECT l.tpid, m.organizer_address, m.attendees_json
           FROM active_meetings m JOIN active_meeting_customer_links l ON l.event_id = m.event_id"""
    ).fetchall()
    by_domain: dict[str, Counter] = defaultdict(Counter)
    by_addr: dict[str, Counter] = defaultdict(Counter)
    for r in rows:
        tpid = str(r["tpid"])
        for a in set(_participant_addresses(r)):
            d = _domain(a)
            if not _valid_external_domain(d):
                continue
            by_domain[d][tpid] += 1
            by_addr[a][tpid] += 1

    def reduce(counters):
        out = {}
        for k, cnt in counters.items():
            total = sum(cnt.values())
            tpid, n = cnt.most_common(1)[0]
            out[k] = (tpid, (n / total if total else 0.0), total)
        return out

    return reduce(by_domain), reduce(by_addr)


def domains_for_tpid(con: sqlite3.Connection, tpid: str) -> dict:
    dom_dom, addr_dom = _dominance(con)
    doms = sorted(d for d, (t, s, _n) in dom_dom.items() if t == tpid and s >= _DOMAIN_MIN_SHARE)
    contacts = sorted(
        a for a, (t, s, _n) in addr_dom.items()
        if t == tpid and s >= _ADDR_MIN_SHARE and _valid_external_domain(_domain(a))
    )
    return {"tpid": tpid, "domains": doms, "contacts": contacts}


def link_by_contacts(con: sqlite3.Connection, tpid: str | None = None) -> dict:
    """Link meetings whose participants include a high-dominance customer domain or a
    dominant external contact address. match_method='contact', confidence 0.9. Rebuilds
    all 'contact' links each run. Never touches alias/manual links."""
    if tpid is None:
        con.execute("DELETE FROM meeting_customer_links WHERE tpid IN (SELECT tpid FROM tpid_config) AND match_method='contact'")
    else:
        con.execute(
            "DELETE FROM meeting_customer_links WHERE tpid IN (SELECT tpid FROM tpid_config) AND match_method='contact' AND tpid=?",
            (tpid,),
        )

    dom_dom, addr_dom = _dominance(con)
    dom_map = {d: t for d, (t, s, _n) in dom_dom.items() if s >= _DOMAIN_MIN_SHARE}
    addr_map = {
        a: t for a, (t, s, _n) in addr_dom.items()
        if s >= _ADDR_MIN_SHARE and _valid_external_domain(_domain(a))
    }
    if tpid:
        dom_map = {d: t for d, t in dom_map.items() if t == tpid}
        addr_map = {a: t for a, t in addr_map.items() if t == tpid}

    rows = con.execute(
        "SELECT event_id, organizer_address, attendees_json FROM active_meetings"
    ).fetchall()
    linked = 0
    related = 0
    for r in rows:
        hits: dict[str, str] = {}
        for a in _participant_addresses(r):
            if a in addr_map:
                hits[addr_map[a]] = f"contact:{a}"
            d = _domain(a)
            if d in dom_map:
                hits.setdefault(dom_map[d], f"domain:{d}")
        if not hits:
            continue
        related += 1
        for t, reason in hits.items():
            cur = con.execute(
                "SELECT 1 FROM active_meeting_customer_links WHERE event_id=? AND tpid=?",
                (r["event_id"], t),
            ).fetchone()
            if cur is None:
                con.execute(
                    """INSERT INTO meeting_customer_links
                         (event_id, tpid, match_method, matched_term, confidence)
                       VALUES (?,?, 'contact', ?, 0.9)""",
                    (r["event_id"], t, reason),
                )
                linked += 1

    con.execute("UPDATE meetings SET is_customer_related=0")
    con.execute(
        """UPDATE meetings SET is_customer_related=1
           WHERE event_id IN (
             SELECT DISTINCT event_id FROM meeting_customer_links
             WHERE tpid IN (SELECT tpid FROM tpid_config) AND match_method <> 'ai-rejected')"""
    )
    con.commit()
    return {"related_meetings": related, "new_links": linked,
            "domains": len(dom_map), "contacts": len(addr_map)}


def link_by_identity(con: sqlite3.Connection, tpid: str | None = None) -> dict:
    """Identity-first linking for meetings: link a meeting to an account when the
    organizer/an attendee is an exact CRM contact of that account
    (``identity-contact``, strong) or sits on a domain that maps unambiguously to a
    single account's CRM contacts (``identity-domain``, medium).

    Derived directly from ``customer_contacts`` — authoritative, no bootstrap — and
    outranks name/alias matching. Rebuilds all identity rows each run; never
    downgrades a higher-ranked link."""
    linkingmod.ensure_link_schema(con)
    if tpid is None:
        con.execute(
            "DELETE FROM meeting_customer_links "
            "WHERE tpid IN (SELECT tpid FROM tpid_config) AND match_method IN ('identity-contact','identity-domain')"
        )
    else:
        con.execute(
            "DELETE FROM meeting_customer_links "
            "WHERE tpid IN (SELECT tpid FROM tpid_config) AND match_method IN ('identity-contact','identity-domain') AND tpid=?",
            (tpid,),
        )

    addr_map, domain_map = identitymod.contact_maps(con)
    if tpid:
        addr_map = {a: t for a, t in addr_map.items() if t == tpid}
        domain_map = {d: t for d, t in domain_map.items() if t == tpid}
    if not addr_map and not domain_map:
        con.commit()
        return {"related_meetings": 0, "new_links": 0, "contacts": 0, "domains": 0}

    src_map = linkingmod.alias_source_map(con)
    rows = con.execute(
        "SELECT event_id, organizer_address, attendees_json FROM active_meetings"
    ).fetchall()
    linked = 0
    related = 0
    for r in rows:
        hits: dict[str, tuple[str, str, float]] = {}
        for a in _participant_addresses(r):
            t = addr_map.get(a)
            if t:
                hits[t] = ("identity-contact", f"contact:{a}", 0.98)
                continue
            d = _domain(a)
            t = domain_map.get(d)
            if t and t not in hits:
                hits[t] = ("identity-domain", f"domain:{d}", 0.90)
        if not hits:
            continue
        related += 1
        for t, (method, term, conf) in hits.items():
            if _upsert_identity(con, r["event_id"], t, method, term, conf, src_map):
                linked += 1

    con.execute("UPDATE meetings SET is_customer_related=0")
    con.execute(
        """UPDATE meetings SET is_customer_related=1
           WHERE event_id IN (
             SELECT DISTINCT event_id FROM meeting_customer_links
             WHERE tpid IN (SELECT tpid FROM tpid_config) AND match_method <> 'ai-rejected')"""
    )
    con.commit()
    return {"related_meetings": related, "new_links": linked,
            "contacts": len(addr_map), "domains": len(domain_map)}


def _upsert_identity(con, event_id, tpid, method, term, conf, src_map) -> bool:
    """Insert/upgrade an identity link, honouring method precedence. Never overwrites a
    stronger link (e.g. manual, or identity-contact by identity-domain)."""
    new_rank = linkingmod.rank(method)
    cur = con.execute(
        "SELECT match_method, matched_term FROM active_meeting_customer_links "
        "WHERE event_id=? AND tpid=?",
        (event_id, tpid),
    ).fetchone()
    tier = linkingmod.tier_for(method)
    if cur is None:
        con.execute(
            """INSERT INTO meeting_customer_links
                 (event_id, tpid, match_method, matched_term, confidence, tier)
               VALUES (?,?,?,?,?,?)""",
            (event_id, tpid, method, term, conf, tier),
        )
        return True
    cur_src = src_map.get((str(tpid), cur["matched_term"] or "")) if cur["match_method"] == "alias" else None
    if new_rank > linkingmod.rank(cur["match_method"], cur_src):
        con.execute(
            """UPDATE meeting_customer_links
               SET match_method=?, matched_term=?, confidence=?, tier=?
               WHERE event_id=? AND tpid=?""",
            (method, term, conf, tier, event_id, tpid),
        )
    return False
