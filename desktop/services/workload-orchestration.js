'use strict';

const signalLinks = require('./signal-links');
const { assertActiveTpid, assertActiveRecord } = require('../account-roster');

function requiredText(value, label) {
  const text = String(value || '').trim();
  if (!text) throw new Error(`${label} is required.`);
  return text;
}

function optionalText(value) {
  const text = String(value || '').trim();
  return text || null;
}

function positiveId(value, label) {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id <= 0) throw new Error(`${label} must be a positive integer.`);
  return id;
}

function readTemplate(database, templateId) {
  const id = positiveId(templateId, 'templateId');
  const template = database.prepare(
    'SELECT id, name FROM workload_templates WHERE id = ?',
  ).get(id);
  if (!template) throw new Error('The selected workload template no longer exists.');
  const stages = database.prepare(
    'SELECT * FROM workload_template_stages WHERE template_id = ? ORDER BY sort_order, id',
  ).all(id);
  const actions = database.prepare(
    'SELECT * FROM workload_template_actions WHERE template_id = ? ORDER BY sort_order, id',
  ).all(id);
  return { template, stages, actions };
}

function instantiateTemplate(database, templateId, workloadId) {
  const targetId = positiveId(workloadId, 'workloadId');
  const { stages, actions } = readTemplate(database, templateId);
  const insertStage = database.prepare(
    `INSERT INTO workload_stages
       (workload_id, name, description, sort_order)
     VALUES (?, ?, ?, ?)`,
  );
  const insertAction = database.prepare(
    `INSERT INTO workload_actions
       (workload_id, stage_id, title, description, action_type, sort_order)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  const stageMap = new Map();
  for (const stage of stages) {
    const result = insertStage.run(
      targetId,
      stage.name,
      stage.description || null,
      stage.sort_order || 0,
    );
    stageMap.set(stage.id, Number(result.lastInsertRowid));
  }
  for (const action of actions) {
    insertAction.run(
      targetId,
      stageMap.get(action.template_stage_id) || null,
      action.title,
      action.description || null,
      action.action_type || 'task',
      action.sort_order || 0,
    );
  }
  return { stageCount: stages.length, actionCount: actions.length };
}

function resolveOpportunity(database, opportunityId) {
  const id = optionalText(opportunityId);
  if (!id) return null;
  const opportunity = database.prepare(
    `SELECT o.opportunity_id, o.name, o.owner_name AS ssp_name,
            cu.tpid AS customer_tpid, cu.name AS customer_name
     FROM active_opportunities o
     LEFT JOIN active_customers cu ON cu.crm_account_id = o.parent_account_id
     WHERE o.opportunity_id = ?`,
  ).get(id);
  if (!opportunity) throw new Error('The selected opportunity no longer exists.');
  return opportunity;
}

function createWorkload(database, payload = {}) {
  const transaction = database.transaction(() => {
    const name = requiredText(payload.name, 'Workload name');
    const opportunity = resolveOpportunity(database, payload.opportunityId);
    const templateId = payload.templateId == null || payload.templateId === ''
      ? null
      : positiveId(payload.templateId, 'templateId');
    const customerTpid = opportunity?.customer_tpid || optionalText(payload.tpid) || null;
    if (customerTpid) assertActiveTpid(database, customerTpid);
    const customerName = opportunity?.customer_name || optionalText(payload.accountName) || null;
    const result = database.prepare(
      `INSERT INTO workloads
         (title, name, description, category, tpid, account_name, customer_tpid,
          customer_name, ssp_name, opportunity_id, opportunity_name, template_id, sort_order)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
         COALESCE((SELECT MAX(sort_order) + 1 FROM active_workloads), 0))`,
    ).run(
      name,
      name,
      optionalText(payload.description),
      optionalText(payload.category),
      customerTpid,
      customerName,
      customerTpid,
      customerName,
      optionalText(payload.sspName) || opportunity?.ssp_name || null,
      opportunity?.opportunity_id || null,
      opportunity?.name || null,
      templateId,
    );
    const workloadId = Number(result.lastInsertRowid);
    const copied = templateId
      ? instantiateTemplate(database, templateId, workloadId)
      : { stageCount: 0, actionCount: 0 };

    // Optionally carry over discovered/curated milestone links + communication signals in the
    // SAME transaction (used by the New workload popup's "Discover" flow), mirroring the
    // approveSuggestion linking so a discovered workload behaves exactly like an approved one.
    const linkCounts = attachWorkloadAssociations(database, {
      workloadId, customerTpid, customerName,
      milestones: payload.milestones, signals: payload.signals,
    });

    return { workloadId, ...copied, ...linkCounts };
  });
  return transaction();
}

// Attach optional milestone links + communication-signal assignments to a workload. Idempotent
// (INSERT OR IGNORE / addWorkloadSignal both dedupe), and safe to call with empty/absent arrays.
// Milestones carry the workload's account snapshot; signals go to signal_links (target_type
// 'workload') via the canonical helper, tagged with their milestone/opportunity qualifier.
function attachWorkloadAssociations(database, { workloadId, customerTpid, customerName, milestones, signals } = {}) {
  let milestoneCount = 0;
  let signalCount = 0;

  const milestoneRows = Array.isArray(milestones) ? milestones : [];
  if (milestoneRows.length) {
    const insertLink = database.prepare(
      `INSERT OR IGNORE INTO workload_milestone_links
         (workload_id, milestone_id, milestone_name, account_name, status_label,
          opportunity_id, opportunity_name, customer_tpid, customer_name)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const m of milestoneRows) {
      const milestoneId = optionalText(m?.milestoneId);
      if (!milestoneId) continue;
      assertActiveRecord(database, 'milestones', 'milestone_id', milestoneId);
      insertLink.run(
        workloadId,
        milestoneId,
        optionalText(m?.milestoneName),
        customerName,
        optionalText(m?.statusLabel),
        optionalText(m?.opportunityId),
        optionalText(m?.opportunityName),
        customerTpid,
        customerName,
      );
      milestoneCount += 1;
    }
  }

  const signalRows = Array.isArray(signals) ? signals : [];
  for (const s of signalRows) {
    const signalType = optionalText(s?.signalType);
    const nativeId = optionalText(s?.nativeId);
    if (!signalType || !nativeId) continue;
    // Fail-loud on a bad signal type is desirable, but a single malformed pick should not sink the
    // whole create — addWorkloadSignal throws on unknown types, so guard per-row and count successes.
    try {
      const res = signalLinks.addWorkloadSignal(database, {
        workloadId,
        signalType,
        nativeId,
        signalTitle: optionalText(s?.signalTitle),
        signalDate: optionalText(s?.signalDate),
        tpid: customerTpid,
        milestoneId: optionalText(s?.milestoneId),
        opportunityId: optionalText(s?.opportunityId),
        source: 'ai',
        rationale: optionalText(s?.rationale),
      });
      signalCount += res.changes || 0;
    } catch (err) {
      throw new Error(`Could not attach a discovered ${signalType} signal: ${err.message || String(err)}`);
    }
  }

  return { milestoneCount, signalCount };
}

