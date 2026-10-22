'use strict';

// Use the modern reader route, not the legacy /owa/ redirect. Only explicit message-reader
// links are converted; compose, calendar and mailbox-specific routes keep their own semantics.
function toOutlookWebReaderLink(url) {
  if (typeof url !== 'string' || !url) return url;
  let parsed;
  try { parsed = new URL(url); } catch { return url; }
  if (!['https://outlook.office.com', 'https://outlook.office365.com'].includes(parsed.origin)
    || parsed.username || parsed.password
    || !/^\/owa\/?$/i.test(parsed.pathname)) return url;

  const pairs = parsed.search.replace(/^\?/, '').split('&').filter(Boolean);
  const views = pairs.filter((pair) => /^viewmodel=/i.test(pair));
  if (views.length !== 1 || !/^viewmodel=ReadMessageItem$/i.test(views[0])) return url;
  const ids = pairs.filter((pair) => /^itemid=/i.test(pair));
  if (ids.length !== 1) throw new Error('The Outlook email link must identify exactly one message. Scan your inbox again.');

  let messageId;
  // Decode the raw value, not URLSearchParams: '+' is part of an item ID, not a space.
  try { messageId = decodeURIComponent(ids[0].slice(ids[0].indexOf('=') + 1)); }
  catch { throw new Error('The Outlook email link has an invalid message ID. Scan your inbox again.'); }
  if (!messageId || /\s/.test(messageId)) {
    throw new Error('The Outlook email link has an invalid message ID. Scan your inbox again.');
  }

  const id = encodeURIComponent(messageId);
  const kept = pairs.filter((pair) => !/^(itemid|viewmodel|exvsurl|nativeversion|sessionid)=/i.test(pair));
  const query = [`ItemID=${id}`, 'exvsurl=1', ...kept].join('&');
  return `https://outlook.office.com/mail/deeplink/read/${id}?${query}${parsed.hash}`;
}

module.exports = { toOutlookWebReaderLink };
