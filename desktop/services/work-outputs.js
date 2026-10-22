'use strict';

const crypto = require('node:crypto');
const { OUTPUTS, DEFAULT_OUTPUTS, hash, text, parseOutput } = require('./work-output-contract');
const { createOutputResearch, MAX_CONTEXT_CHARS, NO_MATCH_NOTICE } = require('./work-output-research');
const { assertPublicQuery } = require('./work-agent-web');
const { saveTask } = require('./customer-tasks');
const {
  RESEARCHABLE_KINDS, MAX_TRIAGE_GAPS, upstreamNotice, rawGapKey, gapRecord, listGaps, researchStamp, researchedGaps,
  parseGapTriage, parseGapAnswer, judgedOutcome,
} = require('./work-output-gaps');
const { assertActiveAccountTask } = require('../account-roster');

const RUN_TIMEOUT_MS = 6 * 60 * 1000;
const EVIDENCE_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const GAP_STOPPED = 'Gap research was stopped. Saved outputs and earlier answers were kept.';
const usable = output => output.content && ['ready', 'ready_with_gaps'].includes(output.status) && !output.needsRefresh;

function parseSaved(value, label) {
  try { return JSON.parse(value); }
  catch { throw new Error(`Saved ${label} is invalid. No research or output was silently replaced.`); }
}

function failureInfo(error) {
  let current = error;
  let statusCode;
  let code;
  let retryAt;
  for (let depth = 0; current && depth < 5; depth++, current = current.cause) {
    statusCode ??= current.statusCode;
    code ??= current.code;
    retryAt ??= current.retryAt;
  }
  return {
    message: error.message || String(error),
    ...(statusCode ? { statusCode } : {}), ...(code ? { code } : {}),
    ...(Number.isFinite(retryAt) ? { retryAt } : {}),
  };
}

