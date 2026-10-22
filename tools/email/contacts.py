"""Contact-driven email association.

Recall expansion that does NOT rely on the customer's name appearing in an email.
The signal is the *external* participants: if a person at the customer's domain (or a
known external contact address) is on an email (from / to / cc), that email is about the
customer — even when the body never names them.

Internal Microsoft people are NEVER a customer-identity signal. Some internal users
(e.g. the core SE/account team) are on every account, so using them to associate emails
would cross-contaminate all accounts. Only external customer-domain participants count.

Precision model (dominance-based):
  - Per external domain, compute the account it is most associated with (the share of
    that domain's participant-appearances that fall on each account's linked emails).
  - **Domain linking** uses only HIGH-dominance domains (share >= 0.9) — unambiguous
    customer domains like contoso.com / fabrikam.com. Genuinely shared SI/partner domains
    (cyclotron.com, meetascent.com) and microsoft.* are excluded outright.
  - **Address linking** maps a specific external address to the dominant account of its
    domain (share >= 0.6). An exact address (e.g. customer.user@example.com) is
    precise even when the domain isn't dominant enough for blanket domain linking.
"""
from __future__ import annotations

import json
import sqlite3
from collections import Counter, defaultdict

from tools.common import identity as identitymod
from tools.common import linking as linkingmod

# Partner / SI / aggregator domains that are never a customer-identity signal.
_PARTNER_DOMAINS = {
    "cyclotron.com", "meetascent.com", "ascent.io", "insight.com", "cdw.com",
    "wwt.com", "slalom.com", "avanade.com", "accenture.com", "ey.com",
    "deloitte.com", "pwc.com", "kpmg.com",
}

_DOMAIN_MIN_SHARE = 0.90   # blanket domain linking
_ADDR_MIN_SHARE = 0.60     # exact-address linking (the address itself is specific)


def _domain(addr: str | None) -> str:
    a = (addr or "").lower().strip()
    return a.split("@", 1)[1] if "@" in a else ""


def _valid_external_domain(d: str) -> bool:
    """An external, non-partner domain that can identify a customer. microsoft.* (incl.
    the malformed 'microsoft.c') is excluded, so internal people never count."""
    if not d or "." not in d:
        return False
    if d.startswith("microsoft."):
        return False
    if len(d.rsplit(".", 1)[-1]) < 2:
        return False
    return d not in _PARTNER_DOMAINS


def _participant_addresses(row) -> list[str]:
    addrs: list[str] = []
    if row["from_address"]:
        addrs.append(row["from_address"].lower())
    for fld in ("to_json", "cc_json"):
        try:
            for p in json.loads(row[fld] or "[]"):
                a = (p.get("address") or "").lower()
                if a:
                    addrs.append(a)
        except (ValueError, TypeError):
            pass
    return addrs


