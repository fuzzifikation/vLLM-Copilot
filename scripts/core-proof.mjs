#!/usr/bin/env node

/**
 * Isolated packed-consumer proof for the public core entry (restructuring plan, Phase 8).
 *
 * The claim this proves, in one line: the compiled core is a self-contained Node
 * package. Not "the repo's tests alias vscode so nothing looks broken" — a REAL
 * `npm pack` tarball, installed by `npm install` into a fresh consumer OUTSIDE
 * the repo, type-checked against ONLY the shipped declarations, then executed
 * against an ephemeral loopback mock backend. If the core secretly needs the
 * editor, this fails where nobody can ignore it: in `npm run build`.
 *
 * Pipeline contract (all wired into `npm run build`):
 *   compile      -> out/core (the shipped JS tree, no copies)
 *   core:decl    -> temp/core-decl (Node-only declarations, skipLibCheck off)
 *   core:proof   -> THIS SCRIPT  (stage, pack, install, check, run)
 *
 * Staging rules (docs/core-restructuring-plan.md, Phase 8):
 * 1. The staged package is the compiled core JS plus the INDEPENDENTLY checked
 *    declarations, ESM, public `index` export only.
 * 2. Dependencies: derived, not hardcoded — every bare import the staged JS
 *    actually makes must be declared in the ROOT manifest, and the staged
 *    manifest ships exactly those at the root's versions.
 * 3. The manifest is explicitly private: name derived from the extension name,
 *    version copied verbatim, `SEE LICENSE IN LICENSE`, the UNMODIFIED source
 *    LICENSE and the dependency notices alongside. This is a local proof, never
 *    a publishable package.
 * 4. The consumer lives in the OS temp dir (never beneath the repo), installs
 *    only the tarball plus its own TypeScript/@types/node, and its tsconfig has
 *    no paths, no aliases, no NODE_PATH, and no `vscode` type in sight.
 * 5. The consumer asserts BEHAVIOR through the public entry — catalog limits,
 *    wire-body layering, a tool turn with reasoning and text, retry,
 *    cancellation, personality fixtures, one completion record per eligible
 *    attempt, persisted reload with cost, and a stream error that invents NO
 *    completion record. Import success alone proves nothing.
 */
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { builtinModules } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

const stage = join(root, 'temp', 'core-proof', 'pkg');
const tgzDir = join(root, 'temp', 'core-proof');
const declDir = join(root, 'temp', 'core-decl');
const jsDir = join(root, 'out', 'core');
let consumer = '';

function fail(message) {
  throw new Error(`core-proof: ${message}`);
}

// npm's CLI entry point, same probe as package-vsix.mjs: every real install
// layout (Windows installer, nvm, Homebrew, distro) or the fixed shell string.
const npmCli = [
  join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  join(dirname(process.execPath), '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  join(dirname(process.execPath), '..', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
].find((candidate) => existsSync(candidate));

function npm(args, cwd) {
  const result = npmCli
    ? spawnSync(process.execPath, [npmCli, ...args], { cwd, encoding: 'utf8' })
    : spawnSync(`npm ${args.join(' ')}`, { cwd, encoding: 'utf8', shell: true });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    fail(`npm ${args.join(' ')} failed (exit ${result.status}):\n${result.stdout ?? ''}\n${result.stderr ?? ''}`);
  }
  return result.stdout ?? '';
}

/** Recursively list files under dir (relative to dir, forward slashes). */
function walk(dir, base = dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(abs, base));
    else out.push(relative(base, abs).split(sep).join('/'));
  }
  return out;
}

function copyDeclarations() {
  for (const rel of walk(declDir)) {
    if (!rel.endsWith('.d.ts')) continue;
    const dest = join(stage, 'core', rel);
    mkdirSync(dirname(dest), { recursive: true });
    cpSync(join(declDir, rel), dest, { force: true });
  }
}

