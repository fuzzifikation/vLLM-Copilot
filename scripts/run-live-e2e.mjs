#!/usr/bin/env node
/**
 * Runner for the env-gated live-backend E2E smoke (test/e2e/live.e2e.ts).
 *
 * Purpose: run the live rail against one of the servers ALREADY configured in
 * this developer's own VS Code user settings, so no secret ever needs to exist
 * in the repo, in CI, or in a shell profile. The connection details are read
 * from settings.json at runtime, handed to the test process as environment
 * variables of the spawned child, and never written back anywhere.
 *
 * Usage:
 *   node scripts/run-live-e2e.mjs             list models, ask which to use
 *   node scripts/run-live-e2e.mjs --list      just list (no run, no secrets shown)
 *   node scripts/run-live-e2e.mjs --model ID  non-interactive selection by config id
 *
 * If VLLM_E2E_SERVER_URL is already set in the environment, this script is a
 * plain pass-through: it launches the test rail and the live scenario uses
 * whatever env you provided (headless/CI-with-secrets mode).
 *
 * Display law: the ids this extension's own flows generate EMBED THE HOSTNAME
 * (config ids read "model on host", server ids are slugged URLs), so the
 * listing shows only the wire model id and the user-chosen server displayName.
 * The displayName is user text: read it before pasting output anywhere public.
 */
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';

const require_ = createRequire(import.meta.url);
// Reuse the product's own JSONC stripper (settings.json may carry comments);
// requires `npm run compile` to have produced out/ (the npm script guarantees it).
const { stripJsonc } = require_(
  path.resolve(process.cwd(), 'out', 'core', 'shared', 'jsonc.js')
);

function userSettingsPath() {
  if (process.env.VLLM_E2E_USER_SETTINGS) return process.env.VLLM_E2E_USER_SETTINGS;
  const home = process.env.HOME ?? process.env.USERPROFILE ?? '';
  const candidates =
    process.platform === 'win32'
      ? [path.join(process.env.APPDATA ?? '', 'Code', 'User', 'settings.json')]
      : process.platform === 'darwin'
        ? [path.join(home, 'Library', 'Application Support', 'Code', 'User', 'settings.json')]
        : [path.join(home, '.config', 'Code', 'User', 'settings.json')];
  return candidates[0];
}

function readConfiguredModels() {
  const file = userSettingsPath();
  if (!existsSync(file)) {
    console.error(`No VS Code user settings found at: ${file}`);
    console.error('Configure a server/model in the extension first, or set VLLM_E2E_USER_SETTINGS.');
    process.exit(2);
  }
  let settings;
  try {
    settings = JSON.parse(stripJsonc(readFileSync(file, 'utf8')));
  } catch (err) {
    console.error(`Cannot parse ${file}: ${String(err)}`);
    process.exit(2);
  }
  const servers = settings['vllm-copilot.servers'] ?? [];
  const models = settings['vllm-copilot.models'] ?? [];
  const rows = [];
  for (const m of models) {
    const entry = servers.find(s => s.id === m.server);
    if (!entry) continue; // model without a resolvable server is dead config; skip honestly
    rows.push({
      configId: m.id,
      wireId: m.vllmModelId ?? m.id,
      serverId: entry.id,
      displayName: entry.displayName ?? entry.id,
      serverUrl: entry.serverUrl, // in memory only: never printed
      requestHeaders: entry.requestHeaders ?? {}, // in memory only: never printed
    });
  }
  return rows;
}

function printTable(rows) {
  if (rows.length === 0) {
    console.error('No configured model with a resolvable server entry found in user settings.');
    process.exit(2);
  }
  console.log('Configured models (ids and secrets not shown - they embed hostnames):\n');
  rows.forEach((r, i) => {
    console.log(`  [${i + 1}] ${r.wireId}  @ "${r.displayName}"`);
  });
}

async function main() {
  const argv = process.argv.slice(2);
  if (process.env.VLLM_E2E_SERVER_URL) {
    console.log('VLLM_E2E_SERVER_URL already set: launching the rail in pass-through mode.');
    runRail(process.env);
    return;
  }

  const rows = readConfiguredModels();
  printTable(rows);
  if (argv.includes('--list')) return;

  let chosen;
  const modelFlag = argv.indexOf('--model');
  if (modelFlag >= 0 && argv[modelFlag + 1]) {
    const want = argv[modelFlag + 1];
    chosen = rows.find(r => r.wireId === want || r.configId === want);
    if (!chosen) {
      console.error(`No configured model with id "${want}". Use --list to see options.`);
      process.exit(2);
    }
  } else {
    const rl = createInterface({ input: stdin, output: stdout });
    const answer = await rl.question('\nWhich model should the live smoke use? [number or config id]: ');
    rl.close();
    const trimmed = answer.trim();
    const idx = Number.parseInt(trimmed, 10);
    chosen =
      rows.find(r => r.wireId === trimmed || r.configId === trimmed) ??
      (Number.isFinite(idx) && idx >= 1 && idx <= rows.length ? rows[idx - 1] : undefined);
    if (!chosen) {
      console.error(`"${trimmed}" matches neither a number in range nor a config id.`);
      process.exit(2);
    }
  }

  console.log(`\nRunning live smoke against "${chosen.wireId}" (server "${chosen.displayName}").`);
  console.log('The VS Code window will pop open; the rail seeds the throwaway test profile only.\n');
  runRail({
    ...process.env,
    VLLM_E2E_SERVER_URL: chosen.serverUrl,
    VLLM_E2E_MODEL: chosen.wireId,
    VLLM_E2E_HEADERS: JSON.stringify(chosen.requestHeaders ?? {}),
  });
}

function runRail(env) {
  mkdirSync('temp/e2e-workspace', { recursive: true });
  const result = spawnSync(process.execPath, ['node_modules/@vscode/test-cli/out/bin.mjs'], {
    stdio: 'inherit',
    env,
  });
  process.exit(result.status ?? 1);
}

main().catch(err => {
  console.error(String(err?.stack ?? err));
  process.exit(1);
});
