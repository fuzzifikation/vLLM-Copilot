import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, it, expect } from 'vitest';
import { KNOWN_SERVER_TYPES } from '../src/state/config.js';

/**
 * Tripwire for the untyped webview <-> host message contract.
 *
 * The Webview JS in resources/ is not compiled and shares no types with the
 * extension host. When the two sides drift, the failure is silent for the
 * user: an unhandled `msg.type` is dropped (button click does nothing), and a
 * listener for a type the host never posts never fires. This happened in
 * development with the backend dropdown (the host validated against
 * KNOWN_SERVER_TYPES while the webview kept its own copy of the list) and the
 * `"false"`-as-string save bug.
 *
 * These tests read BOTH source files as text and pin the contract sets:
 *   - every type the webview posts, the host handles (and vice versa: no
 *     handler for a message that is never sent)
 *   - every type the host posts, the webview listens for
 *   - the backend dropdown offers exactly KNOWN_SERVER_TYPES
 * If a refactor changes the message syntax itself, the floor assertions fail
 * so this file cannot silently pass by matching nothing.
 */

function read(rel: string): string {
  return fs.readFileSync(path.resolve(rel), 'utf8');
}

function typesIn(source: string, regex: RegExp): Set<string> {
  const found = new Set<string>();
  for (const m of source.matchAll(regex)) found.add(m[1]);
  return found;
}

function toSorted(found: Set<string>): string[] {
  return [...found].sort();
}

// Object literals carrying a message type: `postMessage({ type: 'x' ...`
// and the ternary form `? { type: 'x', ... } : { type: 'x', ... }`.
const SENT_RE = /\{\s*type:\s*'([\w-]+)'/g;
const HANDLED_RE = /msg\.type === '([\w-]+)'/g;
const POSTED_RE = /postMessage\(\{\s*type:\s*'([\w-]+)'/g;
// Matches both `e.data.type === 'x'` and the destructured `data.type === 'x'`.
const LISTENED_RE = /data\.type === '([\w-]+)'/g;

const pairs = [
  { name: 'Model Settings', webview: 'resources/serverSettings.js', host: 'src/ui/serverSettingsView.ts' },
  { name: 'Deep Dive', webview: 'resources/deepDive.js', host: 'src/ui/deepDiveView.ts' },
];

for (const pair of pairs) {
  describe(`${pair.name} webview message contract`, () => {
    const webview = read(pair.webview);
    const host = read(pair.host);

    it('webview -> host types are exactly the types the host handles', () => {
      const sent = typesIn(webview, SENT_RE);
      const handled = typesIn(host, HANDLED_RE);
      expect(sent.size, 'no sent types extracted — regex stale after a refactor?').toBeGreaterThan(0);
      expect(handled.size, 'no handled types extracted — regex stale after a refactor?').toBeGreaterThan(0);
      expect(toSorted(sent), 'webview posts messages the host drops silently').toEqual(toSorted(handled));
    });

    it('host -> webview types are exactly the types the webview listens for', () => {
      const posted = typesIn(host, POSTED_RE);
      const listened = typesIn(webview, LISTENED_RE);
      expect(posted.size, 'no posted types extracted — regex stale after a refactor?').toBeGreaterThan(0);
      expect(listened.size, 'no listened types extracted — regex stale after a refactor?').toBeGreaterThan(0);
      expect(toSorted(posted), 'webview listens for types the host never posts / posts ignored types').toEqual(toSorted(listened));
    });
  });
}

describe('Model Settings backend dropdown', () => {
  it('offers exactly the KNOWN_SERVER_TYPES the host validates against', () => {
    const webview = read('resources/serverSettings.js');
    const match = webview.match(/Server Type<\/label><select id="sTypeSel">' \+\s*\[([^\]]+)\]/);
    expect(match, 'dropdown type list not found — regex stale after a refactor?').not.toBeNull();
    const options = [...match![1].matchAll(/'([\w-]+)'/g)].map((m) => m[1]);
    expect(options.length).toBeGreaterThan(0);
    // Set equality: the webview may order the dropdown differently than the
    // validation list (OpenRouter listed second on purpose).
    expect([...options].sort(), 'webview dropdown drifted from KNOWN_SERVER_TYPES').toEqual(
      [...KNOWN_SERVER_TYPES].sort(),
    );
  });
});
