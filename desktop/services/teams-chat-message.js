'use strict';

const { escapeHtml } = require('./html-render');

function copyMilestoneTeamsMessage(payload, clipboard) {
  const ownerName = typeof payload?.ownerName === 'string' ? payload.ownerName.trim() : '';
  const milestoneName = typeof payload?.milestoneName === 'string' ? payload.milestoneName.trim() : '';
  const milestoneUrl = typeof payload?.milestoneUrl === 'string' ? payload.milestoneUrl.trim() : '';
  if (!ownerName || !milestoneName || !milestoneUrl) {
    throw new Error('Cannot copy the Teams message: the owner name, milestone name and MSX link are required.');
  }
  if (!URL.canParse(milestoneUrl)) {
    throw new Error('Cannot copy the Teams message: a valid HTTPS milestone MSX link is required.');
  }
  const url = new URL(milestoneUrl);
  if (url.protocol !== 'https:' || !url.pathname.endsWith('/main.aspx')
      || url.searchParams.get('etn') !== 'msp_engagementmilestone'
      || !url.searchParams.get('id') || url.searchParams.get('pagetype') !== 'entityrecord') {
    throw new Error('Cannot copy the Teams message: a valid HTTPS milestone MSX link is required.');
  }
  if (!['write', 'readText', 'readHTML'].every(method => typeof clipboard?.[method] === 'function')) {
    throw new Error('Copying a formatted Teams message requires desktop clipboard support.');
  }
  const first = ownerName.split(/\s+/)[0];
  const text = `Hi ${first}, can we talk about this milestone ${milestoneName}. ${milestoneUrl}`;
  const href = escapeHtml(milestoneUrl).replace(/"/g, '&quot;');
  const html = `<p>Hi ${escapeHtml(first)}, can we talk about this milestone <a href="${href}">${escapeHtml(milestoneName)}</a>.</p>`;
  clipboard.write({ text, html });
  if (clipboard.readText() !== text || !clipboard.readHTML().includes(html)) {
    throw new Error('The clipboard did not retain the formatted Teams message and hyperlink. Please try again.');
  }
  return { ok: true };
}

module.exports = { copyMilestoneTeamsMessage };
