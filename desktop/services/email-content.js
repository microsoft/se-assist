'use strict';

const { compile } = require('html-to-text');

const toText = compile({
  wordwrap: false,
  limits: { maxInputLength: Infinity, maxDepth: Infinity, maxChildNodes: Infinity, maxBaseElements: Infinity },
  selectors: [{ selector: 'img', format: 'imageText' }],
  formatters: {
    imageText: (element, _walk, builder) => {
      builder.addInline(element.attribs?.alt || '[Inline image without a text alternative]');
    },
  },
});

function emailBodyText(body) {
  if (typeof body?.content !== 'string') {
    throw new Error('WorkIQ did not return the full email body. Check your mailbox access; email previews cannot replace it.');
  }
  const format = String(body.contentType || '').toLowerCase();
  if (format === 'text') return body.content;
  if (format !== 'html') throw new Error('WorkIQ returned an unsupported email body format.');
  if (body.content.length > 2_000_000) {
    throw new Error('The email HTML exceeds the safe processing limit. No body text was silently truncated.');
  }
  return toText(body.content);
}

const PROTECTED_BRAND = /\b(?:Microsoft Purview Message Encryption|Office 365 Message Encryption|messages protected by Microsoft)\b/i;

function isProtectedMessageNotice(content) {
  return /^[^\r\n]{1,300}\bhas sent you a protected message\.[ \t]*(?:\r?\n|$)/i.test(content.trimStart())
    && /\bRead the message\b/i.test(content)
    && PROTECTED_BRAND.test(content);
}

// Stored email text has its whitespace collapsed, so the notice cannot be anchored to its first line.
// Instead the sender prefix must not cross a sentence or reply-header boundary.
function isProtectedMessageText(content) {
  if (typeof content !== 'string') return false;
  const text = content.replace(/\s+/g, ' ').trim();
  const notice = /\bhas sent you a protected message\.(?: |$)/i.exec(text);
  if (!notice || notice.index === 0 || notice.index > 300) return false;
  return !/[.!?:;]\s/.test(text.slice(0, notice.index))
    && /\bRead the message\b/i.test(text)
    && PROTECTED_BRAND.test(text);
}

// Secretary needs to know what a link points at, not its tracking parameters, which were most of its
// model input. Each web address keeps its site and path; "…" marks a removed query, fragment or path end.
const URL_TEXT = /https?:\/\/[^\s<>"[\]{}|\\^`]+/.source;
// html-to-text writes an anchor as `text [href]`; Outlook plain text writes `text<href>`.
const LINK = new RegExp(`\\b(${URL_TEXT})(?: \\[(${URL_TEXT})\\]|<(${URL_TEXT})>)?`, 'gi');
const SAFE_LINKS_HOST = /(^|\.)safelinks\.protection\.(outlook\.com|office365\.us)$/i;
const MAX_LINK_PATH_CHARS = 60;
const TRAILING_PUNCTUATION = new Set(['.', ',', ';', ':', '!', '?', "'", '"', '\u2019', '\u201d', '\u00bb']);

const countOf = (text, char) => text.split(char).length - 1;

function shortLink(match) {
  let end = match.length;
  while (end > 0) {
    const last = match[end - 1];
    const core = match.slice(0, end);
    if (!TRAILING_PUNCTUATION.has(last) && !(last === ')' && countOf(core, ')') > countOf(core, '('))) break;
    end--;
  }
  let url;
  try {
    url = new URL(match.slice(0, end));
  } catch {
    return { short: match, trailing: '' };
  }
  for (let hops = 0; hops < 3 && SAFE_LINKS_HOST.test(url.hostname); hops++) {
    let target;
    try {
      target = new URL(url.searchParams.get('url'));
    } catch {
      break;
    }
    if (target.protocol !== 'http:' && target.protocol !== 'https:') break;
    url = target;
  }
  const path = url.pathname === '/' ? '' : url.pathname;
  const clipped = path.length > MAX_LINK_PATH_CHARS;
  const cut = clipped || url.search !== '' || url.hash !== '';
  return { short: `${url.host}${path.slice(0, MAX_LINK_PATH_CHARS)}${cut ? '…' : ''}`, trailing: match.slice(end) };
}

function compactEmailLinks(text) {
  return text.replace(LINK, (_match, first, bracketed, angled) => {
    const link = shortLink(first);
    const href = bracketed ?? angled;
    if (href === undefined) return link.short + link.trailing;
    const target = shortLink(href);
    if (target.short === link.short) return link.short + link.trailing;
    const shown = target.short + target.trailing;
    return `${link.short}${link.trailing}${bracketed === undefined ? `<${shown}>` : ` [${shown}]`}`;
  });
}

module.exports = { emailBodyText, compactEmailLinks, isProtectedMessageNotice, isProtectedMessageText };
