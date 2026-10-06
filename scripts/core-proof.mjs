#!/usr/bin/env node

/**
 * Isolated packed-consumer proof for the public core entry.
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
 *   compile      -> out/core (JS + Node-only declarations, skipLibCheck off)
 *   core:proof   -> THIS SCRIPT  (stage, pack, install, check, run)
 *
 * Staging rules (frozen from the completed core restructuring, 2026-10-05; git history holds the plan):
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
// Declarations are emitted INTO out/core (tsconfig.core.json) so the shipped
// tree, the bridge's staged copy and this proof all read the same typed
// surface — there is no second scratch emit to reconcile anymore.
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

try {
  if (!existsSync(join(jsDir, 'index.js'))) {
    fail(`${join(jsDir, 'index.js')} is missing — run \`npm run compile\` before this proof.`);
  }
  if (!existsSync(join(jsDir, 'index.d.ts'))) {
    fail(`${join(jsDir, 'index.d.ts')} is missing — run \`npm run compile\` before this proof.`);
  }

  // ── 1. Stage: compiled core JS + its declarations, exactly the shipped tree ─
  rmSync(stage, { recursive: true, force: true });
  mkdirSync(join(stage, 'core'), { recursive: true });
  // Declarations sit BESIDE the JS in out/core, so the recursive copy stages
  // both — this proof consumes the same tree the bridge stages.
  cpSync(jsDir, join(stage, 'core'), { recursive: true });

  // ── 2. Dependencies: every bare import must be declared at the root ──────
  // Line-anchored scan: tsc EMITS EVERY import on one line — multi-line source
  // imports are collapsed at emit (verified 2026-10-04 across all of out/, and
  // type-only names are stripped from the list entirely) — so the emit this
  // script scans can only carry statement-per-line imports. If a future
  // compiler changes that, a missed specifier fails LOUDLY: the consumer
  // cannot install or resolve the undeclared package.
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
  buildDisplayKeys,
  ChatTransport,
  createExecutionState,
  describeModels,
  executeChatRequest,
  findModelCost,
  ingestExternalUsage,
  formatCost,
  formatCostFine,
  formatCostSummary,
  isAttemptCompletionEvent,
  listServerModels,
  loadPromptReplacements,
  resolveModelReplacements,
  resolveRuntimeLimits,
  resolveServedModels,
  UsageLedger,
  type AttemptCompletionEvent,
  type AssembleRequestInput,
  type ExecutionEvent,
  type ExternalRequestRecord,
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
interface OpenSlow {
  res: http.ServerResponse;
  closed: boolean;
}
interface Backend {
  base: string;
  requests: any[];
  queue: ResponseSpec[];
  open: OpenSlow[];
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
          const openEntry: OpenSlow = { res, closed: false };
          // res.close is the connection-teardown signal. req.close is NOT:
          // probed 2026-10-04 — it fired +26ms (request body complete), 220ms
          // BEFORE a client abort, and res.close arrived with the abort.
          // Watching req.close would make the teardown assertion pass while
          // nothing was torn down.
          res.on('close', () => { openEntry.closed = true; });
          backend.open.push(openEntry);
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
    for (const entry of backend.open) entry.res.destroy();
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
// The completion array is CALLER-OWNED on purpose: when the generator throws
// mid-drain, the completions collected so far stay visible — the stream-error
// case must be able to SEE a premature completion, not just miss a variable.
async function drain(
  gen: AsyncGenerator<ExecutionEvent>,
  completions: AttemptCompletionEvent[],
  onEvent?: (ev: ExecutionEvent) => boolean
): Promise<ExecutionEvent[]> {
  const events: ExecutionEvent[] = [];
  for await (const ev of gen) {
    events.push(ev);
    if (isAttemptCompletionEvent(ev)) completions.push(ev);
    if (onEvent && onEvent(ev)) break;
  }
  return events;
}

/** Poll a predicate until true or the budget runs out. */
async function waitFor(pred: () => boolean, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (pred()) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return pred();
}

