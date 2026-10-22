'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('node:events');

const { createWorkIqClient } = require('../workiq-client');

// Build a fake child process that looks enough like a spawned proc for start().
function fakeProc() {
  const proc = new EventEmitter();
  proc.pid = 4242;
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  const stdin = new EventEmitter();
  stdin.writable = true;
  stdin.write = () => true;
  proc.stdin = stdin;
  proc.kill = () => {};
  return proc;
}

test('dev fallback (binary missing, not packaged) uses npx via the corp proxy, never registry.npmjs.org', async () => {
  const calls = [];
  const proc = fakeProc();
  const client = createWorkIqClient({
    resolveBin: () => null,        // simulate: package not installed
    packaged: () => false,         // simulate: running in dev
    spawnProcess: (cmd, args, opts) => {
      calls.push({ cmd, args, opts });
      return proc;                 // never becomes ready; we only inspect the spawn args
    },
  });

  const started = client.start();
  // The fake never responds; emit 'error' so start()'s ready timer is cleared and the
  // promise settles (keeps the test process from hanging on the 90s ready timeout).
  proc.emit('error', new Error('test teardown'));
  await started.catch(() => {});

  assert.strictEqual(calls.length, 1, 'expected exactly one spawn');
  const { cmd, args, opts } = calls[0];
  assert.strictEqual(cmd, 'npx');
  assert.deepStrictEqual(args, ['-y', '@microsoft/workiq', 'mcp']);

  const proxy = 'https://packagefeedproxy.microsoft.io/npm';
  assert.strictEqual(opts.env.npm_config_registry, proxy);
  assert.strictEqual(opts.env['npm_config_@microsoft:registry'], proxy);

  // Guarantee: the blocked public registry is never handed to the child.
  assert.ok(!JSON.stringify(opts.env).includes('registry.npmjs.org'),
    'must not reference registry.npmjs.org');
});

test('packaged app with missing binary fails loudly and NEVER spawns npx', async () => {
  const calls = [];
  const client = createWorkIqClient({
    resolveBin: () => null,        // simulate: corrupt/partial install
    packaged: () => true,          // simulate: packaged Electron build
    spawnProcess: (cmd, args, opts) => {
      calls.push({ cmd, args, opts });
      return fakeProc();
    },
  });

  await assert.rejects(
    client.start(),
    /WorkIQ is not available in this installation/,
  );
  assert.strictEqual(calls.length, 0, 'packaged app must not spawn any process (no npm registry contact)');
});

test('when the local binary exists it launches directly with no shell and no npx', async () => {
  const calls = [];
  const proc = fakeProc();
  const client = createWorkIqClient({
    resolveBin: () => 'C:/fake/resources/app.asar.unpacked/node_modules/@microsoft/workiq/bin/win-x64/workiq.exe',
    packaged: () => true,
    spawnProcess: (cmd, args, opts) => {
      calls.push({ cmd, args, opts });
      return proc;
    },
  });

  const started = client.start();
  proc.emit('error', new Error('test teardown'));
  await started.catch(() => {});

  assert.strictEqual(calls.length, 1);
  const { cmd, args, opts } = calls[0];
  assert.ok(cmd.endsWith('workiq.exe'), 'launches the native binary directly');
  assert.deepStrictEqual(args, ['mcp']);
  assert.notStrictEqual(cmd, 'npx');
  // Native exe is launched without a shell (path contains a space in the real install).
  assert.ok(!opts.shell, 'native binary must not be launched via a shell');
});

// A fake WorkIQ MCP process that completes the handshake and answers each tool call with
// toolResult(message). Returning undefined leaves that call unanswered.
function respondingProc(toolResult, requests = []) {
  const proc = fakeProc();
  proc.pid = 0; // A mock must never target an actual Windows PID during cleanup.
  const reply = (body) => queueMicrotask(() => proc.stdout.emit('data', JSON.stringify({ jsonrpc: '2.0', ...body }) + '\n'));
  proc.stdin.write = (text) => {
    const message = JSON.parse(text);
    requests.push(message);
    if (!message.id) return true;
    let result;
    if (message.method === 'initialize') result = { protocolVersion: '2024-11-05', capabilities: {} };
    else if (message.params?.name === 'accept_eula') result = { content: [] };
    else {
      try { result = toolResult(message); }
      catch (error) {
        reply({ id: message.id, error: { code: -32603, message: error.message } });
        return true;
      }
    }
    if (result !== undefined) reply({ id: message.id, result });
    return true;
  };
  return proc;
}

function readyClient(toolResult, extraOpts = {}) {
  const requests = [];
  const proc = respondingProc(toolResult, requests);
  return {
    requests,
    proc,
    client: createWorkIqClient({ resolveBin: () => 'C:\\fake\\workiq.exe', spawnProcess: () => proc, packaged: () => true, ...extraOpts }),
  };
}

