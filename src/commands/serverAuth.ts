import * as vscode from 'vscode';
import { buildAuthHeaders } from '../state/config.js';
import { jsonrepair } from 'jsonrepair';

/**
 * Parse a user-entered headers string into a validated `Record<string, string>`.
 * Accepts either JSON (`{"X-API-Key":"..."}`) or blank (no headers).
 * Returns `undefined` on parse/type error (caller shows the message).
 *
 * Forgiving: accepts strict JSON (`{"X-API-Key":"..."}`) and, via `jsonrepair`,
 * common shorthand — missing outer braces (`"X-API-Key":"..."`), unquoted
 * keys/values (`X-API-Key: abc`), single quotes, trailing/missing commas, and
 * one-pair-per-line input. Blank input means no headers.
 * @internal Exported for testing.
 */
export function parseHeadersInput(raw: string): { headers: Record<string, string> } | { error: string } {
  const trimmed = raw.trim();
  if (!trimmed) return { headers: {} };

  const headerNameRe = /^[a-zA-Z0-9!#$%&'*+.^_`|~-]+$/;

  // Validate + normalize a parsed value into a Record<string,string>.
  // Coerce numeric/boolean values to strings — header values are always strings.
  const fromObject = (parsed: unknown): { headers: Record<string, string> } | { error: string } | null => {
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      const name = k.trim();
      if (!headerNameRe.test(name)) return { error: `Invalid header name "${name}".` };
      if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
        headers[name] = String(v);
      } else {
        return { error: `Header "${name}" must be a string value.` };
      }
    }
    return { headers };
  };

  // Candidate strings to try parsing/repairing, in order of preference.
  // The brace-wrapped variant handles input that omits the outer { }.
  const candidates = trimmed.startsWith('{') ? [trimmed] : [trimmed, `{${trimmed}}`];

  for (const candidate of candidates) {
    // Strict parse first, then jsonrepair as a fallback (same pattern as tool-call args).
    for (const text of [candidate, tryRepair(candidate)]) {
      if (text === undefined) continue;
      try {
        const result = fromObject(JSON.parse(text));
        if (result) return result;
      } catch { /* try next candidate */ }
    }
  }

  return { error: 'Headers must be JSON like {"X-API-Key":"..."} or lines like X-API-Key: value' };
}

/** Repair a malformed JSON string; returns undefined if repair itself throws. */
function tryRepair(text: string): string | undefined {
  try {
    return jsonrepair(text);
  } catch {
    return undefined;
  }
}

/**
 * Prompt user for server auth credentials (API key + optional custom headers) via
 * sequential input boxes. Handles cancellation, validation, and combines both
 * into a single headers object. Returns `undefined` if the user cancelled at
 * either step.
 *
 * `promptForHeaders: false` (OpenRouter) asks ONLY for the API key and returns
 * just the Bearer auth — custom headers are an expert concern left to
 * settings editing, so no headers box is shown.
 */
export async function promptForServerAuth(options: {
  apiKeyTitle: string;
  apiKeyPrompt: string;
  apiKeyPlaceholder: string;
  headersTitle: string;
  headersPrompt: string;
  headersPlaceholder: string;
  /** Require a non-empty API key (e.g. OpenRouter — chat is billed per account). */
  requireApiKey?: boolean;
  /** Skip the custom-headers input box entirely (OpenRouter). Default true. */
  promptForHeaders?: boolean;
}): Promise<Record<string, string> | undefined> {
  // API key. Optional for the generic server flows; required when the caller
  // needs credentials (OpenRouter). Folded into headers as Authorization: Bearer.
  const apiKeyInput = await vscode.window.showInputBox({
    title: options.apiKeyTitle,
    prompt: options.apiKeyPrompt,
    placeHolder: options.apiKeyPlaceholder,
    ignoreFocusOut: true,
    password: true,
    validateInput: options.requireApiKey
      ? (v) => (!v.trim() ? 'An API key is required.' : undefined)
      : undefined,
  });
  if (apiKeyInput === undefined) return undefined; // cancelled
  const apiKey = apiKeyInput.trim();

  // OpenRouter: custom headers are not prompted — experts add them via settings.
  if (options.promptForHeaders === false) {
    return { ...buildAuthHeaders(apiKey) };
  }

  // Custom headers (optional). Accepts JSON or forgiving shorthand.
  // Merged on top of the key-derived auth headers, so a custom header wins.
  // `ignoreFocusOut: true` like the key box: users MUST be able to switch to
  // another app (Teams, email, password manager) to copy headers and paste them
  // back. Without it the box auto-dismisses on focus loss, the flow silently
  // continues with no headers, and the server probe reports "server not
  // reachable". Skipping is still possible via Escape (returns `undefined`) or
  // Enter on empty (returns `''`) — both mean "no custom headers" and must NOT
  // abort the whole Add flow.
  const headersInput = await vscode.window.showInputBox({
    title: options.headersTitle,
    prompt: options.headersPrompt,
    placeHolder: options.headersPlaceholder,
    ignoreFocusOut: true,
    validateInput: (v) => {
      const r = parseHeadersInput(v);
      return 'error' in r ? r.error : undefined;
    },
  });
  // `undefined` (Escape) and `''` (Enter on empty) both mean no headers.
  // Focus loss no longer dismisses the box (ignoreFocusOut above).
  if (headersInput === undefined) return { ...buildAuthHeaders(apiKey) };
  const parsedHeaders = parseHeadersInput(headersInput);
  // Unreachable in practice: the headers box's validateInput uses the same
  // parseHeadersInput and blocks bad input from being submitted. Keep the guard
  // (narrows the type) but never popup — no output channel exists here, so a
  // silent return lets the caller surface the cancel.
  if ('error' in parsedHeaders) return undefined;

  // Combine: API-key-derived auth first, then custom headers (custom wins).
  return { ...buildAuthHeaders(apiKey), ...parsedHeaders.headers };
}