function abortable(promise, signal) {
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    if (signal.aborted) abort();
    else signal.addEventListener('abort', abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

function createWorkOutputs({ db, resolveRuntime, client, ensureConnected, webTool, now = Date.now, timeoutMs = RUN_TIMEOUT_MS }) {
  const active = new Map();
  db.prepare(`UPDATE work_output_areas SET status = 'failed', error_json = ?, updated_at = ?
    WHERE status = 'working'`).run(JSON.stringify({ message: 'The app closed before this area finished. Saved evidence was retained; retry this area.' }), new Date(now()).toISOString());
  const timestamp = () => new Date(now()).toISOString();
  const getInvestigation = id => {
    const record = db.prepare('SELECT * FROM work_output_investigations WHERE id = ?').get(id);
    if (!record) throw new Error('Investigation not found. Open the task again.');
    const task = parseSaved(record.task_json, 'task');
    assertActiveAccountTask(db, task);
    return record;
  };
  const stamp = output => `${output.revision}:${output.status}:${output.needsRefresh ? 'stale' : 'current'}`;
  const sourceStamp = id => {
    const saved = db.prepare(`SELECT status,result_json FROM work_output_steps
      WHERE investigation_id=? AND area='shared' AND step='source email'`).get(id);
    return saved?.status === 'ready' ? hash(saved.result_json) : null;
  };
  const dependencies = (id, area, outputs) => {
    const task = parseSaved(getInvestigation(id).task_json, 'task');
    return {
      source: sourceStamp(id),
      ...(task.ownership ? { ownership: hash([task.ownership, task.owner]) } : {}),
      ...Object.fromEntries(OUTPUTS[area].dependencies.map(key => [key, stamp(outputs.find(output => output.area === key))])),
    };
  };
  const sourceCustomer = task => {
    const matches = db.prepare(`SELECT DISTINCT p.id FROM active_email_customer_links l
      JOIN active_cached_customer_profiles p ON p.tpid=l.tpid AND p.deleted_at IS NULL
      WHERE l.message_id=? AND l.match_method <> 'ai-rejected'`).all(task.sourceMessageId);
    return matches.length === 1 ? matches[0].id : null;
  };
  const gapRecords = id => db.prepare('SELECT * FROM work_output_gaps WHERE investigation_id = ? ORDER BY gap_key').all(id)
    .map(row => gapRecord(row, parseSaved));

  function get(id) {
    const record = getInvestigation(id);
    const rows = db.prepare('SELECT * FROM work_output_areas WHERE investigation_id = ?').all(id);
    const records = gapRecords(id);
    const outputs = [];
    for (const area of ['situation', 'technical', 'actions', 'reply']) {
      const row = rows.find(item => item.area === area);
      if (!row) throw new Error('Saved output areas are incomplete.');
      const previousDependencies = parseSaved(row.dependencies_json, 'output dependencies');
      const result = {
        area, ...OUTPUTS[area], optional: area === 'technical',
        status: row.status, version: row.version, revision: row.revision, focus: row.focus,
        instruction: row.instruction, content: row.content_json ? parseSaved(row.content_json, 'output') : null,
        gaps: parseSaved(row.gaps_json, 'output gaps'),
        sources: parseSaved(row.sources_json, 'output sources'),
        error: row.error_json ? parseSaved(row.error_json, 'output error') : null,
        model: row.model, checkedAt: row.checked_at, updatedAt: row.updated_at,
        needsRefresh: false,
        steps: db.prepare(`SELECT step, status, error_json, checked_at FROM work_output_steps
          WHERE investigation_id = ? AND area IN (?, 'shared') ORDER BY step`).all(id, area).map(step => ({
          step: step.step, status: step.status, checkedAt: step.checked_at,
          error: step.error_json ? parseSaved(step.error_json, 'research error') : null,
        })),
      };
      // An answer to a gap this output still lists also makes it out of date (the research key
      // is last so earlier saved dependencies without research compare equal).
      result.needsRefresh = Boolean(result.content && JSON.stringify(previousDependencies)
        !== JSON.stringify({ ...dependencies(id, area, outputs), ...researchStamp(result.gaps, records) }));
      outputs.push(result);
    }
    const createdTasks = db.prepare(`SELECT l.action_key, l.task_id, t.deleted_at FROM work_output_task_links l
      LEFT JOIN active_cached_customer_todos t ON t.id = l.task_id WHERE l.investigation_id = ?`).all(id).map(row => ({
      actionKey: row.action_key, taskId: row.task_id, deleted: Boolean(row.deleted_at),
    }));
    const task = parseSaved(record.task_json, 'task');
    const gaps = listGaps(outputs, records);
    const triage = db.prepare(`SELECT status, result_json, error_json, checked_at FROM work_output_steps
      WHERE investigation_id = ? AND area = 'gaps' AND step = 'gap triage'`).get(id);
    const triageResult = triage?.result_json ? parseSaved(triage.result_json, 'gap classification') : null;
    const job = active.get(`${id}:gaps`);
    return {
      id, task, outputs, createdTasks, defaultAreas: DEFAULT_OUTPUTS, defaultProfileId: sourceCustomer(task),
      gaps,
      gapTriage: {
        untriaged: gaps.filter(gap => gap.listed && !gap.kind).length,
        error: triage?.status === 'failed' && triage.error_json ? parseSaved(triage.error_json, 'gap classification error') : null,
        checkedAt: triage?.checked_at ?? null,
        technicalQuestion: triageResult?.technicalQuestion ?? null,
        model: triageResult?.model ?? null,
      },
      gapActivity: job ? { type: job.type, gapKey: job.gapKey } : null,
    };
  }

  function open(rawTask) {
    assertActiveAccountTask(db, rawTask);
    const task = {
      title: text(rawTask?.title, 'Task title', 300),
      sourceMessageId: text(rawTask?.sourceMessageId, 'Source email ID', 2000),
      summary: text(rawTask?.summary, 'Task summary', 3000, true),
      subject: text(rawTask?.subject, 'Email subject', 500, true),
      account: text(rawTask?.account, 'Account label', 300, true),
      from: text(rawTask?.from, 'Sender', 500, true),
      webLink: text(rawTask?.webLink, 'Source email link', 4000, true),
      date: text(rawTask?.date, 'Source date', 100, true),
      ...(rawTask?.ownership != null ? {
        ownership: text(rawTask.ownership, 'Task ownership', 10),
        owner: text(rawTask.owner, 'Task owner', 300, true) || null,
      } : {}),
    };
    if (task.ownership && !['direct', 'shared'].includes(task.ownership)) throw new Error('Invalid task ownership qualification.');
    const key = hash([task.sourceMessageId, task.title.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ')]);
    let record = db.prepare('SELECT id FROM work_output_investigations WHERE task_key = ?').get(key);
    if (!record) {
      const id = crypto.randomUUID();
      db.transaction(() => {
        db.prepare('INSERT INTO work_output_investigations(id,task_key,task_json,created_at,updated_at) VALUES (?,?,?,?,?)')
          .run(id, key, JSON.stringify(task), timestamp(), timestamp());
        for (const area of Object.keys(OUTPUTS)) db.prepare(`INSERT INTO work_output_areas(investigation_id,area,updated_at)
          VALUES (?,?,?)`).run(id, area, timestamp());
      })();
      record = { id };
    } else if (task.ownership) {
      const saved = parseSaved(getInvestigation(record.id).task_json, 'task');
      if (task.ownership !== saved.ownership || task.owner !== saved.owner) {
        db.prepare('UPDATE work_output_investigations SET task_json=?,updated_at=? WHERE id=?')
          .run(JSON.stringify({ ...saved, ownership: task.ownership, owner: task.owner, summary: task.summary }), timestamp(), record.id);
      }
    }
    return get(record.id);
  }

  async function run({ investigationId, area, mode = 'generate', focus, instruction = '', requestId, userName }, onProgress = () => {}, owner = null) {
    const before = get(investigationId);
    const previous = before.outputs.find(item => item.area === area);
    if (!previous) throw new Error('Choose a valid output area.');
    if (!['generate', 'retry', 'refresh', 'refine'].includes(mode)) throw new Error('Invalid output action.');
    if (previous.status === 'working') throw new Error('This output area is already working.');
    if (before.outputs.some(item => item.status === 'working')) throw new Error('Another area is working. Wait for it or stop it before running this area.');
    if (active.has(`${investigationId}:gaps`)) throw new Error('Gap research is running for this subject. Wait for it or stop it before running an output.');
    if (mode === 'retry' && previous.status !== 'failed') throw new Error('Only a failed area can be retried.');
    if (mode === 'generate' && previous.status !== 'idle') throw new Error('This area already has work. Choose Retry, Refresh or Refine.');
    if (mode === 'refine' && !usable(previous)) throw new Error('Only a current usable output can be refined. Refresh or retry it first.');
    if (previous.error?.retryAt > now()) throw new Error(`This area's service cooldown ends at ${new Date(previous.error.retryAt).toLocaleString()}.`);
    if (OUTPUTS[area].dependencies.some(key => before.outputs.find(item => item.area === key).status === 'working')) {
      throw new Error('An upstream output is still working. Wait for it before generating this area.');
    }
    const nextFocus = mode === 'retry' ? previous.focus : focus === undefined ? previous.focus : text(focus, 'Research focus', 1200, true);
    const nextInstruction = mode === 'retry' ? previous.instruction : text(instruction, 'Refinement', 2000, true);
    if (mode === 'refine' && !nextInstruction) throw new Error('Describe the refinement to make.');
    if (mode === 'refine' && nextFocus !== previous.focus) throw new Error('Changing research focus requires Refresh.');
    if (area === 'technical' && !nextFocus) {
      db.prepare(`UPDATE work_output_areas SET status='needs_input',error_json=?,revision=revision+1,updated_at=?
        WHERE investigation_id=? AND area=?`).run(JSON.stringify({ message: 'Enter the specific technical question to research.' }), timestamp(), investigationId, area);
      return { ok: false, error: 'Enter the specific technical question to research.', investigation: get(investigationId) };
    }
    db.prepare(`UPDATE work_output_areas SET status='working',revision=revision+1,focus=?,instruction=?,error_json=NULL,updated_at=?
      WHERE investigation_id=? AND area=?`).run(nextFocus, nextInstruction, timestamp(), investigationId, area);
    const key = `${investigationId}:${area}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error('This area reached its six-minute time budget. Saved steps were kept; retry only this area.')), timeoutMs);
    active.set(key, { controller, owner });
    const signal = controller.signal;
    const progress = event => {
      if (!signal.aborted || event.phase === 'failed') onProgress({ ...event, investigationId, area, requestId });
    };
    const inheritedGaps = mode === 'refine' || (mode === 'retry' && nextInstruction) ? [...previous.gaps] : [];
    const upstream = [];
    for (const dependency of OUTPUTS[area].dependencies) {
      const output = before.outputs.find(item => item.area === dependency);
      if (dependency === 'technical' && output.status === 'idle') continue;
      if (usable(output)) {
        upstream.push({ area: dependency, content: output.content, gaps: output.gaps, sources: output.sources, checkedAt: output.checkedAt });
        inheritedGaps.push(...output.gaps.map(gap => Object.values(OUTPUTS).some(spec => gap.startsWith(`${spec.title}: `))
          ? gap : `${output.title}: ${gap}`));
      } else {
        inheritedGaps.push(upstreamNotice(output.title, output.needsRefresh ? 'out of date' : output.status.replaceAll('_', ' ')));
      }
    }
    // Research answers resolve their questions, so an answered question is not carried forward.
    // A partial answer keeps its question open for the writer to narrow.
    const records = gapRecords(investigationId);
    const answered = new Set(records.filter(record => record.status === 'answered').map(record => record.key));
    const researched = researchedGaps(records);
    const saveStep = (step, inputHash, status, result, error) => db.prepare(`
      INSERT INTO work_output_steps(investigation_id,area,step,input_hash,status,result_json,error_json,checked_at)
      VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(investigation_id,area,step) DO UPDATE SET
      input_hash=excluded.input_hash,status=excluded.status,result_json=COALESCE(excluded.result_json,work_output_steps.result_json),
      error_json=excluded.error_json,checked_at=excluded.checked_at
    `).run(investigationId, step === 'source email' ? 'shared' : area, step, inputHash, status, result ? JSON.stringify(result) : null, error ? JSON.stringify(error) : null, timestamp());
    const step = async (name, input, execute) => {
      signal.throwIfAborted();
      const inputHash = hash(input);
      const shared = name === 'source email';
      const saved = db.prepare('SELECT * FROM work_output_steps WHERE investigation_id=? AND area=? AND step=?')
        .get(investigationId, shared ? 'shared' : area, name);
      const reusable = saved?.input_hash === inputHash && saved.status === 'ready' && now() - Date.parse(saved.checked_at) <= EVIDENCE_MAX_AGE_MS;
      if ((mode !== 'refresh' || (shared && area !== 'situation')) && reusable) {
        progress({ phase: 'reuse', label: `Reusing saved ${name} from ${new Date(saved.checked_at).toLocaleString()}.` });
        return parseSaved(saved.result_json, `${name} evidence`);
      }
      if (saved?.status === 'blocked' && mode !== 'refresh') {
        const blocked = parseSaved(saved.error_json, 'access exclusion');
        throw Object.assign(new Error('This research step remains excluded after an access denial. Use Refresh only after verifying access; retry does not grant permission.'), {
          statusCode: blocked.statusCode, code: blocked.code,
        });
      }
      if (shared && saved?.status === 'failed' && mode === 'generate') {
        throw new Error('The shared source-email read failed earlier. Retry this area explicitly to recheck it; no automatic repeat was sent.');
      }
      if (mode === 'refine') throw new Error('Saved research is missing or expired. Refresh this area instead of refining against incomplete evidence.');
      progress({ phase: 'research', label: `Checking ${name} for ${OUTPUTS[area].title}.` });
      try {
        const result = await abortable(execute(), signal);
        signal.throwIfAborted();
        saveStep(name, inputHash, 'ready', result, null);
        return result;
      } catch (error) {
        const detail = failureInfo(error);
        saveStep(name, inputHash, detail.statusCode === 403 ? 'blocked' : 'failed', null, detail);
        throw error;
      }
    };
    try {
      progress({ phase: 'starting', label: `Preparing ${OUTPUTS[area].title}; other outputs are unchanged.` });
      const { runtime, model } = await abortable(resolveRuntime(), signal);
      signal.throwIfAborted();
      const research = createOutputResearch({ client, ensureConnected, signal, onProgress: progress, webTool });
      const source = await step('source email', { id: before.task.sourceMessageId }, () => research.source(before.task));
      const inputs = dependencies(investigationId, area, before.outputs);
      const evidence = [{ label: 'Source email', ...source }];
      if (area !== 'reply') {
        const intent = area === 'situation' ? 'Find the latest directly related status, decisions, changes and whether the ask is resolved.'
          : area === 'actions' ? 'Find explicit commitments, action owners, confirmed deadlines and prerequisites for this exact ask.'
            : 'Find confirmed requirements and constraints relevant only to this technical question.';
        const query = `${intent}\nEmail subject: ${before.task.subject || before.task.title}\nTask: ${before.task.title}${before.task.date ? `\nSource date: ${before.task.date}. Prioritize relevant updates since then.` : ''}${before.task.account ? `\nAccount: ${before.task.account}` : ''}${nextFocus ? `\nFocus: ${nextFocus}` : ''}`;
        evidence.push({ label: 'Focused Microsoft 365 search', ...await step('focused work search', { query }, () => research.workSearch(query)) });
      }
      if (area === 'technical') {
        const queryResult = await step('public query', { focus: nextFocus }, async () => {
          const completion = await abortable(runtime.run('work-output-public-query', {
            input: { context: { technicalQuestion: nextFocus } }, deps: { signal },
          }), signal);
          assertCompletion(completion);
          let value;
          try { value = JSON.parse(completion.content); } catch { throw new Error('The model did not produce a valid public research query. Retry this area.'); }
          const query = text(value?.query, 'Public technical query', 1000);
          assertPublicQuery(query, [before.task.account, before.task.from, before.task.title, before.task.subject, before.task.sourceMessageId, userName]);
          return { query };
        });
        evidence.push({ label: 'Public technical search summary', ...await step('public research', queryResult, () => research.publicSearch(queryResult.query, [
          before.task.account, before.task.from, before.task.title, before.task.subject, before.task.sourceMessageId, userName,
        ])) });
      }
      const gaps = [...new Set([...inheritedGaps.filter(gap => !answered.has(rawGapKey(gap))), ...evidence.flatMap(item => item.gaps)])];
      const context = {
        area, task: before.task, userName, focus: nextFocus, instruction: nextInstruction,
        previousOutput: mode === 'refine' || (mode === 'retry' && nextInstruction) ? previous.content : null,
        evidence, upstream, researchedGaps: researched, limitations: gaps,
      };
      if (JSON.stringify(context).length > MAX_CONTEXT_CHARS) {
        throw new Error('This area exceeds its total evidence budget. Narrow the focus and Refresh. No evidence was silently truncated.');
      }
      progress({ phase: 'writing', label: `Writing ${OUTPUTS[area].title} from the saved evidence.` });
      const completion = await abortable(runtime.run('work-output', { input: { context }, deps: { signal } }), signal);
      assertCompletion(completion);
      signal.throwIfAborted();
      const content = parseOutput(completion.content, area);
      const allGaps = [...new Set([...gaps, ...content.gaps])].filter(gap => !answered.has(rawGapKey(gap)));
      const sources = [...new Map([...evidence, ...upstream, ...researched].flatMap(item => item.sources).map(item => [item.url, item])).values()];
      db.prepare(`UPDATE work_output_areas SET status=?,version=version+1,content_json=?,gaps_json=?,sources_json=?,
        dependencies_json=?,error_json=NULL,model=?,checked_at=?,updated_at=? WHERE investigation_id=? AND area=?`)
        .run(content.needsInput ? 'needs_input' : allGaps.length ? 'ready_with_gaps' : 'ready',
          JSON.stringify(content), JSON.stringify(allGaps), JSON.stringify(sources),
          JSON.stringify({ ...inputs, ...researchStamp(allGaps, records) }),
          completion.model || model, timestamp(), timestamp(), investigationId, area);
      const current = get(investigationId);
      progress({ phase: 'saved', label: `${OUTPUTS[area].title} saved${current.outputs.find(item => item.area === area).needsRefresh ? '; upstream evidence changed, so it needs refresh' : ''}.` });
      return { ok: true, investigation: current };
    } catch (error) {
      const detail = failureInfo(signal.aborted ? signal.reason : error);
      db.prepare(`UPDATE work_output_areas SET status='failed',error_json=?,updated_at=? WHERE investigation_id=? AND area=?`)
        .run(JSON.stringify(detail), timestamp(), investigationId, area);
      progress({ phase: 'failed', label: detail.message });
      return { ok: false, error: detail.message, investigation: get(investigationId) };
    } finally {
      clearTimeout(timer);
      active.delete(key);
    }
  }

  function cancel(investigationId, area, owner) {
    if (area != null && area !== 'gaps' && !OUTPUTS[area]) throw new Error('Invalid output area.');
    let cancelled = 0;
    for (const [key, run] of active) {
      if (key.startsWith(`${investigationId}:`) && (area == null || key === `${investigationId}:${area}`) && run.owner === owner) {
        run.controller.abort(new Error(key === `${investigationId}:gaps` ? GAP_STOPPED : 'This area was stopped. Saved evidence and other outputs were retained.'));
        cancelled++;
      }
    }
    return { ok: true, cancelled };
  }

  // Gap classification and gap research run one at a time per subject and never alongside an
  // output run, so no output is written while the research it reads is changing.
  function assertGapsIdle(investigation) {
    if (active.has(`${investigation.id}:gaps`)) throw new Error('Gap research is already running for this subject. Wait for it or stop it.');
    if (investigation.outputs.some(item => item.status === 'working') || [...active.keys()].some(key => key.startsWith(`${investigation.id}:`))) {
      throw new Error('An output is working. Wait for it or stop it before classifying or researching gaps.');
    }
  }

  function startGapJob({ investigationId, type, gapKey = null, owner, onProgress, requestId, budgetMessage }) {
    const key = `${investigationId}:gaps`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error(budgetMessage)), timeoutMs);
    active.set(key, { controller, owner, type, gapKey });
    const progress = event => {
      if (!controller.signal.aborted || event.phase === 'failed') onProgress({ ...event, investigationId, area: 'gaps', gapKey, requestId });
    };
    return { signal: controller.signal, progress, finish: () => { clearTimeout(timer); active.delete(key); } };
  }

  const saveTriageStep = (investigationId, inputHash, status, result, error) => db.prepare(`
    INSERT INTO work_output_steps(investigation_id,area,step,input_hash,status,result_json,error_json,checked_at)
    VALUES (?,'gaps','gap triage',?,?,?,?,?) ON CONFLICT(investigation_id,area,step) DO UPDATE SET
    input_hash=excluded.input_hash,status=excluded.status,result_json=COALESCE(excluded.result_json,work_output_steps.result_json),
    error_json=excluded.error_json,checked_at=excluded.checked_at
  `).run(investigationId, inputHash, status, result ? JSON.stringify(result) : null, error ? JSON.stringify(error) : null, timestamp());

  // Classifies the listed gaps that have no kind yet, at most MAX_TRIAGE_GAPS per call. Either
  // every gap in the batch is classified or none is.
  async function triageGaps({ investigationId, requestId } = {}, onProgress = () => {}, owner = null) {
    const before = get(investigationId);
    assertGapsIdle(before);
    const pending = before.gaps.filter(gap => gap.listed && !gap.kind).slice(0, MAX_TRIAGE_GAPS);
    if (!pending.length) return { ok: true, classified: 0, investigation: before };
    if (before.gapTriage.error?.retryAt > now()) {
      throw new Error(`Gap classification is paused by a service cooldown until ${new Date(before.gapTriage.error.retryAt).toLocaleString()}.`);
    }
    const ids = pending.map((_, index) => `G${index + 1}`);
    const technical = before.outputs.find(item => item.area === 'technical');
    const suggestTechnicalQuestion = !technical.focus && ['idle', 'needs_input'].includes(technical.status);
    const inputHash = hash(pending.map(gap => gap.key));
    const plural = count => `${count} open question${count === 1 ? '' : 's'}`;
    const { signal, progress, finish } = startGapJob({
      investigationId, type: 'triage', owner, onProgress, requestId,
      budgetMessage: 'Gap classification reached its time budget. Nothing was classified; retry classification.',
    });
    let result;
    try {
      progress({ phase: 'starting', label: `Classifying ${plural(pending.length)}.` });
      const { runtime, model } = await abortable(resolveRuntime(), signal);
      signal.throwIfAborted();
      const { title, subject, account, date } = before.task;
      const completion = await abortable(runtime.run('work-output-gap-triage', {
        input: { context: {
          task: { title, subject, account, date },
          gaps: pending.map((gap, index) => ({ id: ids[index], question: gap.text, raisedBy: gap.areas.map(area => OUTPUTS[area].title) })),
          suggestTechnicalQuestion,
        } },
        deps: { signal },
      }), signal);
      signal.throwIfAborted();
      assertCompletion(completion, 'The model did not finish classifying the gaps. Nothing was classified; retry classification.');
      const { classified, technicalQuestion } = parseGapTriage(completion.content, ids);
      db.transaction(() => {
        const upsert = db.prepare(`INSERT INTO work_output_gaps(investigation_id,gap_key,text,kind,kind_reason,updated_at)
          VALUES (?,?,?,?,?,?) ON CONFLICT(investigation_id,gap_key) DO UPDATE SET
          text=excluded.text,kind=excluded.kind,kind_reason=excluded.kind_reason,updated_at=excluded.updated_at`);
        pending.forEach((gap, index) => {
          const { kind, reason } = classified.get(ids[index]);
          upsert.run(investigationId, gap.key, gap.text, kind, reason, timestamp());
        });
        saveTriageStep(investigationId, inputHash, 'ready', {
          technicalQuestion: (suggestTechnicalQuestion && technicalQuestion) || before.gapTriage.technicalQuestion,
          model: completion.model || model,
        }, null);
      })();
      const remaining = before.gapTriage.untriaged - pending.length;
      progress({ phase: 'saved', label: `Classified ${plural(pending.length)}${remaining ? `; ${plural(remaining)} remain to classify` : ''}.` });
      result = { ok: true, classified: pending.length };
    } catch (error) {
      const detail = failureInfo(signal.aborted ? signal.reason : error);
      saveTriageStep(investigationId, inputHash, 'failed', null, detail);
      progress({ phase: 'failed', label: detail.message });
      result = { ok: false, error: detail.message };
    } finally {
      finish();
    }
    return { ...result, investigation: get(investigationId) };
  }

  const searchedAgainNote = () => `Searched again on ${new Date(now()).toLocaleString()}: no further answer was found, so the earlier partial answer is kept.`;

  // Saves a research result. A partial answer is kept until a later search improves on it.
  function saveGapResearch(investigationId, gap, outcome) {
    const resolved = ['answered', 'partial'].includes(outcome.status);
    if (gap.status === 'partial' && !resolved) {
      db.prepare('UPDATE work_output_gaps SET notes_json=?,error_json=NULL,updated_at=? WHERE investigation_id=? AND gap_key=?')
        .run(JSON.stringify([...gap.notes.filter(note => !note.startsWith('Searched again on ')), searchedAgainNote()]), timestamp(), investigationId, gap.key);
      return 'partial-kept';
    }
    db.prepare(`UPDATE work_output_gaps SET status=?,answer=?,quote=?,query=?,sources_json=?,notes_json=?,error_json=NULL,
      model=?,checked_at=?,updated_at=? WHERE investigation_id=? AND gap_key=?`).run(
      outcome.status, outcome.answer, outcome.quote, outcome.query, JSON.stringify(resolved ? outcome.sources : []),
      JSON.stringify(outcome.notes), outcome.model, timestamp(), timestamp(), investigationId, gap.key,
    );
    return outcome.status;
  }

  function saveGapFailure(investigationId, gap, detail, query) {
    if (gap.status === 'partial') {
      db.prepare('UPDATE work_output_gaps SET error_json=?,updated_at=? WHERE investigation_id=? AND gap_key=?')
        .run(JSON.stringify(detail), timestamp(), investigationId, gap.key);
      return;
    }
    db.prepare(`UPDATE work_output_gaps SET status=?,answer=NULL,quote=NULL,query=?,sources_json='[]',notes_json='[]',error_json=?,
      updated_at=? WHERE investigation_id=? AND gap_key=?`).run(
      detail.statusCode === 403 ? 'blocked' : 'failed', query, JSON.stringify(detail), timestamp(), investigationId, gap.key,
    );
  }

  // Researches one classified gap: a focused WorkIQ search for work-data gaps, or a generic
  // public search for documentation gaps. A model then judges the retrieved evidence, and an
  // answer is saved only when its supporting quote is found verbatim in that evidence.
  async function researchGap({ investigationId, gapKey, requestId, userName } = {}, onProgress = () => {}, owner = null) {
    const before = get(investigationId);
    const key = text(gapKey, 'Gap key', 200);
    const gap = before.gaps.find(item => item.key === key);
    if (!gap) throw new Error('This question is not in the gap list. Reopen the research subject to see its current gaps.');
    if (!gap.listed) throw new Error('No current output lists this question any more, so it was not researched.');
    if (!gap.kind) throw new Error('Classify this gap before researching it.');
    if (!RESEARCHABLE_KINDS.includes(gap.kind)) {
      throw new Error('Only gaps answerable from work data or public documentation are researched. Ask a person or keep this as a limitation.');
    }
    if (gap.status === 'answered') throw new Error('This gap is already answered.');
    assertGapsIdle(before);
    if (gap.error?.retryAt > now()) throw new Error(`Research for this gap is paused by a service cooldown until ${new Date(gap.error.retryAt).toLocaleString()}.`);
    const { task } = before;
    const privateTerms = [task.account, task.from, task.title, task.subject, task.sourceMessageId, userName];
    const { signal, progress, finish } = startGapJob({
      investigationId, type: 'research', gapKey: key, owner, onProgress, requestId,
      budgetMessage: 'Gap research reached its six-minute time budget. Nothing was saved as an answer; research this gap again.',
    });
    let query = null;
    let result;
    try {
      progress({ phase: 'starting', label: `Researching: ${gap.text}` });
      const { runtime, model } = await abortable(resolveRuntime(), signal);
      signal.throwIfAborted();
      const research = createOutputResearch({ client, ensureConnected, signal, onProgress: progress, webTool });
      let evidence;
      if (gap.kind === 'm365') {
        query = `Find information that answers this open question: ${gap.text}\nEmail subject: ${task.subject || task.title}\nTask: ${task.title}${task.date ? `\nSource date: ${task.date}. Prioritize relevant updates since then.` : ''}${task.account ? `\nAccount: ${task.account}` : ''}`;
        progress({ phase: 'research', label: 'Searching Microsoft 365 work data for this question.' });
        evidence = { label: 'Focused Microsoft 365 search', ...await abortable(research.workSearch(query), signal) };
      } else {
        progress({ phase: 'research', label: 'Writing a generic public search query for this question.' });
        const completion = await abortable(runtime.run('work-output-public-query', {
          input: { context: { technicalQuestion: gap.text } }, deps: { signal },
        }), signal);
        signal.throwIfAborted();
        assertCompletion(completion, 'The model did not finish the public search query. Nothing was searched; research this gap again.');
        let value;
        try { value = JSON.parse(completion.content); } catch { throw new Error('The model did not produce a valid public search query. Nothing was searched; research this gap again.'); }
        query = text(value?.query, 'Public research query', 1000);
        assertPublicQuery(query, privateTerms);
        progress({ phase: 'research', label: 'Searching public documentation for this question.' });
        evidence = { label: 'Public technical search summary', ...await abortable(research.publicSearch(query, privateTerms), signal) };
      }
      signal.throwIfAborted();
      let outcome;
      if (evidence.gaps.includes(NO_MATCH_NOTICE)) {
        outcome = { status: 'still_open', answer: null, quote: null, notes: [NO_MATCH_NOTICE], model: null };
      } else {
        const context = {
          question: gap.text,
          task: { title: task.title, subject: task.subject, account: task.account, date: task.date },
          evidence: { label: evidence.label, text: evidence.text, sources: evidence.sources },
        };
        if (JSON.stringify(context).length > MAX_CONTEXT_CHARS) {
          throw new Error('The retrieved evidence exceeds the research budget. No evidence was silently truncated; nothing was saved as an answer.');
        }
        progress({ phase: 'writing', label: 'Checking whether the retrieved evidence answers the question.' });
        const completion = await abortable(runtime.run('work-output-gap-answer', { input: { context }, deps: { signal } }), signal);
        signal.throwIfAborted();
        assertCompletion(completion, 'The model did not finish judging the research. Nothing was saved as an answer; research this gap again.');
        const judged = judgedOutcome(parseGapAnswer(completion.content), evidence.text);
        outcome = { ...judged, notes: [...judged.notes, ...evidence.gaps], model: completion.model || model };
      }
      const saved = saveGapResearch(investigationId, gap, { ...outcome, query, sources: evidence.sources });
      progress({ phase: 'saved', label: {
        answered: 'Answered from the retrieved evidence. Outputs that list this question now need refresh.',
        partial: 'Partly answered from the retrieved evidence. Outputs that list this question now need refresh.',
        still_open: 'The retrieved evidence did not answer this question.',
        'partial-kept': 'No further answer was found; the earlier partial answer is kept.',
      }[saved] });
      result = saved === 'partial-kept' ? { ok: true, status: 'partial', kept: true } : { ok: true, status: saved, kept: false };
    } catch (error) {
      const detail = failureInfo(signal.aborted ? signal.reason : error);
      saveGapFailure(investigationId, gap, detail, query);
      progress({ phase: 'failed', label: detail.message });
      result = { ok: false, error: detail.message };
    } finally {
      finish();
    }
    return { ...result, investigation: get(investigationId) };
  }

  function createTasks({ investigationId, version, actionKeys, profileId, workloadId }) {
    return db.transaction(() => {
      const investigation = get(investigationId);
      const output = investigation.outputs.find(item => item.area === 'actions');
      if (!usable(output) || output.version !== version) throw new Error('The checklist changed or needs refresh. Review the current checklist before creating Tasks.');
      if (!Array.isArray(actionKeys) || !actionKeys.length || actionKeys.some(key => !output.content.actions.some(item => item.key === key))) {
        throw new Error('Select valid checklist items to create as Tasks.');
      }
      let customerId = profileId;
      if (customerId === undefined) customerId = sourceCustomer(investigation.task);
      let created = 0;
      let existing = 0;
      for (const key of new Set(actionKeys)) {
        if (db.prepare('SELECT 1 FROM work_output_task_links WHERE investigation_id=? AND action_key=?').get(investigationId, key)) {
          existing++;
          continue;
        }
        const item = output.content.actions.find(action => action.key === key);
        const todo = saveTask(db, {
          profileId: customerId, workloadId: workloadId ?? null, title: item.title, dueAt: item.dueDate,
          description: [
            item.description,
            item.owner ? `Owner (${item.ownerStatus}): ${item.owner}` : 'Owner: unassigned',
            item.dependsOn.length ? `Prerequisites: ${item.dependsOn.join('; ')}` : '',
            `Evidence / qualification: ${item.evidence}`,
            ...output.gaps.map(gap => `Research gap: ${gap}`),
          ].filter(Boolean).join('\n'),
          sourceRef: investigation.task.webLink || null,
        });
        db.prepare('INSERT INTO work_output_task_links(investigation_id,action_key,task_id) VALUES (?,?,?)')
          .run(investigationId, key, todo.id);
        created++;
      }
      return { ok: true, created, existing, investigation: get(investigationId) };
    })();
  }

  function draft({ investigationId, version }) {
    const investigation = get(investigationId);
    const output = investigation.outputs.find(item => item.area === 'reply');
    if (!usable(output) || output.version !== version) throw new Error('The reply changed, failed, or needs refresh. Review the current reply before drafting it.');
    return { messageId: investigation.task.sourceMessageId, comment: output.content.content };
  }

  // Saved research subjects, most recently active first. An unreadable saved task is listed with
  // its error so it stays visible and removable instead of hiding the other subjects.
  function list() {
    const statuses = new Map();
    for (const row of db.prepare('SELECT investigation_id, area, status FROM work_output_areas').all()) {
      if (!statuses.has(row.investigation_id)) statuses.set(row.investigation_id, {});
      statuses.get(row.investigation_id)[row.area] = row.status;
    }
    return db.prepare(`SELECT i.id, i.task_json, i.created_at,
        MAX(i.updated_at, COALESCE((SELECT MAX(a.updated_at) FROM work_output_areas a WHERE a.investigation_id = i.id), '')) AS last_activity
      FROM work_output_investigations i ORDER BY last_activity DESC, i.created_at DESC, i.id`).all().flatMap(row => {
      let task = null;
      let error = null;
      try {
        task = parseSaved(row.task_json, 'task');
      } catch (failure) {
        error = failure.message;
      }
      if (task) {
        try { assertActiveAccountTask(db, task); }
        catch (failure) {
          if (failure.code === 'ACCOUNT_ARCHIVED') return [];
          throw failure;
        }
      }
      if (!error && (!task || typeof task !== 'object' || typeof task.title !== 'string' || typeof task.sourceMessageId !== 'string')) {
        task = null;
        error = 'Saved task is invalid. No research or output was silently replaced.';
      }
      return [{ id: row.id, task, error, createdAt: row.created_at, updatedAt: row.last_activity, areas: statuses.get(row.id) || {} }];
    });
  }

  // Deletes the saved research for one subject. Tasks created from its checklist are kept.
  function remove(rawId) {
    const id = text(rawId, 'Investigation ID', 200);
    getInvestigation(id);
    if ([...active.keys()].some(key => key.startsWith(`${id}:`))
      || db.prepare("SELECT 1 FROM work_output_areas WHERE investigation_id = ? AND status = 'working'").get(id)) {
      throw new Error('This research subject is still working. Stop it before removing it.');
    }
    db.transaction(() => {
      for (const table of ['work_output_task_links', 'work_output_steps', 'work_output_gaps', 'work_output_areas']) {
        db.prepare(`DELETE FROM ${table} WHERE investigation_id = ?`).run(id);
      }
      db.prepare('DELETE FROM work_output_investigations WHERE id = ?').run(id);
    })();
    return { ok: true, removed: id };
  }

  return { open, get, run, cancel, createTasks, draft, list, remove, triageGaps, researchGap };
}

function assertCompletion(completion, message = 'The model did not finish this output. Saved evidence was kept; retry only this area.') {
  if (!completion?.content?.trim() || ['length', 'incomplete', 'failed', 'content_filter'].includes(completion.finishReason)) {
    throw new Error(message);
  }
}

module.exports = { createWorkOutputs, failureInfo, assertCompletion };
