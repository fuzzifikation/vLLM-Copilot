/**
 * Deep-Dive panel lifecycle: the panel takes ONE reading per open and then
 * releases the metrics engine, so an idle tab never keeps a server polling.
 */
import * as vscode from 'vscode';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const harness = vi.hoisted(() => {
  const listeners: Array<(aggregated: any, raw: any) => void> = [];
  const engine = {
    listeners,
    subscribeCalls: 0,
    pollNowCalls: 0,
    cachedRaw: null as any,
    cachedAgg: null as any,
    subscribe(cb: (aggregated: any, raw: any) => void) {
      this.subscribeCalls++;
      listeners.push(cb);
      return {
        dispose: () => {
          const i = listeners.indexOf(cb);
          if (i >= 0) listeners.splice(i, 1);
        },
      };
    },
    pollNow() { this.pollNowCalls++; },
    getCachedRaw() { return this.cachedRaw; },
    getCachedAggregated() { return this.cachedAgg; },
    /** Finish one poll cycle, notifying current subscribers like the real engine. */
    emit(aggregated: any, raw: any) {
      for (const cb of [...listeners]) cb(aggregated, raw);
    },
  };
  return {
    engine,
    listeners,
    reset() {
      listeners.length = 0;
      engine.subscribeCalls = 0;
      engine.pollNowCalls = 0;
      engine.cachedRaw = null;
      engine.cachedAgg = null;
    },
  };
});

vi.mock('../src/vllmMetrics.js', () => ({ getMetricsEngine: () => harness.engine }));

import { openDeepDive } from '../src/deepDiveView.js';

const URL = 'http://localhost:8000';
const online = { online: true, error: undefined } as any;
const offline = { online: false, error: 'Cannot connect' } as any;
const raw = (marker: string) => ({ version: { marker } } as any);

/** Fake panel recording what the extension posts and exposing the webview handshake. */
function makePanel() {
  const messages: any[] = [];
  let msgHandler: ((m: any) => void) | undefined;
  let disposeHandler: (() => void) | undefined;
  const panel: any = {
    viewType: 'vllm-copilot.deepDive',
    title: '',
    messages,
    reveals: 0,
    webview: {
      html: '',
      options: {},
      cspSource: '',
      // Deliberately NOT cleared on dispose: VS Code can still hand an already
      // queued message to the handler after the panel closes, which is the race
      // `refresh()` guards against with its `disposed` check.
      onDidReceiveMessage: (fn: (m: any) => void) => {
        msgHandler = fn;
        return { dispose: () => {} };
      },
      postMessage: (m: any) => {
        messages.push(m);
        return Promise.resolve(true);
      },
      asWebviewUri: (u: unknown) => u,
    },
    onDidDispose: (fn: () => void) => {
      disposeHandler = fn;
      return { dispose: () => {} };
    },
    reveal: () => { panel.reveals++; },
    close: () => disposeHandler?.(),
    ready: () => msgHandler?.({ type: 'ready' }),
  };
  return panel;
}

const context = { extensionUri: vscode.Uri.file('/ext') } as vscode.ExtensionContext;
const output = { appendLine: () => {} } as unknown as vscode.OutputChannel;

function open(displayName?: string) {
  openDeepDive(URL, {}, 'vllm', context, output, displayName);
}

describe('Deep-Dive panel', () => {
  let panel: any;
  let create: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    harness.reset();
    panel = makePanel();
    create = vi.spyOn(vscode.window, 'createWebviewPanel').mockReturnValue(panel);
  });

  afterEach(() => {
    panel.close(); // keeps the module-level open-panel map clean between tests
    vi.restoreAllMocks();
  });

  it('takes exactly one reading and leaves the engine', () => {
    open();
    panel.ready();

    expect(harness.engine.subscribeCalls).toBe(1);
    // The engine may sit between intervals, so the panel asks for a cycle itself.
    expect(harness.engine.pollNowCalls).toBe(1);

    harness.engine.emit(online, raw('first'));
    expect(panel.messages).toEqual([{ type: 'data', raw: raw('first'), error: undefined }]);

    // Later cycles belong to whoever else is watching — the panel is gone.
    expect(harness.listeners.length).toBe(0);
    harness.engine.emit(online, raw('second'));
    expect(panel.messages).toHaveLength(1);
  });

  it('paints cached data first, then the live reading', () => {
    harness.engine.cachedRaw = raw('cached');
    open();
    panel.ready();

    expect(panel.messages.map((m: any) => m.raw)).toEqual([raw('cached')]);
    harness.engine.emit(online, raw('live'));
    expect(panel.messages.map((m: any) => m.raw)).toEqual([raw('cached'), raw('live')]);
  });

  it('carries the probe failure reason so an empty panel explains itself', () => {
    open();
    panel.ready();
    harness.engine.emit(offline, raw('empty'));

    expect(panel.messages[0]).toMatchObject({ type: 'data', error: 'Cannot connect' });
  });

  it('retakes the reading when the command is re-invoked, without a second panel', () => {
    open();
    panel.ready();
    harness.engine.emit(online, raw('first'));

    open(); // user clicks the server node again — this is the refresh gesture

    expect(create).toHaveBeenCalledTimes(1);
    expect(panel.reveals).toBe(1);
    expect(harness.engine.subscribeCalls).toBe(2);
    expect(harness.engine.pollNowCalls).toBe(2);

    harness.engine.emit(online, raw('second'));
    expect(panel.messages.map((m: any) => m.raw)).toEqual([raw('first'), raw('second')]);
  });

  it('releases a reading still in flight when the panel closes', () => {
    open();
    panel.ready();
    expect(harness.listeners.length).toBe(1);

    panel.close();
    expect(harness.listeners.length).toBe(0);

    // And the closed panel is no longer registered, so the next open is a new panel.
    open();
    expect(create).toHaveBeenCalledTimes(2);
  });

  it('ignores a `ready` delivered after the panel closed', () => {
    open();
    panel.ready();
    panel.close();

    // A queued `ready` must not subscribe again — nobody would ever dispose it.
    panel.ready();
    expect(harness.engine.subscribeCalls).toBe(1);
    expect(panel.messages).toHaveLength(0);
  });
});