function approveSuggestion(database, payload = {}) {
  const suggestionId = positiveId(payload.suggestionId, 'suggestionId');
  const transaction = database.transaction(() => {
    const suggestion = database.prepare(
      'SELECT * FROM active_workload_suggestions WHERE id = ?',
    ).get(suggestionId);
    if (!suggestion) throw new Error('The selected suggestion no longer exists.');

    const includedOpps = database.prepare(
      `SELECT opportunity_id, opportunity_name
       FROM active_workload_suggestion_opportunities
       WHERE suggestion_id = ? AND included = 1
       ORDER BY id`,
    ).all(suggestionId);
    const includedMilestones = database.prepare(
      `SELECT m.opportunity_id, o.opportunity_name, m.milestone_id, m.milestone_name, m.status_label
       FROM active_workload_suggestion_milestones m
       LEFT JOIN active_workload_suggestion_opportunities o
         ON o.suggestion_id = m.suggestion_id AND o.opportunity_id = m.opportunity_id
       WHERE m.suggestion_id = ? AND m.included = 1
       ORDER BY m.id`,
    ).all(suggestionId);

    // The workload carries ONE primary opportunity; any additional chosen opportunities are
    // represented through their milestone links. Reuse the standard createWorkload path so
    // the approved suggestion behaves exactly like a hand-created workload.
    const primaryOpportunity = includedOpps[0] || null;
    const { workloadId } = createWorkload(database, {
      name: suggestion.title,
      description: suggestion.description,
      category: optionalText(payload.category),
      opportunityId: primaryOpportunity?.opportunity_id || null,
      sspName: suggestion.ssp_name || null,
      tpid: suggestion.tpid || null,
      accountName: suggestion.account_name || null,
    });

    const insertLink = database.prepare(
      `INSERT OR IGNORE INTO workload_milestone_links
         (workload_id, milestone_id, milestone_name, account_name, status_label,
          opportunity_id, opportunity_name, customer_tpid, customer_name)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const milestone of includedMilestones) {
      insertLink.run(
        workloadId,
        milestone.milestone_id,
        milestone.milestone_name || null,
        suggestion.account_name || null,
        milestone.status_label || null,
        milestone.opportunity_id || null,
        milestone.opportunity_name || null,
        suggestion.tpid || null,
        suggestion.account_name || null,
      );
    }

    // Approval consumes the draft — delete it (children cascade). No suppression is recorded,
    // so the same workload can be proposed again on a future run.
    database.prepare('DELETE FROM workload_suggestions WHERE id = ?').run(suggestionId);

    return {
      workloadId,
      opportunityCount: includedOpps.length,
      milestoneCount: includedMilestones.length,
    };
  });
  return transaction();
}

function applyTemplate(database, payload = {}) {
  const workloadId = positiveId(payload.workloadId, 'workloadId');
  const templateId = positiveId(payload.templateId, 'templateId');
  const transaction = database.transaction(() => {
    const workload = database.prepare('SELECT id FROM active_workloads WHERE id = ?').get(workloadId);
    if (!workload) throw new Error('The target workload no longer exists.');
    const copied = instantiateTemplate(database, templateId, workloadId);
    database.prepare(
      `UPDATE workloads
       SET template_id = ?, is_reusable = 1, updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
    ).run(templateId, workloadId);
    return { workloadId, templateId, ...copied };
  });
  return transaction();
}

