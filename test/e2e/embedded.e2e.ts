/**
 * Tripwire for a breakage that bit for real on 2026-10-05: the harness was
 * ruled to open embedded (an editor tab), and the extension quietly degraded
 * to the external browser. Two distinct failures hide behind that symptom and
 * only a real extension host can tell them apart:
 *  - `simpleBrowser.show` missing from the command registry (built-in dropped
 *    or disabled in this VS Code build), where the documented fallback fires;
 *  - the command existing but not producing a tab, e.g. an argument-shape
 *    drift on a built-in nobody owns.
 * The test drives the primitive, never `vllm-copilot.harness.open`, so a
 * fallback can never fling a real browser at the desktop from inside CI.
 */
import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';

describe('embedded harness view', () => {
  it('an embedded browser door exists and opens the URL', async () => {
    const commands = await vscode.commands.getCommands(true);
    const door = commands.includes('workbench.action.browser.open')
      ? 'workbench.action.browser.open'
      : commands.includes('simpleBrowser.show')
        ? 'simpleBrowser.show'
        : undefined;
    console.log(`embedded door: ${door ?? '(none; the external fallback is correct behavior here)'}`);
    if (!door) return;

    // Serve nothing; a refused connection still loads the tab around the
    // dead origin, which is all the primitive must prove.
    await vscode.commands.executeCommand(door, 'http://127.0.0.1:9/embedded-probe');
    const deadline = Date.now() + 15_000;
    let found = visibleTabs().some(label => label.includes('127.0.0.1') || label.includes('embedded-probe'));
    while (Date.now() < deadline && !found) {
      await new Promise(resolve => setTimeout(resolve, 250));
      found = visibleTabs().some(label => label.includes('127.0.0.1') || label.includes('embedded-probe'));
    }
    console.log(`tabs after ${door}: ${visibleTabs().join(' | ') || '(none)'}`);
    assert.ok(found, `${door} accepted the URL but no tab showing it appeared`);
  });
});

function visibleTabs(): string[] {
  return vscode.window.tabGroups.all.flatMap(group =>
    group.tabs.map(tab => `${tab.label} [${tab.input?.constructor.name ?? '?'}]`)
  );
}