async function waitFor(check, label) {
  for (let i = 0; i < 200; i += 1) {
    if (check()) return;
    await new Promise(setImmediate);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

const textResult = (text) => ({ content: [{ type: 'text', text }] });
const answer = (proc, id, result) => proc.stdout.emit('data', JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n');

test('readTool denies writes and alternate agents without starting WorkIQ', async () => {
  const { client, requests } = readyClient(() => ({ content: [] }));
  for (const name of ['create_entity', 'update_entity', 'delete_entity', 'do_action', 'call_function']) {
    await assert.rejects(client.readTool(name, {}), /Only research tools are allowed/);
  }
  await assert.rejects(client.readTool('ask', { agentId: 'different-agent', question: 'Hi' }), /cannot delegate/);
  assert.equal(requests.length, 0);
});

test('readTool surfaces MCP tool errors rather than treating them as empty evidence', async () => {
  const { client } = readyClient(() => ({ isError: true, content: [{ type: 'text', text: 'Access denied by policy' }] }));
  try {
    await assert.rejects(client.readTool('retrieve', { query: ['Test'], strategy: 'copilot' }), /Access denied by policy/);
  } finally { client.stop(); }
});

test('readTool retries a transient WorkIQ backend fault, then returns the successful result', async () => {
  let attempts = 0;
  const retries = [];
  const { client, requests } = readyClient((message) => {
    if (message.params?.name !== 'retrieve') return { content: [] };
    attempts += 1;
    return attempts < 2
      ? { isError: true, content: [{ type: 'text', text: "An error occurred invoking 'retrieve'." }] }
      : { content: [{ type: 'text', text: 'Read complete' }] };
  }, { sleep: () => Promise.resolve() });
  try {
    const args = { query: ['Test'], strategy: 'copilot' };
    const result = await client.readTool('retrieve', args, 1000, undefined, (retry) => retries.push(retry));
    assert.equal(result.content[0].text, 'Read complete');
    assert.equal(attempts, 2, 'expected one retry after the transient fault');
    const retrieveCalls = requests.filter((r) => r.params?.name === 'retrieve');
    assert.equal(retrieveCalls.length, 2, 'the identical call should be re-sent exactly once');
    assert.deepEqual(retrieveCalls.map((request) => request.params.arguments), [args, args]);
    assert.deepEqual(retries, [{
      tool: 'retrieve', attempt: 2, attempts: 3,
      error: "WorkIQ retrieve failed: An error occurred invoking 'retrieve'.",
    }]);
  } finally { client.stop(); }
});

test('readTool retries a transient fault a bounded number of times, then fails loud', async () => {
  let attempts = 0;
  const { client } = readyClient((message) => {
    if (message.params?.name !== 'retrieve') return { content: [] };
    attempts += 1;
    return { isError: true, content: [{ type: 'text', text: "An error occurred invoking 'retrieve'." }] };
  }, { sleep: () => Promise.resolve() });
  try {
    await assert.rejects(client.readTool('retrieve', { query: ['Test'], strategy: 'copilot' }), (error) => {
      assert.match(error.message, /An error occurred invoking 'retrieve'.*after 3 attempts/);
      assert.equal(error.code, 'WORKIQ_TRANSIENT_TOOL_FAILURE');
      assert.equal(error.tool, 'retrieve');
      assert.equal(error.attempts, 3);
      return true;
    });
    assert.equal(attempts, 3, 'should stop after the bounded retry cap and surface the error');
  } finally { client.stop(); }
});

test('readTool applies the same bounded recovery to JSON-RPC backend faults', async () => {
  let attempts = 0;
  const { client } = readyClient(() => {
    attempts += 1;
    if (attempts === 1) throw new Error("An error occurred invoking 'retrieve'.");
    return { content: [{ type: 'text', text: 'Read complete' }] };
  }, { sleep: () => Promise.resolve() });
  try {
    assert.equal((await client.readTool('retrieve', { query: ['Test'], strategy: 'copilot' })).content[0].text, 'Read complete');
    assert.equal(attempts, 2);
  } finally { client.stop(); }
});

test('exhausted JSON-RPC backend faults retain their cause and recovery classification', async () => {
  let attempts = 0;
  const { client } = readyClient(() => {
    attempts += 1;
    throw new Error("An error occurred invoking 'retrieve'.");
  }, { retryAttempts: 2, sleep: () => Promise.resolve() });
  try {
    await assert.rejects(client.readTool('retrieve', { query: ['Test'] }), (error) => {
      assert.equal(error.code, 'WORKIQ_TRANSIENT_TOOL_FAILURE');
      assert.equal(error.attempts, 2);
      assert.match(error.cause.message, /An error occurred invoking 'retrieve'/);
      return true;
    });
    assert.equal(attempts, 2);
  } finally { client.stop(); }
});

test('HTTP and policy errors containing generic fault text are never classified as recoverable', async () => {
  for (const result of [
    { isError: true, structuredContent: { statusCode: 403, error: "An error occurred invoking 'retrieve'." } },
    { isError: true, content: [{ type: 'text', text: "Access denied by policy: An error occurred invoking 'retrieve'." }] },
    { isError: true, content: [{ type: 'text', text: "An error occurred invoking 'fetch'." }] },
  ]) {
    let attempts = 0;
    const { client } = readyClient(() => { attempts += 1; return result; }, {
      sleep: () => { throw new Error('A non-transient failure must not retry.'); },
    });
    try {
      await assert.rejects(client.readTool('retrieve', { query: ['Test'] }), (error) => {
        assert.match(error.message, /An error occurred invoking/);
        assert.equal(error.code, undefined);
        return true;
      });
      assert.equal(attempts, 1);
    } finally { client.stop(); }
  }
});

test('cancellation during retry backoff prevents another request', async () => {
  const controller = new AbortController();
  let attempts = 0;
  const { client } = readyClient(() => {
    attempts += 1;
    return { isError: true, content: [{ type: 'text', text: "An error occurred invoking 'retrieve'." }] };
  }, { sleep: async () => controller.abort(new Error('Stopped during backoff')) });
  try {
    await assert.rejects(client.readTool('retrieve', { query: ['Test'] }, 1000, controller.signal),
      /^Error: Stopped during backoff$/);
    assert.equal(attempts, 1);
  } finally { client.stop(); }
});

test('readTool preserves the real structured fetch error when WorkIQ returns an empty content array', async () => {
  const { client } = readyClient(() => ({
    isError: true, content: [],
    structuredContent: { results: [{
      data: null, statusCode: 400,
      error: { error: { code: 'RequestBroker--ParseUri', message: "Could not find a property named 'recipients'." } },
    }] },
  }));
  try {
    await assert.rejects(client.readTool('fetch', { entityUrls: ['/me/messages?$select=recipients'] }), (error) => {
      assert.match(error.message, /WorkIQ fetch failed \(HTTP 400\): RequestBroker--ParseUri: Could not find a property named 'recipients'/);
      assert.equal(error.statusCode, 400);
      assert.equal(error.code, 'RequestBroker--ParseUri');
      return true;
    });
  } finally { client.stop(); }
});

test('readTool catches Graph failures even when the MCP isError flag is missing', async () => {
  const { client } = readyClient(() => ({
    content: [{ type: 'text', text: JSON.stringify({
      results: [{ statusCode: 403, data: { error: { code: 'ErrorAccessDenied', message: 'Mailbox permission denied' } } }],
    }) }],
  }));
  try {
    await assert.rejects(client.readTool('fetch', { entityUrls: ['/me/messages'] }),
      /HTTP 403.*ErrorAccessDenied.*Mailbox permission denied/);
  } finally { client.stop(); }
});

test('fetch failures retain the exact failed resource, including the correct item in a batch', async () => {
  const paths = ['/me/messages?$select=id&$top=1', '/chats/19%3Aprivate%40thread.v2/messages?$select=id&$top=50'];
  const { client, requests } = readyClient(() => ({
    structuredContent: { results: [
      { statusCode: 200, data: { value: [] } },
      { statusCode: 403, error: { error: { code: 'Forbidden', message: 'InsufficientPrivileges' } } },
    ] },
  }));
  try {
    await assert.rejects(client.readTool('fetch', { entityUrls: paths }), error => {
      assert.equal(error.resource, paths[1]);
      assert.equal(error.statusCode, 403);
      assert.equal(error.code, 'Forbidden');
      assert.match(error.message, /InsufficientPrivileges/);
      return true;
    });
    assert.equal(requests.filter(request => request.params?.name === 'fetch').length, 1);
  } finally { client.stop(); }
});

for (const status of [401, 403, 500]) {
  test(`a mailbox readiness HTTP ${status} is never reported as connected`, async () => {
    const { client } = readyClient(() => ({ structuredContent: { results: [{
      statusCode: status, error: { code: 'Denied', message: 'Mailbox read failed' },
    }] } }));
    try {
      const result = await client.probe();
      assert.equal(result.ok, false);
      assert.equal(result.status, status);
      assert.equal(result.code, 'Denied');
      assert.match(result.error, /Mailbox read failed/);
    } finally { client.stop(); }
  });
}

test('mailbox readiness accepts a valid empty mailbox, not empty or malformed MCP responses', async () => {
  for (const response of [
    { content: [] },
    { structuredContent: { results: [] } },
    { structuredContent: { results: [{ statusCode: 200, data: {} }] } },
    { structuredContent: { results: [{ statusCode: 204 }] } },
  ]) {
    const { client } = readyClient(() => response);
    try {
      const result = await client.probe();
      assert.equal(result.ok, false);
      assert.equal(result.code, 'WORKIQ_INVALID_PROBE_RESPONSE');
    } finally { client.stop(); }
  }
  const { client } = readyClient(() => ({ structuredContent: { results: [{ statusCode: 200, data: { value: [] } }] } }));
  try {
    assert.deepEqual(await client.probe(), { ok: true, status: 200 });
  } finally { client.stop(); }
});

test('cancelling a read notifies only its RPC and leaves other WorkIQ reads usable', async () => {
  const { client, requests } = readyClient((request) => request.params.arguments.query?.[0] === 'Wait'
    ? undefined
    : { content: [{ type: 'text', text: 'Read complete' }] });
  try {
    await client.start();
    const controller = new AbortController();
    const pending = client.readTool('retrieve', { query: ['Wait'] }, 1000, controller.signal);
    const rejected = assert.rejects(pending, /^Error: Stopped$/);
    await new Promise(setImmediate);
    controller.abort(new Error('Stopped'));
    await rejected;
    const readRequest = requests.find((request) => request.params?.arguments?.query?.[0] === 'Wait');
    const cancellation = requests.find((request) => request.method === 'notifications/cancelled');
    assert.equal(cancellation.params.requestId, readRequest.id);
    const result = await client.readTool('fetch', { entityUrls: ['/me?$select=id'] });
    assert.equal(result.content[0].text, 'Read complete');
  } finally { client.stop(); }
});

// ── Restarting WorkIQ after a new sign-in ────────────────────────────────────

const isWaitRead = (message) => message.params?.name === 'retrieve' && message.params.arguments.query?.[0] === 'Wait';

test('busy() is true only while a tool call is running', async () => {
  const { client, proc, requests } = readyClient((message) => (isWaitRead(message) ? undefined : textResult('ok')));
  try {
    assert.equal(client.busy(), false);
    const pending = client.readTool('retrieve', { query: ['Wait'] });
    assert.equal(client.busy(), true, 'starting WorkIQ for a call counts as busy');
    await waitFor(() => requests.some(isWaitRead), 'the read request');
    assert.equal(client.busy(), true);
    answer(proc, requests.find(isWaitRead).id, textResult('done'));
    assert.equal((await pending).content[0].text, 'done');
    assert.equal(client.busy(), false);
  } finally { client.stop(); }
});

test('stop(reason) tells in-flight calls why they were interrupted', async () => {
  const { client, requests } = readyClient((message) => (isWaitRead(message) ? undefined : textResult('ok')));
  try {
    const pending = client.readTool('retrieve', { query: ['Wait'] });
    const rejected = assert.rejects(pending, /^Error: WorkIQ restarted for a new sign-in\.$/);
    await waitFor(() => requests.some(isWaitRead), 'the read request');
    client.stop('WorkIQ restarted for a new sign-in.');
    await rejected;
    assert.equal(client.busy(), false);
  } finally { client.stop(); }
});

test('a stopped WorkIQ process cannot disturb the process that replaced it', async () => {
  const procs = [];
  const requests = [];
  const client = createWorkIqClient({
    resolveBin: () => 'C:\\fake\\workiq.exe',
    packaged: () => true,
    spawnProcess: () => {
      const n = procs.length + 1;
      const proc = respondingProc((message) => (isWaitRead(message) ? undefined : textResult(`process ${n}`)), requests);
      procs.push(proc);
      return proc;
    },
  });
  try {
    await client.start();
    client.stop('WorkIQ restarted for a new sign-in.');
    const pending = client.readTool('retrieve', { query: ['Wait'] });
    await waitFor(() => requests.some(isWaitRead), 'the read on the new process');
    const id = requests.find(isWaitRead).id;
    const [stale, fresh] = procs;

    // Late output, exit and error from the stopped process.
    answer(stale, id, textResult('stale answer'));
    stale.emit('exit', 1);
    stale.emit('error', new Error('late error'));
    await new Promise(setImmediate);
    assert.equal(client.busy(), true, 'the read on the new process must still be waiting');

    answer(fresh, id, textResult('fresh answer'));
    assert.equal((await pending).content[0].text, 'fresh answer');
    const next = await client.readTool('fetch', { entityUrls: ['/me?$select=id'] });
    assert.equal(next.content[0].text, 'process 2');
    assert.equal(procs.length, 2, 'the stale exit must not force another restart');
  } finally { client.stop(); }
});