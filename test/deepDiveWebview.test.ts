import * as fs from 'node:fs';
import * as path from 'node:path';
import { JSDOM } from 'jsdom';
import { describe, expect, it, beforeEach } from 'vitest';

/**
 * Behavioral harness for the Deep-Dive webview (`resources/deepDive.js`), the
 * counterpart to `serverSettingsWebview.test.ts` for Model Settings. The webview
 * script is NOT compiled by TypeScript, so the DOM contract is tested here:
 * ready handshake, data rendering, error state, escaping, the Ctrl+F overlay,
 * and histogram tooltips.
 */

const script = fs.readFileSync(
  path.resolve('resources/deepDive.js'),
  'utf8',
);

/** The body skeleton `deepDiveView.ts#buildHtml` ships. */
const HTML_SKELETON = `<!doctype html><body>
  <header>
    <h1>vLLM Deep-Dive</h1>
    <span class="refresh-info" id="lastUpdated">Loading…</span>
  </header>
  <div id="content"><div class="loading">Fetching vLLM server data…</div></div>
</body>`;

/** A realistic `ServerRawData` fixture covering every render branch. */
function makeRawData(): any {
  return {
    version: { version: 'v0.6.0', commit: 'abc123' },
    healthStatus: 200,
    healthBody: 'OK',
    serverLoad: 0.42,
    models: [
      { id: 'Qwen/Qwen3-8B', max_model_len: 32768, owned_by: 'vllm' },
      { id: 'evil<img src=x onerror=window.__pwned=1>', max_model_len: 4096 },
    ],
    metrics: {
      gauges: {
        num_requests_running: [{ name: 'num_requests_running', labels: {}, value: 3, description: '' }],
        kv_cache_usage_perc: [{ name: 'kv_cache_usage_perc', labels: {}, value: 0.5, description: 'GPU KV cache utilization (0-1)' }],
      },
      counters: {
        prompt_tokens_total: [{ name: 'prompt_tokens_total', labels: {}, value: 1000, description: '' }],
      },
      histograms: {
        time_to_first_token_seconds: [
          { name: 'time_to_first_token_seconds', labels: { le: '0.01' }, value: 5 },
          { name: 'time_to_first_token_seconds', labels: { le: '+Inf' }, value: 10 },
        ],
      },
      cache_config: { num_gpu_blocks: 1000, block_size: 16 },
      process: {},
      http: {},
    },
  };
}

function loadDeepDive() {
  const dom = new JSDOM(HTML_SKELETON, {
    runScripts: 'outside-only',
    url: 'https://webview.test/',
  });
  const posted: any[] = [];
  (dom.window as any).acquireVsCodeApi = () => ({
    postMessage: (message: unknown) => posted.push(message),
  });
  // jsdom does not implement scrollIntoView; the find overlay calls it.
  dom.window.HTMLElement.prototype.scrollIntoView = () => {};
  dom.window.eval(script);
  return { dom, posted };
}

/** Dispatch a webview message from the extension host. */
function send(dom: JSDOM, data: unknown): void {
  dom.window.dispatchEvent(new dom.window.MessageEvent('message', { data }));
}