const backend = await startBackend();
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'core-proof-run-'));
try {
  // Vector-form output menu: the descriptor's advertised budget must be the
  // SELECTED length (1024), not the config head (4096) — that difference is
  // what makes the catalog-to-wire budget assertion discriminating below.
  const models: ModelConfig[] = [{ id: 'proof', vllmModelId: WIRE_ID, server: 'srv', maxOutputTokens: [4096, 1024] }];
  const servers: ServerEntry[] = [{ id: 'srv', serverUrl: backend.base, serverType: 'vllm', requestHeaders: {} }];

  // 1. Catalog limits through the public entry — served window, no invention.
  const listed = await listServerModels('vllm', backend.base, {});
  assert.ok(listed.some((m) => m.id === WIRE_ID), 'listServerModels must include the served model');
  const limits = await resolveRuntimeLimits('vllm', backend.base, {}, WIRE_ID);
  assert.equal(limits.contextWindow, CONTEXT_WINDOW);
  const probe: ModelLimitsResolver = {
    getModelContextWindow: (t, u, h, m: string, c) => resolveRuntimeLimits(t, u, h, m, c),
  };
  const descriptors = await describeModels(
    models, servers, probe, log, undefined, undefined, new Map<string, number>([['proof', 1024]])
  );
  assert.equal(descriptors.length, 1);
  assert.equal(descriptors[0].contextWindow, CONTEXT_WINDOW);
  assert.equal(descriptors[0].wireId, WIRE_ID);
  // Catalog budget facts: the 1024 pick wins over the 4096 vector head, the
  // menu ceiling stays at the head, and both rungs survive it.
  assert.equal(descriptors[0].maxOutputTokens, 1024, 'the selected length is the advertised output budget');
  assert.equal(descriptors[0].outputMenuCeiling, 4096);
  assert.deepEqual(descriptors[0].outputLengthValues, [4096, 1024]);
  console.log('ok  catalog limits (list / resolve / describe, picked budget wins over vector head)');

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
    advertisedMaxOutputTokens: descriptors[0].maxOutputTokens,
  };
  const assembled = assembleRequest(asmInput, config, log);
  // Catalog-to-wire agreement: the advertised budget IS the descriptor's
  // (the 1024 pick), and the assembled wire budget equals it — never the
  // 4096 vector head the config alone would give.
  assert.equal(assembled.mergedOptions.max_tokens, descriptors[0].maxOutputTokens);
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
    limits: { wireModelId: assembled.wireModelId, contextWindow: descriptors[0].contextWindow, maxInputTokens: 0, maxOutputTokens: descriptors[0].maxOutputTokens },
  });

  backend.queue.push({ sse: happySse });
  const state1 = createExecutionState(Date.now());
  const completions1: AttemptCompletionEvent[] = [];
  const events1 = await drain(executeChatRequest(makeInput(asmInput.openaiMessages.slice(), new AbortController().signal, 0), state1), completions1);
  assert.equal(state1.attemptCount, 1);
  assert.equal(completions1.length, 1, 'exactly one completion event per successful request');
  const text = events1.filter((e) => !isAttemptCompletionEvent(e) && e.content).map((e) => (e as { content: string }).content).join('');
  assert.equal(text, 'Hello from the mock.');
  const reasoning = events1.filter((e) => !isAttemptCompletionEvent(e) && e.reasoning_content).map((e) => (e as { reasoning_content: string }).reasoning_content).join('');
  assert.equal(reasoning, 'thinking about it');
  const toolCalls = events1.flatMap((e) => (isAttemptCompletionEvent(e) ? [] : e.finishedToolCalls));
  assert.equal(toolCalls.length, 1);
  assert.deepEqual(toolCalls[0], { id: 'call_1', name: 'read_file', arguments: '{"path":"src/app.ts"}' });
  const comp = completions1[0].attemptCompletion;
  assert.equal(comp.usage.cost, 0.0042);
  assert.equal(comp.lastRequest.actualCost, 0.0042);
  assert.equal(comp.lastRequest.promptTokens, 10);
  assert.equal(comp.lastRequest.completionTokens, 5);
  assert.equal(comp.lastRequest.reasoningTokens, 2);
  assert.equal(comp.lastRequest.modelId, WIRE_ID);
  assert.equal(comp.lastRequest.maxOutputTokens, descriptors[0].maxOutputTokens);
  // What the wire actually carried:
  const wire = backend.requests[0];
  assert.equal(wire.model, WIRE_ID);
  assert.equal(wire.stream, true);
  assert.deepEqual(wire.stream_options, { include_usage: true });
  assert.equal(wire.max_tokens, descriptors[0].maxOutputTokens, 'the wire budget equals the discovered budget');
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
  const completions2: AttemptCompletionEvent[] = [];
  // The CALLER's own array goes in (no .slice()): a consumer reusing its
  // conversation history must never find synthetic retry prefills in it.
  await drain(executeChatRequest(makeInput(asmInput.openaiMessages, new AbortController().signal, 1), state2), completions2);
  assert.equal(state2.attemptCount, 2);
  assert.equal(completions2.length, 1, 'the retried-away attempt records nothing twice');
  assert.equal(completions2[0].attemptCompletion.usage.prompt_tokens, 7);
  assert.equal(asmInput.openaiMessages.length, 2, 'caller history is never mutated by retries');
  assert.deepEqual(asmInput.openaiMessages[1], { role: 'user', content: 'hi' });
  const retriedBody = backend.requests[backend.requests.length - 1];
  assert.equal(retriedBody.messages.length, 3);
  assert.deepEqual(retriedBody.messages[2], { role: 'assistant', content: '' });
  console.log('ok  retry (empty-answer nudge, single completion event)');

  // 7. Cancellation: abort a STALLED stream such that the abort must unblock
  // an ALREADY-PENDING read. Two escape routes are closed on purpose:
  //  - Breaking the loop would close the suspended generator through its
  //    finally-cleanup, releasing the read on its own — never testing abort.
  //  - Aborting synchronously inside the event body flips the flag while the
  //    generator is yield-suspended; streamReader's loop-top signal.aborted
  //    check would then exit BEFORE issuing read() — testing a flag poll,
  //    not an unblock.
  // So: schedule the abort on the NEXT MACROTASK and keep awaiting. The loop
  // immediately requests the next event, driving the generator until
  // reader.read() is pending (the mock sends nothing more); only then does
  // the timer fire, so the exit path IS reader.cancel() fulfilling the
  // pending read with done.
  // maxRetries is 1 on purpose: a spurious second POST would hit the empty
  // queue and the mock would fail the proof.
  backend.queue.push({ slow: true });
  const ac = new AbortController();
  const state3 = createExecutionState(Date.now());
  const completions3: AttemptCompletionEvent[] = [];
  let abortScheduled = false;
  const consumed = (async () => {
    for await (const ev of executeChatRequest(makeInput(asmInput.openaiMessages.slice(), ac.signal, 1), state3)) {
      if (isAttemptCompletionEvent(ev)) completions3.push(ev);
      else if (ev.content && !abortScheduled) {
        abortScheduled = true;
        setTimeout(() => ac.abort('User cancelled'), 0);
      }
    }
  })();
  const promptness = await Promise.race([
    consumed.then(() => 'done' as const),
    new Promise<'stuck'>((resolveStuck) => { setTimeout(() => resolveStuck('stuck'), 5000).unref(); }),
  ]);
  assert.equal(promptness, 'done', 'aborting a stalled stream must fulfill the pending read promptly');
  assert.ok(abortScheduled, 'the abort must be scheduled while the consumer still awaits the next event');
  assert.equal(completions3.length, 0, 'a cancelled stream never invents a completion record');
  assert.equal(state3.attemptCount, 1);
  assert.equal(backend.queue.length, 0);
  // Cleanup is asserted where it is observable: the aborted client must have
  // closed the connection as far as the SERVER can see (res.close — proven
  // teardown signal, see the mock), not just in our own generator's finally.
  assert.ok(await waitFor(() => backend.open.every((o) => o.closed), 2000), 'cancelling must close the server-side connection');
  console.log('ok  cancellation (abort fulfills the pending read, connection torn down, no completion, no re-ask)');

  // 8. Stream error AFTER usage was already reported by the wire: the error
  // must propagate AND no completion record may be invented. The usage chunk
  // first is the point — without it, "no record" would be trivially true for
  // ANY implementation, including one that wrongly persists pending usage on
  // failure. With it, the assertion distinguishes "skips the record on
  // throw" from "had nothing to record".
  backend.queue.push({
    sse: sse(
      chunk({ role: 'assistant' }),
      chunk({}, null, { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 }),
      { error: { message: 'kaboom' } }
    ),
  });
  const state4 = createExecutionState(Date.now());
  let streamError: unknown;
  // Caller-owned array again: a completion emitted BEFORE the throw would be
  // sitting here when the catch runs — this assertion can actually see one.
  const completions4: AttemptCompletionEvent[] = [];
  try {
    await drain(executeChatRequest(makeInput(asmInput.openaiMessages.slice(), new AbortController().signal, 0), state4), completions4);
  } catch (err) {
    streamError = err;
  }
  assert.ok(streamError, 'a mid-stream server error must throw');
  assert.match(String(streamError), /kaboom/);
  assert.equal(completions4.length, 0);
  console.log('ok  stream error (propagates, no invented completion record)');

  // 9. Companion API (v1.37.1): served verdicts, display keys, external
  //    ingest plan — asserted from OUTSIDE the repo against the shipped
  //    declarations, which is the entire point of the typed staged core.
  const verdicts = await resolveServedModels(
    [models[0], { id: 'ghost', vllmModelId: 'ghost/model', server: 'srv' }, { id: 'orphan', vllmModelId: WIRE_ID, server: 'no-such-server' }],
    servers
  );
  assert.equal(verdicts.get('proof')?.state, 'served', 'a wire id on the list is served');
  assert.equal(verdicts.get('ghost')?.state, 'absent', 'a wire id the list lacks is absent');
  assert.equal(verdicts.get('orphan')?.state, 'absent', 'a dangling server ref is absent, not unknown');
  const displayKeys = buildDisplayKeys([
    { id: 'k1', displayName: 'Same', server: 'srv' },
    { id: 'k2', displayName: 'Same', server: 'srv' },
    { id: 'k3', vllmModelId: 'wire/three', server: 'srv' },
  ]);
  assert.equal(displayKeys.get('k1'), 'Same');
  assert.equal(displayKeys.get('k2'), 'Same (2)', 'a taken display key is suffixed, never silently reused');
  assert.equal(displayKeys.get('k3'), 'wire/three', 'no displayName falls back to the wire id');
  const extRecord = (recordId: string, timestamp: number, overrides?: Partial<ExternalRequestRecord['request']>): ExternalRequestRecord => ({
    recordId,
    recordedAt: new Date(timestamp).toISOString(),
    request: { serverUrl: backend.base, modelId: WIRE_ID, timestamp, promptTokens: 10, completionTokens: 2, totalTokens: 12, ...overrides },
  });
  const plan = ingestExternalUsage(
    [
      extRecord('p-1', Date.now()),
      extRecord('p-1', Date.now()),
      extRecord('p-2', Date.parse('2020-01-01T00:00:00Z')),
      extRecord('p-3', Date.now(), { promptTokens: -1 }),
    ],
    { seenIds: ['old-seen'], barriers: { all: Date.parse('2025-06-01T00:00:00Z') } }
  );
  assert.deepEqual(plan.outcome.accepted, ['p-1']);
  assert.deepEqual(plan.outcome.duplicate, ['p-1'], 'the same id twice in one batch counts once');
  assert.deepEqual(plan.outcome.preReset, ['p-2'], 'traffic before the barrier stays gone');
  assert.deepEqual(plan.outcome.rejected, ['p-3'], 'an unaccountable payload is refused, not folded in');
  assert.equal(plan.requests.length, 1);
  assert.ok(plan.nextSeenIds.includes('old-seen') && plan.nextSeenIds.includes('p-1'));
  console.log('ok  companion API (served verdicts, display keys, external ingest plan)');

  console.log('CORE PROOF OK');
} finally {
  await backend.close();
  fs.rmSync(scratch, { recursive: true, force: true });
}
`;
}