try {
  if (!existsSync(join(jsDir, 'index.js'))) {
    fail(`${join(jsDir, 'index.js')} is missing — run \`npm run compile\` before this proof.`);
  }
  if (!existsSync(join(declDir, 'index.d.ts'))) {
    fail(`${join(declDir, 'index.d.ts')} is missing — run \`npm run core:decl\` before this proof.`);
  }

  // ── 1. Stage: compiled core JS + independently checked declarations ──────
  rmSync(stage, { recursive: true, force: true });
  mkdirSync(join(stage, 'core'), { recursive: true });
  cpSync(jsDir, join(stage, 'core'), { recursive: true });
  // Declarations sit BESIDE the JS so every relative import in the .d.ts tree
  // resolves exactly as it did in the declaration-only emit.
  copyDeclarations();

  // ── 2. Dependencies: every bare import must be declared at the root ──────
  const bare = new Set();
  for (const rel of walk(join(stage, 'core'))) {
    if (!rel.endsWith('.js')) continue;
    const source = readFileSync(join(stage, 'core', rel), 'utf8');
    for (const match of source.matchAll(/^[ \t]*(?:import|export)\b[^;\n]*?\bfrom\s+['"]([^'"]+)['"]/gm)) {
      const specifier = match[1];
      if (specifier.startsWith('.')) continue;
      const pkg = specifier.startsWith('@') ? specifier.split('/').slice(0, 2).join('/') : specifier.split('/')[0];
      if (!pkg.startsWith('node:') && !builtinModules.includes(pkg)) bare.add(pkg);
    }
    for (const match of source.matchAll(/\bimport\(\s*['"]([^'"]+)['"]\s*\)/g)) {
      const specifier = match[1];
      if (specifier.startsWith('.')) continue;
      const pkg = specifier.startsWith('@') ? specifier.split('/').slice(0, 2).join('/') : specifier.split('/')[0];
      if (!pkg.startsWith('node:') && !builtinModules.includes(pkg)) bare.add(pkg);
    }
  }
  const deps = {};
  for (const name of bare) {
    const declared = manifest.dependencies?.[name];
    if (!declared) fail(`staged core imports "${name}" but the root manifest does not declare it`);
    if (!existsSync(join(root, 'node_modules', name))) fail(`dependency ${name} is declared but not installed`);
    deps[name] = declared;
  }

  // ── 3. Private proof manifest + licensing, verbatim ──────────────────────
  const proofName = `${manifest.name}-core-proof`;
  const licenseText = readFileSync(join(root, 'LICENSE'), 'utf8');
  writeFileSync(
    join(stage, 'package.json'),
    JSON.stringify(
      {
        name: proofName,
        version: manifest.version,
        private: true,
        description: `Local packed-consumer proof of ${manifest.name}'s core package — never published.`,
        type: 'module',
        license: 'SEE LICENSE IN LICENSE',
        exports: { '.': { types: './core/index.d.ts', import: './core/index.js' } },
        files: ['core', 'LICENSE', 'THIRD-PARTY-NOTICES.txt'],
        dependencies: deps,
      },
      null,
      2
    ) + '\n'
  );
  cpSync(join(root, 'LICENSE'), join(stage, 'LICENSE'));
  cpSync(join(root, 'THIRD-PARTY-NOTICES.txt'), join(stage, 'THIRD-PARTY-NOTICES.txt'));
  if (!licenseText.includes('Business Source License') && !licenseText.includes('MIT License')) {
    fail('root LICENSE is not the expected source license — refusing to prove a package with an unknown license');
  }

  // ── 4. npm pack + packed-list inspection ─────────────────────────────────
  const packJson = JSON.parse(npm(['pack', '--json', '--pack-destination', tgzDir], stage));
  const packed = packJson[0];
  const packedFiles = packed.files.map((f) => f.path);
  for (const required of ['core/index.js', 'core/index.d.ts', 'core/config/config.js', 'LICENSE', 'THIRD-PARTY-NOTICES.txt', 'package.json']) {
    if (!packedFiles.includes(required)) fail(`packed tarball is missing ${required}`);
  }
  for (const file of packedFiles) {
    if (file.startsWith('out/') || file.includes('vscode') || file.startsWith('..')) {
      fail(`packed tarball carries unexpected content: ${file}`);
    }
  }
  const tarball = join(tgzDir, packed.filename);
  if (!existsSync(tarball)) fail(`npm pack reported ${packed.filename} but it is not on disk`);

  // ── 5. Fresh consumer in the OS temp dir — never beneath the repo ────────
  consumer = mkdtempSync(join(tmpdir(), 'vllm-copilot-core-proof-consumer-'));
  writeFileSync(join(consumer, 'package.json'), JSON.stringify({ name: 'core-proof-consumer', private: true, type: 'module' }, null, 2) + '\n');
  writeFileSync(
    join(consumer, 'tsconfig.json'),
    JSON.stringify(
      {
        compilerOptions: {
          module: 'nodenext',
          moduleResolution: 'nodenext',
          target: 'es2022',
          lib: ['es2022'],
          strict: true,
          types: ['node'],
          skipLibCheck: false,
          outDir: 'dist',
        },
        include: ['index.ts'],
      },
      null,
      2
    ) + '\n'
  );
  writeFileSync(join(consumer, 'index.ts'), CONSUMER_SOURCE(proofName));
  npm(
    [
      'install',
      '--no-audit',
      '--no-fund',
      '--silent',
      tarball,
      `file:${join(root, 'node_modules', 'typescript')}`,
      `file:${join(root, 'node_modules', '@types', 'node')}`,
    ],
    consumer
  );

  // Type-check against ONLY the shipped declarations...
  const tsc = spawnSync(process.execPath, [join(consumer, 'node_modules', 'typescript', 'bin', 'tsc'), '-p', consumer], { encoding: 'utf8' });
  if (tsc.status !== 0) fail(`consumer type-check failed:\n${tsc.stdout ?? ''}${tsc.stderr ?? ''}`);
  // ...then RUN it (plain node, no loader, no aliases).
  const run = spawnSync(process.execPath, [join(consumer, 'dist', 'index.js')], { encoding: 'utf8', timeout: 120_000 });
  const stdout = (run.stdout ?? '').trim();
  if (run.status !== 0) fail(`consumer run failed (exit ${run.status}):\n${stdout}\n${run.stderr ?? ''}`);
  for (const line of stdout.split('\n')) process.stdout.write(`  ${line}\n`);
  if (!stdout.includes('CORE PROOF OK')) fail('consumer finished without printing the success marker');
  process.stdout.write(`core-proof: packed ${packed.filename}, installed in ${consumer.replace(tmpdir(), 'tmpdir')}, ${bare.size} runtime deps, public-entry assertions green\n`);
} finally {
  rmSync(join(root, 'temp', 'core-proof'), { recursive: true, force: true });
  if (consumer) rmSync(consumer, { recursive: true, force: true });
}

