'use strict';

const https = require('node:https');
const dns = require('node:dns');
const { isIP } = require('node:net');
const { createGunzip, createInflate, createBrotliDecompress } = require('node:zlib');
const { convert } = require('html-to-text');
const ipaddr = require('ipaddr.js');

const MAX_DOCUMENT_BYTES = 2_000_000;
const PRIVATE_HOSTS = /(^|\.)(sharepoint\.com|sharepoint-df\.com|outlook\.com|office\.com|office365\.com|teams\.microsoft\.com|localhost|local|internal|test)$/i;

function publicSourceUrl(value) {
  try {
    const url = new URL(value);
    const hostname = url.hostname.replace(/\.$/, '');
    if (url.protocol !== 'https:' || url.username || url.password || url.port
      || !hostname.includes('.') || isIP(hostname.replace(/^\[|\]$/g, '')) || PRIVATE_HOSTS.test(hostname)) return null;
    return url.href;
  } catch {
    return null;
  }
}

function createPublicPageReader({ get = https.get, lookup = dns.lookup } = {}) {
  return async function readPublicWebPage({ url, max_length = 18000, start_index = 0 }, { signal } = {}) {
    const original = publicSourceUrl(url);
    if (!original) throw new Error('Read only a public HTTPS source, not a private, credential-bearing or IP address URL.');
    if (!Number.isInteger(max_length) || max_length < 1 || max_length > 20000
      || !Number.isInteger(start_index) || start_index < 0 || start_index > MAX_DOCUMENT_BYTES) {
      throw new Error('Public page reads require a valid text window: max_length 1-20000 and a non-negative start_index.');
    }
    let target = original;
    for (let redirects = 0; redirects <= 5; redirects += 1) {
      signal?.throwIfAborted();
      const response = await new Promise((resolve, reject) => {
        const request = get(target, {
          agent: false,
          signal,
          headers: {
            'User-Agent': 'SE-Assist/2.1.0',
            Accept: 'text/html,application/xhtml+xml,text/plain,text/markdown',
            'Accept-Encoding': 'identity',
          },
          // Validate the addresses used by this socket, not a separate preflight DNS lookup.
          lookup: (hostname, options, callback) => lookup(hostname, { all: true }, (error, addresses) => {
            if (error) return callback(error);
            if (signal?.aborted) return callback(signal.reason);
            if (!addresses?.length || addresses.some(({ address, family }) => isIP(address) !== family
              || !ipaddr.isValid(address) || ipaddr.process(address).range() !== 'unicast')) {
              return callback(Object.assign(new Error('The public source resolves to a private or reserved network address. It was not fetched.'), { code: 'WEB_PRIVATE_ADDRESS' }));
            }
            if (options.all) callback(null, addresses);
            else callback(null, addresses[0].address, addresses[0].family);
          }),
        }, resolve);
        request.once('error', reject);
      });
      let decoded;
      try {
        const status = response.statusCode;
        if ([301, 302, 303, 307, 308].includes(status)) {
          if (!response.headers.location || redirects === 5) throw new Error('The public source returned an invalid or excessive redirect chain.');
          const next = publicSourceUrl(new URL(response.headers.location, target).href);
          if (!next) throw new Error('The public source redirected to a private or unsupported URL. It was not fetched.');
          target = next;
          continue;
        }
        if (status < 200 || status >= 300) {
          throw Object.assign(new Error(`Public source ${target} returned HTTP ${status}.`), {
            code: 'PUBLIC_PAGE_HTTP_ERROR', statusCode: status, headers: new Headers(response.headers),
          });
        }
        const contentType = String(response.headers['content-type'] || '');
        if (!/^(text\/(?:html|plain|markdown)|application\/xhtml\+xml)(?:;|$)/i.test(contentType)) {
          throw new Error(`The public source returned an unsupported content type: ${contentType || 'missing'}. Only HTML and text pages can be read.`);
        }
        const encoding = String(response.headers['content-encoding'] || 'identity').toLowerCase();
        const decompress = { gzip: createGunzip, deflate: createInflate, br: createBrotliDecompress }[encoding];
        if (encoding !== 'identity' && !decompress) throw new Error(`The public source uses unsupported content encoding: ${encoding}.`);
        decoded = decompress ? response.pipe(decompress()) : response;
        if (decoded !== response) response.once('error', error => decoded.destroy(error));
        const chunks = [];
        let size = 0;
        for await (const chunk of decoded) {
          signal?.throwIfAborted();
          size += chunk.length;
          if (size > MAX_DOCUMENT_BYTES) throw new Error('The public page exceeds the 2 MB safe reading limit. No partial page was substituted.');
          chunks.push(chunk);
        }
        signal?.throwIfAborted();
        const charset = contentType.match(/charset\s*=\s*["']?([^;"'\s]+)/i)?.[1] || 'utf-8';
        const body = new TextDecoder(charset, { fatal: true }).decode(Buffer.concat(chunks));
        const isHtml = /html/i.test(contentType);
        const references = new Set();
        const text = isHtml ? convert(body, {
          wordwrap: false,
          limits: { maxInputLength: Infinity },
          selectors: [
            { selector: 'img', format: 'skip' },
            { selector: 'nav', format: 'skip' },
            { selector: 'script', format: 'skip' },
            { selector: 'style', format: 'skip' },
            { selector: 'a', format: 'sourceLink' },
          ],
          formatters: {
            sourceLink: (element, walk, builder) => {
              walk(element.children, builder);
              if (!element.attribs?.href) return;
              let reference;
              try { reference = publicSourceUrl(new URL(element.attribs.href, target).href); } catch { return; }
              if (reference) {
                references.add(reference);
                builder.addInline(` [${reference}]`);
              }
            },
          },
        }) : body;
        if (!text.trim()) throw new Error('The public source returned no readable page text.');
        if (start_index >= text.length) throw new Error(`The requested start_index is outside this page's ${text.length} characters.`);
        const end = Math.min(start_index + max_length, text.length);
        const truncated = end < text.length;
        const textWindow = text.slice(start_index, end);
        return { structuredContent: {
          url: target, requestedUrl: original,
          text: textWindow, startIndex: start_index, totalCharacters: text.length, truncated,
          ...(isHtml ? { references: [...references].filter(reference => textWindow.includes(`[${reference}]`)).map(reference => ({ url: reference })) } : {}),
          ...(target !== original ? { redirectNotice: `The requested source redirected to ${target}.` } : {}),
          ...(truncated ? {
            nextStartIndex: end,
            notice: `Only characters ${start_index}-${end} are included. Read this same URL with startIndex ${end} to continue.`,
          } : {}),
        } };
      } finally {
        decoded?.destroy();
        response.destroy();
      }
    }
    throw new Error('The public source could not be read.');
  };
}

const readPublicWebPage = createPublicPageReader();

module.exports = { publicSourceUrl, createPublicPageReader, readPublicWebPage };
