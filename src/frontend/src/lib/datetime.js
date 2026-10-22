/**
 * datetime.js — shared date/time parsing + local-timezone formatting.
 *
 * Microsoft Graph calendar events store `start`/`end` as a naive "wall clock"
 * dateTime string WITHOUT a timezone designator (e.g. "2026-10-16T12:30:00.0000000"),
 * paired with a separate `timeZone` field (UTC by default). JavaScript's Date parser
 * interprets a designator-less ISO string as LOCAL time, which renders meetings in the
 * wrong zone. Since these values are ingested as UTC, we append 'Z' when no offset/zone
 * is present so the value is parsed as UTC and can be displayed in the user's local
 * timezone via toLocale* formatters. Values that already carry a 'Z' or ±hh:mm offset
 * (e.g. email receivedDateTime) are parsed unchanged.
 */

// Matches an ISO-ish datetime with no trailing timezone designator.
const NAIVE_DATETIME = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/;

export function parseGraphDateTime(value) {
  if (!value) return null;
  let s = String(value).trim();
  if (!s) return null;
  if (NAIVE_DATETIME.test(s)) {
    s = s.replace(' ', 'T');
    // Trim over-long fractional seconds (Graph emits 7 digits) to milliseconds.
    s = s.replace(/(\.\d{3})\d+$/, '$1');
    s = `${s}Z`; // treat as UTC
  }
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

export function formatLocalTime(value) {
  const d = parseGraphDateTime(value);
  if (!d) return '';
  return d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

export function formatLocalDate(value, opts = { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' }) {
  const d = parseGraphDateTime(value);
  if (!d) return '';
  return d.toLocaleDateString(undefined, opts);
}

export function formatLocalDateTime(value) {
  const d = parseGraphDateTime(value);
  if (!d) return '';
  return d.toLocaleString(undefined, {
    weekday: 'short', month: 'short', day: 'numeric', year: 'numeric',
    hour: 'numeric', minute: '2-digit',
  });
}

// Format a DATE-ONLY value (Dynamics Edm.Date, e.g. milestone target dates "2026-09-11" or
// "2026-09-11T00:00:00Z"). These are calendar dates with no time or timezone. Passing them to
// `new Date(value)` parses them as UTC midnight, which renders as the PREVIOUS day in any
// negative-UTC timezone (e.g. Sep 11 shows as Sep 10 in New York). This helper reads only the
// Y-M-D and builds a LOCAL date, so the calendar date is always shown exactly as stored. Pass
// `opts` for a specific format; omit for the locale-default short date (matches a bare
// toLocaleDateString()). Returns '' for empty/unparseable input.
export function formatDateOnly(value, opts) {
  if (!value) return '';
  const m = String(value).match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return '';
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString(undefined, opts);
}
