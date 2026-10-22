'use strict';

// Research-dossier service: locate the markdown "customer docs" in the Obsidian
// vault (vault/Accounts/<Account>/<Account> — Research.md), match a customer row
// to its dossier, and render that dossier to a self-contained HTML document that
// the app can open through the sandboxed `userData/generated/` file bridge.
//
// The shared markdown→HTML helper in app-ipc.js is tuned for AI output and
// does NOT handle GFM tables, YAML frontmatter, blockquotes, horizontal rules, or
// [[wikilinks]] — all of which the dossiers use heavily — so this module ships its
// own dependency-free renderer (npm is unavailable in this environment).
//
// Design rule (repo-wide): fail loudly. If the vault is missing we return an
// explicit reason rather than silently substituting empty/placeholder content.

const fs = require('fs');
const path = require('path');

const RESEARCH_SUFFIX_RE = /\bresearch\b/i;
const EMDASH_RESEARCH_RE = /—\s*research\.md$/i;

/**
 * Resolve the vault directory. Priority:
 *   1. explicit argument (tests / callers)
 *   2. SE_ASSIST_VAULT_DIR env override
 *   3. dev layout: repo-root/vault (this file is desktop/services/*.js)
 *   4. packaged layout: <resourcesPath>/vault
 * Returns an absolute path or null if none exists on disk.
 */
function resolveVaultDir(explicit) {
  const candidates = [];
  if (explicit) candidates.push(explicit);
  if (process.env.SE_ASSIST_VAULT_DIR) candidates.push(process.env.SE_ASSIST_VAULT_DIR);
  candidates.push(path.join(__dirname, '..', '..', 'vault'));
  if (process.resourcesPath) candidates.push(path.join(process.resourcesPath, 'vault'));
  for (const c of candidates) {
    try {
      if (c && fs.existsSync(path.join(c, 'Accounts')) && fs.statSync(path.join(c, 'Accounts')).isDirectory()) {
        return path.resolve(c);
      }
    } catch { /* keep trying */ }
  }
  return null;
}

// --- YAML-ish frontmatter -------------------------------------------------

/**
 * Split a `--- ... ---` frontmatter block off the top of a markdown string.
 * Returns { data: {}, body: string }. Only simple `key: value` and
 * `key: [a, b]` lines are parsed (sufficient for the dossier/profile notes).
 */
function parseFrontmatter(md) {
  const text = String(md || '');
  if (!/^\uFEFF?---\r?\n/.test(text)) return { data: {}, body: text };
  const norm = text.replace(/^\uFEFF/, '');
  const end = norm.indexOf('\n---', 4);
  if (end === -1) return { data: {}, body: text };
  const block = norm.slice(4, end);
  const rest = norm.slice(end + 4).replace(/^\r?\n/, '');
  const data = {};
  for (const rawLine of block.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const idx = line.indexOf(':');
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    let val = line.slice(idx + 1).trim();
    if (!key) continue;
    if (val.startsWith('[') && val.endsWith(']')) {
      data[key] = val.slice(1, -1).split(',').map((s) => stripQuotes(s.trim())).filter(Boolean);
    } else {
      data[key] = stripQuotes(val);
    }
  }
  return { data, body: rest };
}

function stripQuotes(s) {
  const t = String(s || '').trim();
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
    return t.slice(1, -1);
  }
  return t;
}

// --- Name normalization + matching ---------------------------------------

const COMPANY_STOPWORDS = new Set([
  'inc', 'incorporated', 'llc', 'lp', 'llp', 'ltd', 'limited', 'corp', 'corporation',
  'co', 'company', 'plc', 'mgmt', 'management', 'global', 'holdings', 'holding',
  'group', 'partners', 'capital', 'the', 'and',
]);

/** Lowercase, strip punctuation + common corporate suffixes, collapse whitespace. */
function normalizeName(name) {
  const base = String(name || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!base) return '';
  const kept = base.split(' ').filter((w) => w && !COMPANY_STOPWORDS.has(w));
  return (kept.length ? kept : base.split(' ')).join(' ');
}

/**
 * Build an index of dossier-bearing accounts by scanning vault/Accounts/*.
 * Each entry: { folder, dir, profilePath, researchPath, frontmatter, aliases:Set<string> }.
 * Only folders that actually contain a research note are returned.
 */
