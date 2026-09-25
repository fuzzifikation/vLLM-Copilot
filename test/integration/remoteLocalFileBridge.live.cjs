/**
 * Live check for the remote-to-local file bridge, documented in
 * docs/remote-local-file-bridge.md. This is the one automated guard against VS Code
 * changing or removing the internal `vscode-userdata:` provider, which is the top
 * risk listed for the optional local config-file backend.
 *
 * It runs inside a REAL VS Code extension host, because a mock cannot answer the
 * question: does the workbench still route `vscode-userdata:` writes, renames,
 * watcher events, and open-editor reloads to the local client disk?
 *
 * Manual opt-in check, deliberately NOT part of `npm test`: it launches a real
 * VS Code process and needs the installed desktop build.
 *
 *   1. The marker file is written through `vscode-userdata:` and must appear on
 *      the local disk.
 *   2. A sibling temp file is renamed over it, the atomic write the production
 *      adapter will use.
 *   3. A real FileSystemWatcher on `new RelativePattern(markerUri, '*')` must fire.
 *   4. The already-open editor must reload to the new token, which is the only
 *      user-visible claim the whole bridge rests on.
 *
 * Launcher note that cost us a fake green: on Windows, `& Code.exe` from
 * PowerShell does not block on the GUI process, so a harness can delete its own
 * profile before the extension host writes results and still print exit code 0.
 * Launch with `Start-Process -Wait` and require the result file on disk before
 * believing anything. See docs/remote-local-file-bridge.md section 6.
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vscode = require('vscode');

const LOCAL_USER_DATA_SCHEME = 'vscode-userdata';
const WAIT_TIMEOUT_MS = 8000;

function userDataUri(fileUri) {
  return fileUri.with({ scheme: LOCAL_USER_DATA_SCHEME });
}

function encode(value) {
  return new TextEncoder().encode(`${JSON.stringify(value, null, 2)}\n`);
}

function decode(bytes) {
  return JSON.parse(new TextDecoder().decode(bytes));
}

function parseDocument(document) {
  try {
    return JSON.parse(document.getText());
  } catch {
    return null;
  }
}

async function waitFor(predicate, description) {
  const deadline = Date.now() + WAIT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const value = predicate();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for ${description}.`);
}

async function run() {
  const resultPath = process.env.CONFIG_BRIDGE_PROBE_LIVE_RESULT;
  assert.ok(resultPath, 'CONFIG_BRIDGE_PROBE_LIVE_RESULT is required.');

  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'config-bridge-probe-live-'));
  const fileUri = vscode.Uri.file(path.join(directory, 'marker.json'));
  const markerUri = userDataUri(fileUri);
  const testId = `live-${Date.now()}`;
  const tokenA = `local-A-${Date.now()}`;
  const tokenB = `wsl-B-${Date.now()}`;
  const tempUri = markerUri.with({ path: `${markerUri.path}.tmp-${tokenB}` });

  const watcher = vscode.workspace.createFileSystemWatcher(
    new vscode.RelativePattern(markerUri, '*'),
    false,
    false,
    false,
  );
  let sawChange = false;
  const onChange = uri => {
    if (uri.toString() === markerUri.toString()) sawChange = true;
  };
  watcher.onDidChange(onChange);
  watcher.onDidCreate(onChange);

  try {
    assert.equal(vscode.env.remoteName, undefined, 'Live provider test must run in a local VS Code host.');
    assert.equal(
      vscode.workspace.fs.isWritableFileSystem(LOCAL_USER_DATA_SCHEME),
      true,
      'The installed VS Code must expose a writable vscode-userdata provider.',
    );

    const localPayload = {
      probe: 'vllm-copilot-config-bridge-roundtrip',
      version: 1,
      testId,
      revision: 1,
      state: 'local-written',
      token: tokenA,
      writtenAt: new Date().toISOString(),
      writer: 'local',
      remoteName: null,
    };
    await vscode.workspace.fs.writeFile(markerUri, encode(localPayload));
    assert.equal(decode(await vscode.workspace.fs.readFile(markerUri)).token, tokenA);
    assert.equal(
      fs.readFileSync(fileUri.fsPath, 'utf8').includes(tokenA),
      true,
      'vscode-userdata did not reach the local disk file.',
    );

    const document = await vscode.workspace.openTextDocument(fileUri);
    const editor = await vscode.window.showTextDocument(document, { preview: false });
    assert.equal(parseDocument(document).token, tokenA);

    // The production adapter writes a sibling temp file and renames it over the target.
    const remotePayload = {
      ...localPayload,
      revision: 2,
      state: 'remote-written',
      token: tokenB,
      writtenAt: new Date().toISOString(),
      writer: 'remote:live-test',
      remoteName: 'wsl+Ubuntu',
      readBeforeWrite: { token: tokenA, state: localPayload.state, writer: localPayload.writer },
    };
    await vscode.workspace.fs.writeFile(tempUri, encode(remotePayload));
    assert.equal(decode(await vscode.workspace.fs.readFile(tempUri)).token, tokenB);
    await vscode.workspace.fs.rename(tempUri, markerUri, { overwrite: true });

    await waitFor(() => sawChange, 'the live vscode-userdata watcher event');
    await waitFor(() => parseDocument(document)?.token === tokenB, 'the open editor to refresh to token B');
    assert.equal(decode(await vscode.workspace.fs.readFile(markerUri)).token, tokenB);
    assert.equal(fs.readFileSync(fileUri.fsPath, 'utf8').includes(tokenB), true, 'The renamed payload did not reach local disk.');
    assert.equal(document.isDirty, false);

    const result = {
      liveVscodeProvider: 'PASS',
      localDiskWrite: 'PASS',
      realUserDataWrite: 'PASS',
      realUserDataRename: 'PASS',
      realWatcherEvent: 'PASS',
      openEditorRefresh: 'PASS',
      tokenA,
      tokenB,
      editorVersion: document.version,
      editorViewColumn: editor.viewColumn ?? null,
    };
    fs.writeFileSync(resultPath, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    fs.writeFileSync(
      resultPath,
      `${JSON.stringify({ liveVscodeProvider: 'FAIL', error: error.stack || String(error) }, null, 2)}\n`,
      'utf8',
    );
    throw error;
  } finally {
    watcher.dispose();
    try {
      await vscode.workspace.fs.delete(markerUri);
      await vscode.workspace.fs.delete(tempUri);
    } catch {
      // Disposable cleanup only.
    }
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

module.exports = { run };