def _dominance(con: sqlite3.Connection):
    """Per valid external domain and address, the account share distribution over the
    linked emails it appears on. Returns (domain_dom, addr_dom) where each value is
    {key: (dominant_tpid, share, total)}."""
    rows = con.execute(
        """SELECT l.tpid, e.from_address, e.to_json, e.cc_json
           FROM active_emails e JOIN active_email_customer_links l ON l.message_id = e.message_id"""
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


def clean_customer_domains(con: sqlite3.Connection) -> dict[str, str]:
    """domain -> tpid for high-dominance (>=0.9) customer domains (blanket linking)."""
    dom_dom, _ = _dominance(con)
    return {d: t for d, (t, share, _n) in dom_dom.items() if share >= _DOMAIN_MIN_SHARE}


def external_contact_addresses(con: sqlite3.Connection) -> dict[str, str]:
    """address -> tpid for external addresses whose domain dominantly (>=0.6) maps to
    one account."""
    _dd, addr_dom = _dominance(con)
    return {
        a: t for a, (t, share, _n) in addr_dom.items()
        if share >= _ADDR_MIN_SHARE and _valid_external_domain(_domain(a))
    }


def domains_for_tpid(con: sqlite3.Connection, tpid: str) -> dict:
    """High-dominance customer domains + dominant external addresses for one account."""
    dom_dom, addr_dom = _dominance(con)
    doms = sorted(d for d, (t, s, _n) in dom_dom.items() if t == tpid and s >= _DOMAIN_MIN_SHARE)
    contacts = sorted(
        a for a, (t, s, _n) in addr_dom.items()
        if t == tpid and s >= _ADDR_MIN_SHARE and _valid_external_domain(_domain(a))
    )
    return {"tpid": tpid, "domains": doms, "contacts": contacts}


def link_by_contacts(con: sqlite3.Connection, tpid: str | None = None) -> dict:
    """Link emails whose participants include a high-dominance customer domain or a
    dominant external contact address. match_method='contact', confidence 0.9. Rebuilds
    all 'contact' links each run so stale links from changed dominance are dropped.
    Never touches alias/manual links."""
    if tpid is None:
        con.execute("DELETE FROM email_customer_links WHERE tpid IN (SELECT tpid FROM tpid_config) AND match_method='contact'")
    else:
        con.execute(
            "DELETE FROM email_customer_links WHERE tpid IN (SELECT tpid FROM tpid_config) AND match_method='contact' AND tpid=?",
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
        "SELECT message_id, from_address, to_json, cc_json FROM active_emails"
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
                "SELECT 1 FROM active_email_customer_links WHERE message_id=? AND tpid=?",
                (r["message_id"], t),
            ).fetchone()
            if cur is None:
                con.execute(
                    """INSERT INTO email_customer_links
                         (message_id, tpid, match_method, matched_term, confidence)
                       VALUES (?,?, 'contact', ?, 0.9)""",
                    (r["message_id"], t, reason),
                )
                linked += 1

    con.execute("UPDATE emails SET is_customer_related=0")
    con.execute(
        """UPDATE emails SET is_customer_related=1
           WHERE message_id IN (
             SELECT DISTINCT message_id FROM email_customer_links
             WHERE tpid IN (SELECT tpid FROM tpid_config) AND match_method <> 'ai-rejected')"""
    )
    con.commit()
    return {"related_emails": related, "new_links": linked,
            "domains": len(dom_map), "contacts": len(addr_map)}


def link_by_identity(con: sqlite3.Connection, tpid: str | None = None) -> dict:
    """Identity-first linking: link an email to an account when a participant is an
    exact CRM contact of that account (``identity-contact``, strong) or sits on a
    domain that maps unambiguously to a single account's CRM contacts
    (``identity-domain``, medium).

    This is the authoritative signal — derived directly from ``customer_contacts``,
    not learned from prior links — so it works on a fresh datastore and outranks
    name/alias matching. Rebuilds all identity rows each run; never downgrades a
    higher-ranked link (manual, and identity-contact vs identity-domain)."""
    linkingmod.ensure_link_schema(con)
    if tpid is None:
        con.execute(
            "DELETE FROM email_customer_links "
            "WHERE tpid IN (SELECT tpid FROM tpid_config) AND match_method IN ('identity-contact','identity-domain')"
        )
    else:
        con.execute(
            "DELETE FROM email_customer_links "
            "WHERE tpid IN (SELECT tpid FROM tpid_config) AND match_method IN ('identity-contact','identity-domain') AND tpid=?",
            (tpid,),
        )

    addr_map, domain_map = identitymod.contact_maps(con)
    if tpid:
        addr_map = {a: t for a, t in addr_map.items() if t == tpid}
        domain_map = {d: t for d, t in domain_map.items() if t == tpid}
    if not addr_map and not domain_map:
        con.commit()
        return {"related_emails": 0, "new_links": 0, "contacts": 0, "domains": 0}

    src_map = linkingmod.alias_source_map(con)
    rows = con.execute(
        "SELECT message_id, from_address, to_json, cc_json FROM active_emails"
    ).fetchall()
    linked = 0
    related = 0
    for r in rows:
        hits: dict[str, tuple[str, str, str, float]] = {}  # tpid -> (method, term, ...)
        for a in _participant_addresses(r):
            t = addr_map.get(a)
            if t:
                hits[t] = ("identity-contact", f"contact:{a}", "", 0.98)
                continue
            d = _domain(a)
            t = domain_map.get(d)
            if t and t not in hits:
                hits[t] = ("identity-domain", f"domain:{d}", "", 0.90)
        if not hits:
            continue
        related += 1
        for t, (method, term, _x, conf) in hits.items():
            if _upsert_identity(con, r["message_id"], t, method, term, conf, src_map):
                linked += 1

    con.execute("UPDATE emails SET is_customer_related=0")
    con.execute(
        """UPDATE emails SET is_customer_related=1
           WHERE message_id IN (
             SELECT DISTINCT message_id FROM email_customer_links
             WHERE tpid IN (SELECT tpid FROM tpid_config) AND match_method <> 'ai-rejected')"""
    )
    con.commit()
    return {"related_emails": related, "new_links": linked,
            "contacts": len(addr_map), "domains": len(domain_map)}


def _upsert_identity(con, message_id, tpid, method, term, conf, src_map) -> bool:
    """Insert/upgrade an identity link, honouring method precedence. Never overwrites a
    stronger link (e.g. manual, or identity-contact by identity-domain)."""
    new_rank = linkingmod.rank(method)
    cur = con.execute(
        "SELECT match_method, matched_term FROM active_email_customer_links "
        "WHERE message_id=? AND tpid=?",
        (message_id, tpid),
    ).fetchone()
    tier = linkingmod.tier_for(method)
    if cur is None:
        con.execute(
            """INSERT INTO email_customer_links
                 (message_id, tpid, match_method, matched_term, confidence, tier)
               VALUES (?,?,?,?,?,?)""",
            (message_id, tpid, method, term, conf, tier),
        )
        return True
    cur_src = src_map.get((str(tpid), cur["matched_term"] or "")) if cur["match_method"] == "alias" else None
    if new_rank > linkingmod.rank(cur["match_method"], cur_src):
        con.execute(
            """UPDATE email_customer_links
               SET match_method=?, matched_term=?, confidence=?, tier=?
               WHERE message_id=? AND tpid=?""",
            (method, term, conf, tier, message_id, tpid),
        )
    return False