function buildAccountIndex(vaultDir) {
  const accountsDir = path.join(vaultDir, 'Accounts');
  let folders = [];
  try {
    folders = fs.readdirSync(accountsDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    return [];
  }
  const index = [];
  for (const folder of folders) {
    const dir = path.join(accountsDir, folder);
    let files = [];
    try { files = fs.readdirSync(dir).filter((f) => f.toLowerCase().endsWith('.md')); } catch { continue; }
    if (!files.length) continue;

    // Research note: prefer "<Account> — Research.md", else any *research*.md.
    const researchFile = files.find((f) => EMDASH_RESEARCH_RE.test(f))
      || files.find((f) => RESEARCH_SUFFIX_RE.test(f));
    if (!researchFile) continue;

    // Profile note (for aliases): "<folder>.md" if present, else first non-research md.
    const profileFile = files.find((f) => f === `${folder}.md`)
      || files.find((f) => !RESEARCH_SUFFIX_RE.test(f));

    const aliases = new Set();
    aliases.add(normalizeName(folder));
    let frontmatter = {};
    if (profileFile) {
      try {
        const { data } = parseFrontmatter(fs.readFileSync(path.join(dir, profileFile), 'utf8'));
        frontmatter = data;
        for (const key of ['list_entry', 'official_name', 'account', 'aka', 'former_name']) {
          if (data[key]) {
            const vals = Array.isArray(data[key]) ? data[key] : [data[key]];
            vals.forEach((v) => { const n = normalizeName(v); if (n) aliases.add(n); });
          }
        }
      } catch { /* frontmatter optional */ }
    }
    aliases.delete('');
    index.push({
      folder,
      dir,
      profilePath: profileFile ? path.join(dir, profileFile) : null,
      researchPath: path.join(dir, researchFile),
      frontmatter,
      aliases,
    });
  }
  return index;
}

/**
 * Match a customer name against the account index. Tries, in order:
 * exact normalized alias, then containment either direction on the folder /
 * primary aliases. Returns the best entry or null (no fuzzy guessing beyond this).
 */
function matchAccount(index, { name } = {}) {
  const target = normalizeName(name);
  if (!target) return null;

  // 1. exact alias hit.
  for (const entry of index) {
    if (entry.aliases.has(target)) return entry;
  }
  // 2. containment (target ⊂ alias or alias ⊂ target), longest alias wins to
  //    avoid a short token matching an unrelated longer name.
  let best = null;
  let bestLen = 0;
  for (const entry of index) {
    for (const alias of entry.aliases) {
      if (!alias) continue;
      const contains = target.includes(alias) || alias.includes(target);
      if (contains && alias.length > bestLen) { best = entry; bestLen = alias.length; }
    }
  }
  return best;
}

// --- Markdown → HTML (dossier-aware, dependency-free) --------------------

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Inline formatting on already-trusted text: escape, then apply md tokens. */
function renderInline(text) {
  let s = escapeHtml(text);
  // inline code first (protect its content from further token processing)
  const codes = [];
  s = s.replace(/`([^`]+)`/g, (_m, c) => { codes.push(c); return `\u0000CODE${codes.length - 1}\u0000`; });
  // wikilinks: [[Page|Alias]] or [[Page]] → plain styled text (no vault navigation in-app)
  s = s.replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, (_m, _p, alias) => `<span class="wl">${alias.trim()}</span>`);
  s = s.replace(/\[\[([^\]]+)\]\]/g, (_m, p) => `<span class="wl">${p.trim()}</span>`);
  // markdown links [text](url) — only http(s)/mailto become anchors, else plain text
  s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_m, label, url) => {
    const u = url.trim();
    if (/^(https?:|mailto:)/i.test(u)) return `<a href="${escapeHtml(u)}" target="_blank" rel="noreferrer noopener">${label}</a>`;
    return label;
  });
  // bold then italic
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, '$1<em>$2</em>');
  s = s.replace(/(^|[\s(])_([^_\n]+)_(?=[\s).,;:!?]|$)/g, '$1<em>$2</em>');
  // restore code spans
  s = s.replace(/\u0000CODE(\d+)\u0000/g, (_m, i) => `<code>${codes[Number(i)]}</code>`);
  return s;
}

function isTableSeparator(line) {
  return /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)+\|?\s*$/.test(line);
}
function splitTableRow(line) {
  let l = line.trim();
  if (l.startsWith('|')) l = l.slice(1);
  if (l.endsWith('|')) l = l.slice(0, -1);
  return l.split('|').map((c) => c.trim());
}

/** Render dossier markdown body (frontmatter already stripped) into HTML. */
function renderMarkdownBody(md) {
  const lines = String(md || '').replace(/\r\n/g, '\n').split('\n');
  const out = [];
  let para = [];
  const listStack = []; // { type: 'ul'|'ol', indent }

  const flushPara = () => {
    if (para.length) { out.push(`<p>${renderInline(para.join(' '))}</p>`); para = []; }
  };
  const closeListsTo = (indent) => {
    while (listStack.length && listStack[listStack.length - 1].indent >= indent) {
      out.push(`</${listStack.pop().type}>`);
    }
  };
  const closeAllLists = () => { while (listStack.length) out.push(`</${listStack.pop().type}>`); };

  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i];
    const line = raw.replace(/\s+$/, '');
    const trimmed = line.trim();

    if (!trimmed) { flushPara(); closeAllLists(); continue; }

    // horizontal rule
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(trimmed)) { flushPara(); closeAllLists(); out.push('<hr />'); continue; }

    // heading
    const h = /^(#{1,6})\s+(.*)$/.exec(trimmed);
    if (h) {
      flushPara(); closeAllLists();
      const level = h[1].length;
      out.push(`<h${level}>${renderInline(h[2].trim())}</h${level}>`);
      continue;
    }

    // table (header row followed by separator)
    if (trimmed.includes('|') && i + 1 < lines.length && isTableSeparator(lines[i + 1])) {
      flushPara(); closeAllLists();
      const header = splitTableRow(trimmed);
      i += 1; // consume separator
      const rows = [];
      while (i + 1 < lines.length && lines[i + 1].includes('|') && lines[i + 1].trim()) {
        i += 1;
        rows.push(splitTableRow(lines[i]));
      }
      let tbl = '<table><thead><tr>' + header.map((c) => `<th>${renderInline(c)}</th>`).join('') + '</tr></thead>';
      if (rows.length) {
        tbl += '<tbody>' + rows.map((r) => '<tr>' + header.map((_c, ci) => `<td>${renderInline(r[ci] || '')}</td>`).join('') + '</tr>').join('') + '</tbody>';
      }
      tbl += '</table>';
      out.push(tbl);
      continue;
    }

    // blockquote (supports multi-line, joined)
    if (/^>\s?/.test(trimmed)) {
      flushPara(); closeAllLists();
      const quote = [trimmed.replace(/^>\s?/, '')];
      while (i + 1 < lines.length && /^>\s?/.test(lines[i + 1].trim())) {
        i += 1; quote.push(lines[i].trim().replace(/^>\s?/, ''));
      }
      out.push(`<blockquote>${renderInline(quote.join(' '))}</blockquote>`);
      continue;
    }

    // list item (unordered or ordered), indentation → nesting
    const li = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(raw);
    if (li) {
      flushPara();
      const indent = li[1].replace(/\t/g, '  ').length;
      const type = /\d/.test(li[2]) ? 'ol' : 'ul';
      closeListsTo(indent + 1);
      const top = listStack[listStack.length - 1];
      if (!top || top.indent < indent) {
        out.push(`<${type}>`);
        listStack.push({ type, indent });
      } else if (top.type !== type) {
        out.push(`</${top.type}>`);
        listStack.pop();
        out.push(`<${type}>`);
        listStack.push({ type, indent });
      }
      out.push(`<li>${renderInline(li[3])}</li>`);
      continue;
    }

    // otherwise: paragraph text
    para.push(trimmed);
  }
  flushPara();
  closeAllLists();
  return out.join('\n');
}

/** Render the parsed frontmatter map as a compact metadata table. */
function renderFrontmatterTable(data) {
  const entries = Object.entries(data || {}).filter(([, v]) => v != null && String(v).length);
  if (!entries.length) return '';
  const rows = entries.map(([k, v]) => {
    const label = k.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
    const val = Array.isArray(v) ? v.join(', ') : String(v);
    return `<tr><th>${escapeHtml(label)}</th><td>${renderInline(val)}</td></tr>`;
  }).join('');
  return `<table class="fm"><tbody>${rows}</tbody></table>`;
}

/** Wrap rendered body in a self-contained, app-styled HTML document. */
function renderDossierDocument({ title, subtitle, chips, bodyHtml }) {
  const chipHtml = (chips || []).filter(Boolean)
    .map((c) => `<span class="chip">${escapeHtml(c)}</span>`).join('');
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(title)}</title>
<style>
  :root{color-scheme:light}
  *{box-sizing:border-box}
  body{margin:0;background:#f2f4f8;color:#1f2333;font:15px/1.6 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif}
  .wrap{max-width:900px;margin:0 auto;padding:32px 28px 64px}
  header.hero{background:#fff;border:1px solid #dbe0e8;border-radius:14px;padding:22px 24px;margin-bottom:22px}
  header.hero h1{margin:0 0 6px;font-size:24px;color:#1f2333}
  header.hero .sub{color:#616880;font-size:13px}
  .chips{margin-top:12px;display:flex;gap:8px;flex-wrap:wrap}
  .chip{background:#eef1fb;color:#4c63d2;border:1px solid #dfe4fb;border-radius:999px;padding:3px 10px;font-size:12px;font-weight:600}
  article{background:#fff;border:1px solid #dbe0e8;border-radius:14px;padding:8px 28px 24px}
  article h1{font-size:22px;border-bottom:2px solid #eef1f6;padding-bottom:8px;margin-top:28px}
  article h2{font-size:18px;color:#3a2f6b;margin-top:30px;border-bottom:1px solid #eef1f6;padding-bottom:6px}
  article h3{font-size:15px;color:#4c63d2;margin-top:22px}
  article h4,article h5,article h6{font-size:14px;color:#616880;margin-top:18px}
  a{color:#4c63d2}
  code{background:#f2f4f8;border:1px solid #e2e6ee;border-radius:4px;padding:1px 5px;font:13px/1.4 'SFMono-Regular',Consolas,'Liberation Mono',monospace}
  blockquote{margin:14px 0;padding:10px 16px;background:#f7f8fc;border-left:4px solid #8b5cf0;border-radius:0 8px 8px 0;color:#3a3f57}
  hr{border:0;border-top:1px solid #e2e6ee;margin:22px 0}
  ul,ol{padding-left:22px}
  li{margin:3px 0}
  table{border-collapse:collapse;width:100%;margin:14px 0;font-size:13.5px}
  th,td{border:1px solid #dbe0e8;padding:7px 10px;text-align:left;vertical-align:top}
  th{background:#f2f4f8;color:#3a3f57}
  table.fm{width:auto;margin:0 0 18px}
  table.fm th{white-space:nowrap;width:1%}
  .wl{color:#6b7280;font-style:italic}
  @media print{body{background:#fff}article,header.hero{border:none;padding-left:0;padding-right:0}}
</style></head>
<body><div class="wrap">
<header class="hero">
  <h1>${escapeHtml(title)}</h1>
  ${subtitle ? `<div class="sub">${escapeHtml(subtitle)}</div>` : ''}
  ${chipHtml ? `<div class="chips">${chipHtml}</div>` : ''}
</header>
<article>${bodyHtml}</article>
</div></body></html>`;
}

