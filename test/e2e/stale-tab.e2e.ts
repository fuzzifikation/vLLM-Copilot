/**
 * Tripwire for the poisoned-window bug (owner-reproduced 2026-10-11): a
 * harness browser tab restored after a restart can never connect (the port
 * and token are reissued every boot), and in VS Code 1.140 that fail-load
 * native browser view paints over the workbench DOM and hides every menu in
 * the window. The sweep must close exactly its own zombies.
 *
 * Named breakages this catches that no vitest file can:
 *  - the sweep goes blind (label or history-read drift): every restart with
 *    the tab open returns a dead-menu window, the bug the owner lived through;
 *  - the sweep overreaches and closes a tab whose origin still answers: the
 *    user's live harness view, or a recycled port someone else got home on.
 *
 * Everything here goes through the real command, the real served-urls file
 * and real browser tabs, in the real extension host. Ported from the retired
 * standalone bridge (docs/extension-merger-plan.md); the harness history now
 * lives in THIS extension's own globalStorage.
 */
import * as assert from 'node:assert/strict';
import * as http from 'node:http';
import * as net from 'node:net';
import { mkdirSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';

const EXT_ID = 'System-Sciences.vllm-copilot';
/** VS Code names the globalStorage folder after the LOWERCASE extension id. */
const STORAGE_ID = 'system-sciences.vllm-copilot';
/** The harness home and its per-profile dir, from src/vscode/harness/paths.ts. */
const HARNESS_HOME = 'dsh-home';
const PROFILE_DIR = 'vllmc';
const SERVED_URLS = 'served-urls.log';
const SWEEP = 'vllm-copilot.harness.sweepStaleTabs';

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

function labels(): string[] {
  return vscode.window.tabGroups.all.flatMap(group => group.tabs.map(tab => tab.label));
}

/**
 * The extension activates on startup / vendor query, so the harness command
 * may not exist yet when the runner starts calling it. Activation also runs
 * the boot sweep, which is done and out of the way before these tests plant
 * anything.
 */
async function activateExtension(): Promise<void> {
  const ext = vscode.extensions.getExtension(EXT_ID);
  assert.ok(ext, `${EXT_ID} must be loaded (development path)`);
  if (!ext.isActive) await ext.activate();
}

/**
 * Where the running host really keeps this extension's served-url history:
 * the development extension is loaded from the repo, and @vscode/test-cli's
 * fresh profile is .vscode-test/user-data next to it (see .vscode-test.mjs —
 * no --user-data-dir override, so the default holds).
 */
function servedUrlsPath(): string {
  const repoRoot = vscode.extensions.getExtension(EXT_ID)?.extensionUri.fsPath;
  assert.ok(repoRoot, `${EXT_ID} must be loaded (development path)`);
  return path.join(
    repoRoot,
    '.vscode-test',
    'user-data',
    'User',
    'globalStorage',
    STORAGE_ID,
    HARNESS_HOME,
    PROFILE_DIR,
    SERVED_URLS
  );
}

function plantHistory(urls: string[]): void {
  const file = servedUrlsPath();
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, urls.join('\n') + '\n');
}

async function openBrowser(url: string): Promise<string> {
  const label = new URL(url).host;
  await vscode.commands.executeCommand('workbench.action.browser.open', url);
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (labels().includes(label)) return label;
    await sleep(250);
  }
  assert.fail(`no browser tab labeled ${label} appeared for ${url} (tabs: ${labels().join(' | ') || 'none'})`);
}

async function freePort(): Promise<number> {
  const probe = net.createServer();
  await new Promise<void>(resolve => probe.listen(0, '127.0.0.1', resolve));
  const port = (probe.address() as net.AddressInfo).port;
  await new Promise<void>(resolve => probe.close(() => resolve()));
  return port;
}

describe('stale embedded tab sweep', () => {
  before(async () => {
    await activateExtension();
  });

  it('closes a stale harness tab whose origin answers nothing', async () => {
    const label = `127.0.0.1:${await freePort()}`;
    const url = `http://${label}/stale-probe?token=dead`;
    plantHistory([url]);
    await openBrowser(url);
    await vscode.commands.executeCommand(SWEEP);
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline && labels().includes(label)) await sleep(300);
    assert.ok(!labels().includes(label), `the stale harness tab ${label} survived the sweep`);
  });

  it('keeps a harness-history tab whose origin still answers', async () => {
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('still home');
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const label = `127.0.0.1:${(server.address() as net.AddressInfo).port}`;
    try {
      plantHistory([`http://${label}/`]);
      await openBrowser(`http://${label}/`);
      await vscode.commands.executeCommand(SWEEP);
      await sleep(3000);
      assert.ok(labels().includes(label), `the sweep closed a live tab on ${label}`);
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });
});