describe('Deep-Dive webview', () => {
  beforeEach(() => {
    (globalThis as any).__pwned = undefined;
  });

  it('posts ready to the extension host on load', () => {
    const { posted } = loadDeepDive();
    expect(posted).toContainEqual({ type: 'ready' });
  });

  it('renders the server data sections on a data message', () => {
    const { dom } = loadDeepDive();
    send(dom, { type: 'data', raw: makeRawData() });

    const doc = dom.window.document;
    const content = doc.getElementById('content')!;
    // Version, health, load, models, cache, gauges, counters, histograms.
    expect(content.textContent).toContain('Version Info');
    expect(content.textContent).toContain('v0.6.0');
    expect(content.textContent).toContain('Healthy');
    expect(content.textContent).toContain('42%');
    expect(content.textContent).toContain('Qwen/Qwen3-8B');
    expect(content.textContent).toContain('num_requests_running');
    expect(content.textContent).toContain('prompt_tokens_total');
    expect(content.textContent).toContain('time_to_first_token_seconds');
    // Histogram bars render as SVG rects.
    expect(doc.querySelectorAll('.histogram-bar').length).toBeGreaterThan(0);
    // lastUpdated reflects the render.
    expect(doc.getElementById('lastUpdated')!.textContent).toContain('Updated ');
  });

  it('escapes untrusted model ids so no markup is injected', () => {
    const { dom } = loadDeepDive();
    send(dom, { type: 'data', raw: makeRawData() });

    const content = dom.window.document.getElementById('content')!;
    // The injected "<img ... onerror=..." payload must be escaped text, not DOM.
    expect(content.innerHTML).not.toContain('<img');
    expect((globalThis as any).__pwned).toBeUndefined();
    expect(content.textContent).toContain('evil<img');
  });

  it('shows an escaped probe error alongside the data', () => {
    const { dom } = loadDeepDive();
    send(dom, { type: 'data', raw: makeRawData(), error: '<script>window.__pwned=1</script> boom' });

    const content = dom.window.document.getElementById('content')!;
    const banner = content.querySelector('.error-msg');
    expect(banner).not.toBeNull();
    expect(banner!.textContent).toContain('boom');
    // The banner explains a failed probe; data that did arrive stays visible.
    expect(content.textContent).toContain('Version Info');
    expect(content.querySelector('script')).toBeNull();
    expect((globalThis as any).__pwned).toBeUndefined();
  });

  it('clears the probe error once a later tick succeeds', () => {
    const { dom } = loadDeepDive();
    send(dom, { type: 'data', raw: makeRawData(), error: 'Cannot connect' });
    expect(dom.window.document.querySelector('.error-msg')).not.toBeNull();

    send(dom, { type: 'data', raw: makeRawData() });
    expect(dom.window.document.querySelector('.error-msg')).toBeNull();
  });

  it('Ctrl+F overlay highlights matches and navigates them', async () => {
    const { dom } = loadDeepDive();
    send(dom, { type: 'data', raw: makeRawData() });

    const doc = dom.window.document;
    // Open the overlay (Ctrl+F).
    doc.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'f', ctrlKey: true, bubbles: true }));
    const overlay = doc.getElementById('find-overlay')!;
    expect(overlay.style.display).toBe('block');

    // Type a query that matches "v0.6.0" once.
    const input = overlay.querySelector<HTMLInputElement>('.find-input')!;
    input.value = 'v0.6';
    input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    await new Promise(resolve => setTimeout(resolve, 160)); // 150ms debounce

    expect(doc.querySelectorAll('#content mark.find-match').length).toBeGreaterThan(0);
    expect(overlay.querySelector('.find-count')!.textContent).toMatch(/0\/\d+/);

    // Next → active match advances.
    overlay.querySelector<HTMLButtonElement>('.find-btn[data-action="next"]')!.click();
    expect(doc.querySelector('#content mark.find-match.is-active')).not.toBeNull();
    expect(overlay.querySelector('.find-count')!.textContent).toMatch(/1\/\d+/);
  });

  it('shows a histogram tooltip on pointermove over a bar', () => {
    const { dom } = loadDeepDive();
    send(dom, { type: 'data', raw: makeRawData() });

    const bar = dom.window.document.querySelector<HTMLElement>('.histogram-bar')!;
    expect(bar).not.toBeNull();
    bar.dispatchEvent(new dom.window.MouseEvent('pointermove', {
      bubbles: true,
      clientX: 100,
      clientY: 100,
    }));

    const tooltip = dom.window.document.querySelector<HTMLElement>('.histogram-tooltip')!;
    expect(tooltip).not.toBeNull();
    expect(tooltip.hidden).toBe(false);
    expect(tooltip.textContent).toBe(bar.getAttribute('data-tooltip'));
  });
});