function saveTemplate(database, payload = {}) {
  const workloadId = positiveId(payload.workloadId, 'workloadId');
  const transaction = database.transaction(() => {
    const workload = database.prepare('SELECT * FROM active_workloads WHERE id = ?').get(workloadId);
    if (!workload) throw new Error('The source workload no longer exists.');
    const result = database.prepare(
      `INSERT INTO workload_templates
         (name, description, category, source_workload_id, is_shared)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(
      requiredText(workload.name || workload.title, 'Template name'),
      workload.description || null,
      workload.category || null,
      workloadId,
      workload.is_shared ? 1 : 0,
    );
    const templateId = Number(result.lastInsertRowid);
    const stages = database.prepare(
      'SELECT * FROM active_workload_stages WHERE workload_id = ? ORDER BY sort_order, id',
    ).all(workloadId);
    const actions = database.prepare(
      'SELECT * FROM active_workload_actions WHERE workload_id = ? ORDER BY sort_order, id',
    ).all(workloadId);
    const insertStage = database.prepare(
      `INSERT INTO workload_template_stages
         (template_id, name, description, sort_order)
       VALUES (?, ?, ?, ?)`,
    );
    const insertAction = database.prepare(
      `INSERT INTO workload_template_actions
         (template_id, template_stage_id, title, description, action_type, sort_order)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    const stageMap = new Map();
    for (const stage of stages) {
      const stageResult = insertStage.run(
        templateId,
        stage.name,
        stage.description || null,
        stage.sort_order || 0,
      );
      stageMap.set(stage.id, Number(stageResult.lastInsertRowid));
    }
    for (const action of actions) {
      insertAction.run(
        templateId,
        stageMap.get(action.stage_id) || null,
        action.title,
        action.description || null,
        action.action_type || 'task',
        action.sort_order || 0,
      );
    }
    database.prepare(
      `UPDATE workloads
       SET template_id = ?, is_reusable = 1, updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
    ).run(templateId, workloadId);
    return {
      templateId,
      stageCount: stages.length,
      actionCount: actions.length,
    };
  });
  return transaction();
}

module.exports = {
  applyTemplate,
  approveSuggestion,
  createWorkload,
  instantiateTemplate,
  saveTemplate,
};
