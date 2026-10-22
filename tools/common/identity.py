"""Identity-first customer linking from authoritative CRM contact records.

`customer_contacts` (migration 011) caches the real Dynamics/MSX contact records
for each account — including the contact's e-mail address — keyed by the account's
top-parent tpid. Those addresses are the single most trustworthy signal we have for
deciding which customer an e-mail / meeting / chat belongs to: if a message is to or
from a person the CRM already lists as a contact of account X, it is about account X.

Unlike the domain/address linkers in ``tools/email/contacts.py`` and
``tools/meetings/contacts.py`` — which *learn* customer domains from already-linked
messages (a bootstrap that only works once alias matching has produced some links) —
this module derives its maps directly from CRM data, so it works on a fresh datastore
with zero prior links and never depends on name/text matching.

Two maps are produced:

  addr_map   : exact contact e-mail -> tpid. Authoritative. An address that the CRM
               lists under two different accounts is dropped as ambiguous.
  domain_map : e-mail domain -> tpid, but ONLY for domains that map unambiguously to
               a single account across all CRM contacts, and only for "real" external
               company domains (generic free-mail, our own tenant, and common
               SI/partner domains are excluded so shared inboxes never mis-link).
"""
from __future__ import annotations

import sqlite3
from collections import defaultdict

# Free/consumer mail domains — a contact using one of these tells us nothing about
# which company they belong to, so their domain must never identify an account.
_GENERIC_DOMAINS = {
    "gmail.com", "outlook.com", "hotmail.com", "live.com", "yahoo.com", "icloud.com",
    "aol.com", "protonmail.com", "proton.me", "gmx.com", "gmx.net", "me.com",
    "msn.com", "qq.com", "163.com", "126.com", "yandex.com", "mail.com", "zoho.com",
}

# Our own tenant — internal people are never a customer identity signal.
_INTERNAL_SUFFIXES = ("microsoft.com", "microsoft.onmicrosoft.com")


def _domain(addr: str | None) -> str:
    addr = (addr or "").strip().lower()
    return addr.rsplit("@", 1)[-1] if "@" in addr else ""


def _is_internal(dom: str) -> bool:
    return any(dom == s or dom.endswith("." + s) for s in _INTERNAL_SUFFIXES)


def usable_domain(dom: str) -> bool:
    """A domain that can legitimately stand in for a customer's identity."""
    return bool(dom) and dom not in _GENERIC_DOMAINS and not _is_internal(dom)


def contact_maps(con: sqlite3.Connection) -> tuple[dict[str, str], dict[str, str]]:
    """Return (addr_map, domain_map) derived from active_customer_contacts.

    addr_map:   {email_lower: tpid}   — exact CRM contact addresses (ambiguous
                                         addresses, listed under >1 tpid, are dropped).
    domain_map: {domain_lower: tpid}  — domains that map to exactly one tpid across
                                         all CRM contacts and pass ``usable_domain``.

    The desktop must have installed the active-roster schema before ingestion.
    """
    rows = con.execute(
        "SELECT tpid, email FROM active_customer_contacts "
        "WHERE email IS NOT NULL AND tpid IS NOT NULL"
    ).fetchall()

    addr_tpids: dict[str, set[str]] = defaultdict(set)
    dom_tpids: dict[str, set[str]] = defaultdict(set)
    for r in rows:
        email = (r["email"] or "").strip().lower()
        tpid = str(r["tpid"]).strip()
        if not email or "@" not in email or not tpid:
            continue
        dom = _domain(email)
        if not usable_domain(dom):
            continue
        addr_tpids[email].add(tpid)
        dom_tpids[dom].add(tpid)

    addr_map = {a: next(iter(t)) for a, t in addr_tpids.items() if len(t) == 1}
    domain_map = {d: next(iter(t)) for d, t in dom_tpids.items() if len(t) == 1}
    return addr_map, domain_map


def domains_for_tpid(con: sqlite3.Connection, tpid: str) -> dict:
    """CRM contact addresses + unambiguous domains for one account (for reporting)."""
    addr_map, domain_map = contact_maps(con)
    return {
        "tpid": tpid,
        "domains": sorted(d for d, t in domain_map.items() if t == tpid),
        "contacts": sorted(a for a, t in addr_map.items() if t == tpid),
    }