// --- Topic extraction (for the profile card + the analysis engine) -------

/**
 * Parse `## N. Title …` topic headings and the trailing `**Synthesis …:** …`
 * line under each. Returns [{ num, title, synthesis }]. Used to preview the
 * dossier in the profile and to feed the deterministic analysis engine.
 */
function parseTopics(body) {
  const lines = String(body || '').replace(/\r\n/g, '\n').split('\n');
  const topics = [];
  let current = null;
  for (const line of lines) {
    const h = /^##\s+(\d+)\.\s+(.*)$/.exec(line.trim());
    if (h) {
      if (current) topics.push(current);
      const title = h[2].split('·')[0].replace(/\s+$/, '').trim();
      current = { num: Number(h[1]), title, synthesis: '' };
      continue;
    }
    if (/^##\s+/.test(line.trim())) { if (current) { topics.push(current); current = null; } continue; }
    if (current) {
      const syn = /^\*\*Synthesis[^:]*:\*\*\s*(.*)$/i.exec(line.trim());
      if (syn && !current.synthesis) current.synthesis = syn[1].trim();
    }
  }
  if (current) topics.push(current);
  return topics;
}

// --- Public entry points -------------------------------------------------

/**
 * Locate + read a customer's research dossier. Pure data (no HTML render).
 * @returns {{ ok:true, found:boolean, ... }} explicit found/reason states.
 */
function getDossier({ name, tpid, vaultDir } = {}) {
  const dir = resolveVaultDir(vaultDir);
  if (!dir) {
    return { ok: true, found: false, available: false, reason: 'Research vault not found. It ships with the app repo (vault/Accounts); set SE_ASSIST_VAULT_DIR to point at it.' };
  }
  const index = buildAccountIndex(dir);
  if (!index.length) {
    return { ok: true, found: false, available: true, reason: 'No account research notes were found in the vault (vault/Accounts/*/… — Research.md).' };
  }
  const entry = matchAccount(index, { name });
  if (!entry) {
    return { ok: true, found: false, available: true, reason: `No research dossier matches “${name || 'this account'}”. Dossiers exist for ${index.length} account${index.length === 1 ? '' : 's'}.` };
  }
  let markdown = '';
  let stat = null;
  try {
    markdown = fs.readFileSync(entry.researchPath, 'utf8');
    stat = fs.statSync(entry.researchPath);
  } catch (err) {
    return { ok: true, found: false, available: true, reason: `Found the dossier for ${entry.folder} but could not read it: ${err.message || String(err)}` };
  }
  const { data, body } = parseFrontmatter(markdown);
  const topics = parseTopics(body);
  return {
    ok: true,
    found: true,
    available: true,
    account: entry.folder,
    matchedName: name || null,
    tpid: tpid || null,
    researchPath: entry.researchPath,
    frontmatter: data,
    markdown,
    body,
    topics,
    lastUpdated: data.last_updated || (stat ? stat.mtime.toISOString().slice(0, 10) : null),
    updatedAtIso: stat ? stat.mtime.toISOString() : null,
  };
}

/**
 * Render a customer's dossier to a full HTML document string.
 * @returns {{ ok, found, html?, title?, subtitle?, chips?, ...}}
 */
function renderDossierHtml({ name, tpid, vaultDir } = {}) {
  const doc = getDossier({ name, tpid, vaultDir });
  if (!doc.found) return doc;
  const fmTable = renderFrontmatterTable(doc.frontmatter);
  const bodyHtml = fmTable + renderMarkdownBody(doc.body);
  const title = `${doc.account} — Research Dossier`;
  const subtitleBits = [];
  if (doc.frontmatter.official_name && normalizeName(doc.frontmatter.official_name) !== normalizeName(doc.account)) {
    subtitleBits.push(doc.frontmatter.official_name);
  }
  if (doc.lastUpdated) subtitleBits.push(`Updated ${doc.lastUpdated}`);
  const chips = [];
  if (doc.frontmatter.segment) chips.push(doc.frontmatter.segment);
  if (doc.frontmatter.ticker) chips.push(doc.frontmatter.ticker);
  if (doc.frontmatter.research_status) chips.push(`Status: ${doc.frontmatter.research_status}`);
  if (doc.topics.length) chips.push(`${doc.topics.length} topics`);
  const html = renderDossierDocument({ title, subtitle: subtitleBits.join(' · '), chips, bodyHtml });
  return {
    ok: true,
    found: true,
    available: true,
    account: doc.account,
    tpid: doc.tpid,
    title,
    subtitle: subtitleBits.join(' · '),
    chips,
    topics: doc.topics,
    lastUpdated: doc.lastUpdated,
    researchPath: doc.researchPath,
    html,
  };
}

module.exports = {
  resolveVaultDir,
  parseFrontmatter,
  normalizeName,
  buildAccountIndex,
  matchAccount,
  parseTopics,
  renderMarkdownBody,
  renderDossierDocument,
  getDossier,
  renderDossierHtml,
};