/**
 * The consumer program. Written through the public entry ONLY (named imports
 * from the proof package), asserting behavior on every Phase-8 contract:
 * catalog limits, wire-body layering, tool turn, reasoning/text, retry,
 * cancellation, personality fixtures, one completion record per eligible
 * attempt, persisted reload with cost, and a stream error with NO invented
 * completion record. No template literals with ${} — this is embedded source.
 */
function CONSUMER_SOURCE(pkgName) {
  return `import { strict as assert } from 'node:assert';
import * as http from 'node:http';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { AddressInfo } from 'node:net';
import {
  applyPromptReplacements,
  assembleRequest,
  ChatTransport,
  createExecutionState,
  describeModels,
  executeChatRequest,
  findModelCost,
  formatCost,
  formatCostFine,
  formatCostSummary,
  isAttemptCompletionEvent,
  listServerModels,
  loadPromptReplacements,
  resolveModelReplacements,
  resolveRuntimeLimits,
  UsageLedger,
  type AttemptCompletionEvent,
  type AssembleRequestInput,
  type ExecutionEvent,
  type ExecutionInput,
  type ExecutionTransport,
  type ModelConfig,
  type ModelLimitsResolver,
  type RequestLog,
  type ServerEntry,
  type VllmConfig,
  type VllmChatOptions,
} from '${pkgName}';

const WIRE_ID = 'mock/model';
const CONTEXT_WINDOW = 32768;
const log: RequestLog = { appendLine: () => {} };

// ── Loopback mock backend ────────────────────────────────────────────────────
type ResponseSpec = { status?: number; json?: unknown; sse?: string; slow?: boolean };
interface Backend {
  base: string;
  requests: any[];
  queue: ResponseSpec[];
  open: http.ServerResponse[];
  close(): Promise<void>;
}
async function startBackend(): Promise<Backend> {
  const backend: Backend = { base: '', requests: [], queue: [], open: [], close: async () => {} };
  const server = http.createServer((req, res) => {
    if (req.method === 'GET' && (req.url || '').startsWith('/v1/models')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ object: 'list', data: [{ object: 'model', id: WIRE_ID, root: WIRE_ID, max_model_len: CONTEXT_WINDOW }] }));
      return;
    }
    if (req.method === 'POST' && req.url === '/v1/chat/completions') {
      let raw = '';
      req.on('data', (c: Buffer) => { raw += c; });
      req.on('end', () => {
        const body = JSON.parse(raw);
        backend.requests.push(body);
        const spec = backend.queue.shift();
        assert.ok(spec, 'mock backend received an unexpected request (a retry or re-ask happened that the proof did not queue)');
        if (spec.status) {
          res.writeHead(spec.status, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(spec.json));
          return;
        }
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        if (spec.slow) {
          backend.open.push(res);
          res.write('data: ' + JSON.stringify(chunk({ content: 'partial answer that never finishes' })) + '\\n\\n');
          return;
        }
        res.end(spec.sse);
      });
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  backend.base = 'http://127.0.0.1:' + String((server.address() as AddressInfo).port);
  backend.close = async () => {
    for (const res of backend.open) res.destroy();
    await new Promise<void>((done) => server.close(() => done()));
  };
  return backend;
}
function chunk(delta: unknown, finish: string | null = null, usage?: unknown) {
  const c: any = { id: 'cmpl-1', object: 'chat.completion.chunk', created: 1, model: WIRE_ID, choices: [{ index: 0, delta, finish_reason: finish }] };
  if (usage) { c.choices = []; c.usage = usage; }
  return c;
}
function sse(...objs: unknown[]): string {
  return objs.map((o) => 'data: ' + JSON.stringify(o) + '\\n\\n').join('') + 'data: [DONE]\\n\\n';
}

// ── Drain helper: collect events, optional early stop ───────────────────────
async function drain(
  gen: AsyncGenerator<ExecutionEvent>,
  onEvent?: (ev: ExecutionEvent) => boolean
): Promise<{ events: ExecutionEvent[]; completions: AttemptCompletionEvent[] }> {
  const events: ExecutionEvent[] = [];
  const completions: AttemptCompletionEvent[] = [];
  for await (const ev of gen) {
    events.push(ev);
    if (isAttemptCompletionEvent(ev)) completions.push(ev);
    if (onEvent && onEvent(ev)) break;
  }
  return { events, completions };
}

const backend = await startBackend();
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'core-proof-run-'));
try {
  const models: ModelConfig[] = [{ id: 'proof', vllmModelId: WIRE_ID, server: 'srv', maxOutputTokens: 1024 }];
  const servers: ServerEntry[] = [{ id: 'srv', serverUrl: backend.base, serverType: 'vllm', requestHeaders: {} }];

  // 1. Catalog limits through the public entry — served window, no invention.
  const listed = await listServerModels('vllm', backend.base, {});
  assert.ok(listed.some((m) => m.id === WIRE_ID), 'listServerModels must include the served model');
  const limits = await resolveRuntimeLimits('vllm', backend.base, {}, WIRE_ID);
  assert.equal(limits.contextWindow, CONTEXT_WINDOW);
  const probe: ModelLimitsResolver = {
    getModelContextWindow: (t, u, h, m: string, c) => resolveRuntimeLimits(t, u, h, m, c),
  };
  const descriptors = await describeModels(models, servers, probe, log);
  assert.equal(descriptors.length, 1);
  assert.equal(descriptors[0].contextWindow, CONTEXT_WINDOW);
  assert.equal(descriptors[0].wireId, WIRE_ID);
  console.log('ok  catalog limits (listServerModels / resolveRuntimeLimits / describeModels)');

  // 2. Personality fixture: resolve -> load -> apply, all via the entry.
  const fixturePath = path.join(scratch, 'proof-persona.json');
  fs.writeFileSync(fixturePath, JSON.stringify({
    meta: { name: 'Proof Persona', description: 'proof fixture' },
    rules: [{ ruleName: 'persona-rule', find: 'helpful assistant', replace: 'Proof Bot' }],
  }));
  const resolved = await resolveModelReplacements(undefined, { systemMessageReplacementsFile: fixturePath });
  assert.ok(resolved);
  assert.equal(path.resolve(resolved.sourcePath), path.resolve(fixturePath));
  const rules = await loadPromptReplacements(resolved.sourcePath);
  assert.equal(rules.length, 1);
  const applied = applyPromptReplacements('You are a helpful assistant. Stay calm.', rules);
  assert.ok(applied.result.includes('Proof Bot'));
  assert.deepEqual(applied.matchedRuleNames, ['persona-rule']);
  console.log('ok  personality fixtures (resolve / load / apply)');

  // 3. Wire-body layering through assembleRequest.
  const config: VllmConfig = { models, servers };
  const asmInput: AssembleRequestInput = {
    modelId: 'proof',
    openaiMessages: [
      { role: 'system', content: 'You are a helpful assistant.' },
      { role: 'user', content: 'hi' },
    ],
    runtimeOptions: {},
    toolModeRequired: false,
    fixEmptyToolParameters: true,
    tools: [{ name: 'noop' }],
    advertisedMaxOutputTokens: 1024,
  };
  const assembled = assembleRequest(asmInput, config, log);
  assert.equal(assembled.mergedOptions.max_tokens, 1024);
  assert.deepEqual((assembled.mergedOptions.tools as any[])[0].function.parameters, { type: 'object', properties: {} });
  console.log('ok  request assembly (budget, empty-tool parameters, wire id)');

  // 4. One real stream: tool turn + reasoning + text over the loopback backend.
  const USAGE = { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15, cost: 0.0042, completion_tokens_details: { reasoning_tokens: 2 } };
  const happySse = sse(
    chunk({ role: 'assistant', reasoning_content: 'thinking about it' }),
    chunk({ content: 'Hello from ' }),
    chunk({ content: 'the mock.' }),
    chunk({ tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'read_file', arguments: '{"path":' } }] }),
    chunk({ tool_calls: [{ index: 0, function: { arguments: '"src/app.ts"}' } }] }),
    chunk({}, 'tool_calls'),
    chunk({}, null, USAGE)
  );
  const transport = new ChatTransport(log);
  const client: ExecutionTransport = {
    chatCompletionStream: (m, msgs, opts, sig, sc) => transport.stream(m, msgs, opts as VllmChatOptions, sig, sc),
  };
  const makeInput = (msgs: AssembleRequestInput['openaiMessages'], signal: AbortSignal, maxRetries: number): ExecutionInput => ({
    transport: client,
    modelId: 'proof',
    vllmModelId: assembled.vllmModelId,
    openaiMessages: msgs,
    mergedOptions: assembled.mergedOptions,
    serverConfig: assembled.serverConfig,
    maxRetries,
    signal,
    log,
    limits: { wireModelId: assembled.wireModelId, contextWindow: CONTEXT_WINDOW, maxInputTokens: 0, maxOutputTokens: 1024 },
  });

  backend.queue.push({ sse: happySse });
  const state1 = createExecutionState(Date.now());
  const run1 = await drain(executeChatRequest(makeInput(asmInput.openaiMessages.slice(), new AbortController().signal, 0), state1));
  assert.equal(state1.attemptCount, 1);
  assert.equal(run1.completions.length, 1, 'exactly one completion event per successful request');
  const text = run1.events.filter((e) => !isAttemptCompletionEvent(e) && e.content).map((e) => (e as { content: string }).content).join('');
  assert.equal(text, 'Hello from the mock.');
  const reasoning = run1.events.filter((e) => !isAttemptCompletionEvent(e) && e.reasoning_content).map((e) => (e as { reasoning_content: string }).reasoning_content).join('');
  assert.equal(reasoning, 'thinking about it');
  const toolCalls = run1.events.flatMap((e) => (isAttemptCompletionEvent(e) ? [] : e.finishedToolCalls));
  assert.equal(toolCalls.length, 1);
  assert.deepEqual(toolCalls[0], { id: 'call_1', name: 'read_file', arguments: '{"path":"src/app.ts"}' });
  const comp = run1.completions[0].attemptCompletion;
  assert.equal(comp.usage.cost, 0.0042);
  assert.equal(comp.lastRequest.actualCost, 0.0042);
  assert.equal(comp.lastRequest.promptTokens, 10);
  assert.equal(comp.lastRequest.completionTokens, 5);
  assert.equal(comp.lastRequest.reasoningTokens, 2);
  assert.equal(comp.lastRequest.modelId, WIRE_ID);
  // What the wire actually carried:
  const wire = backend.requests[0];
  assert.equal(wire.model, WIRE_ID);
  assert.equal(wire.stream, true);
  assert.deepEqual(wire.stream_options, { include_usage: true });
  assert.equal(wire.max_tokens, 1024);
  assert.deepEqual(wire.tools[0].function.parameters, { type: 'object', properties: {} });
  assert.equal(wire.messages[0].role, 'system');
  console.log('ok  one tool turn with reasoning + text (wire body asserted server-side)');

  // 5. Ledger: one completed record per eligible attempt, persisted reload.
  const usageFile = path.join(scratch, 'usage.json');
  const ledger = new UsageLedger({ filePath: usageFile, onChange: () => {} });
  ledger.recordRequest(comp.lastRequest);
  await ledger.flush();
  assert.deepEqual(ledger.getServerUsage(backend.base).allTime[WIRE_ID], { prompt: 10, completion: 5, cached: 0, reasoning: 2 });
  assert.equal(ledger.getServerCost(backend.base).allTime[WIRE_ID], 0.0042);
  const persisted = JSON.parse(fs.readFileSync(usageFile, 'utf8'));
  assert.equal(persisted.version, 3);
  const reload = new UsageLedger({ filePath: usageFile, onChange: () => {} });
  await reload.load();
  assert.deepEqual(reload.getServerUsage(backend.base).allTime[WIRE_ID], { prompt: 10, completion: 5, cached: 0, reasoning: 2 });
  assert.equal(reload.getServerCost(backend.base).allTime[WIRE_ID], 0.0042);
  // The per-request LAST-record snapshot is ephemeral by design (this window's
  // status-bar chip, not history): a reload restores totals and cost, never it.
  assert.ok(ledger.getLastRequest(backend.base));
  assert.equal(reload.getLastRequest(backend.base), undefined);
  const rated: ModelConfig[] = [{ id: 'proof', vllmModelId: WIRE_ID, server: 'srv', cost: { input: 1, output: 2 } }];
  assert.deepEqual(findModelCost(rated, servers, backend.base, WIRE_ID), { input: 1, output: 2 });
  assert.equal(findModelCost(rated, servers, backend.base, 'not/configured'), undefined);
  assert.equal(formatCost(31.13), '$31.13');
  assert.ok(formatCostFine(0.000019).includes('$0.000019'));
  assert.equal(formatCostSummary(11.51, 31.13, undefined), '$11.51 today and $31.13 total');
  console.log('ok  usage ledger (record, persist, reload, cost planes) + money formats');

  // 6. Retry: empty stop answer gets the assistant prefill nudge, exactly once.
  const emptyStop = sse(chunk({}, 'stop'));
  const finalAnswer = sse(
    chunk({ content: 'real answer' }),
    chunk({}, 'stop'),
    chunk({}, null, { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 })
  );
  backend.queue.push({ sse: emptyStop }, { sse: finalAnswer });
  const state2 = createExecutionState(Date.now());
  const run2 = await drain(executeChatRequest(makeInput(asmInput.openaiMessages.slice(), new AbortController().signal, 1), state2));
  assert.equal(state2.attemptCount, 2);
  assert.equal(run2.completions.length, 1, 'the retried-away attempt records nothing twice');
  assert.equal(run2.completions[0].attemptCompletion.usage.prompt_tokens, 7);
  const retriedBody = backend.requests[backend.requests.length - 1];
  assert.equal(retriedBody.messages.length, asmInput.openaiMessages.length + 1);
  assert.deepEqual(retriedBody.messages[retriedBody.messages.length - 1], { role: 'assistant', content: '' });
  console.log('ok  retry (empty-answer nudge, single completion event)');

  // 7. Cancellation: abort after the first delta — no completion, no re-ask.
  // maxRetries is 1 on purpose: a spurious second POST would hit the empty
  // queue and the mock would fail the proof.
  backend.queue.push({ slow: true });
  const ac = new AbortController();
  const state3 = createExecutionState(Date.now());
  const run3 = await drain(
    executeChatRequest(makeInput(asmInput.openaiMessages.slice(), ac.signal, 1), state3),
    (ev) => {
      if (!isAttemptCompletionEvent(ev) && ev.content) {
        ac.abort('User cancelled');
        return true;
      }
      return false;
    }
  );
  assert.equal(run3.completions.length, 0, 'a cancelled stream never invents a completion record');
  assert.equal(state3.attemptCount, 1);
  assert.equal(backend.queue.length, 0);
  console.log('ok  cancellation (mid-stream abort, no completion, no re-ask)');

  // 8. Stream error: the server aborts mid-stream — the error propagates and
  // NO completion record is invented.
  backend.queue.push({ sse: sse(chunk({ role: 'assistant' }), { error: { message: 'kaboom' } }) });
  const state4 = createExecutionState(Date.now());
  let streamError: unknown;
  let partial: AttemptCompletionEvent[] = [];
  try {
    const run4 = await drain(executeChatRequest(makeInput(asmInput.openaiMessages.slice(), new AbortController().signal, 0), state4));
    partial = run4.completions;
  } catch (err) {
    streamError = err;
  }
  assert.ok(streamError, 'a mid-stream server error must throw');
  assert.match(String(streamError), /kaboom/);
  assert.equal(partial.length, 0);
  console.log('ok  stream error (propagates, no invented completion record)');

  console.log('CORE PROOF OK');
} finally {
  await backend.close();
  fs.rmSync(scratch, { recursive: true, force: true });
}
`;
}
