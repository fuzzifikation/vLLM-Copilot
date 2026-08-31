/**
 * Pure conversion between VS Code chat message types and OpenAI chat-completions format,
 * plus error formatting and tool-call arg parsing.
 *
 * Imports `vscode` for `instanceof` checks against its concrete part classes. Tests stub
 * `vscode` via vitest module aliasing (see test/__mocks__/vscode.ts).
 */

import * as vscode from 'vscode';
import { jsonrepair } from 'jsonrepair';
import { parse as parsePartialJson, disableErrorLogging } from 'best-effort-json-parser';
import { collectErrorMessages } from './errorEnvelope.js';
import type {
  FinalizedToolCall,
  OpenAIChatMessage,
  OpenAIToolCall,
  OpenAIContentPart,
} from './types.js';

// best-effort-json-parser logs parse errors to console by default; silence it so
// our own [WARN] log is the single source of truth for unparseable args.
disableErrorLogging();

/**
 * Extract a textual representation of a chat message for token counting.
 * Walks content parts so we don't fall back to `.toString()` (which returns
 * "[object Object]" for the message class).
 */
export function messageToText(msg: vscode.LanguageModelChatRequestMessage): string {
  const out: string[] = [];
  for (const part of msg.content) {
    if (part instanceof vscode.LanguageModelTextPart) {
      out.push(part.value);
    } else if (isThinkingPart(part)) {
      out.push(thinkingPartToText(part));
    } else if (part instanceof vscode.LanguageModelToolCallPart) {
      out.push(part.name);
      try { out.push(JSON.stringify(part.input)); } catch { /* ignore */ }
    } else if (part instanceof vscode.LanguageModelToolResultPart) {
      out.push(extractToolResultContent(part));
    }
  }
  return out.join('\n');
}

/**
 * Convert VS Code chat messages to OpenAI chat-completions format,
 * preserving the tool roundtrip (assistant tool_calls → tool result message).
 *
 * Handles all three VS Code message roles:
 * - `System` → passed through as `role: 'system'` (OpenAI supports this; Copilot
 *   may inject system messages for agent instructions).
 * - `Assistant` → text + tool calls.
 * - `User` → text/image parts + tool results (split into `role: 'tool'` messages).
 */
export function convertMessages(
  messages: readonly vscode.LanguageModelChatRequestMessage[]
): OpenAIChatMessage[] {
  const systemTexts: string[] = [];
  const otherMessages: OpenAIChatMessage[] = [];
  for (const msg of messages) {
    if (msg.role === vscode.LanguageModelChatMessageRole.Assistant) {
      const converted = convertAssistantMessage(msg);
      if (converted) otherMessages.push(converted);
    } else if (msg.role === vscode.LanguageModelChatMessageRole.User) {
      otherMessages.push(...convertUserMessage(msg));
    } else {
      const text = messageToText(msg);
      if (text) {
        systemTexts.push(text);
      }
    }
  }
  const result: OpenAIChatMessage[] = [];
  if (systemTexts.length > 0) {
    result.push({ role: 'system', content: systemTexts.join('\n\n') });
  }
  result.push(...otherMessages);
  return result;
}

/**
 * Convert an assistant message to OpenAI format. Handles text + tool calls.
 * Returns null if the message has neither.
 */
export function convertAssistantMessage(msg: vscode.LanguageModelChatRequestMessage): OpenAIChatMessage | null {
  const textParts: string[] = [];
  const reasoningParts: string[] = [];
  const toolCalls: OpenAIToolCall[] = [];

  for (const part of msg.content) {
    if (part instanceof vscode.LanguageModelTextPart) {
      textParts.push(part.value);
    } else if (isThinkingPart(part)) {
      reasoningParts.push(thinkingPartToText(part));
    } else if (part instanceof vscode.LanguageModelToolCallPart) {
      toolCalls.push({
        id: part.callId,
        type: 'function',
        function: {
          name: part.name,
          arguments: JSON.stringify(part.input),
        },
      });
    }
  }

  if (textParts.length === 0 && reasoningParts.length === 0 && toolCalls.length === 0) return null;

  return {
    role: 'assistant',
    content: textParts.join('\n') || '',
    ...(reasoningParts.length > 0 ? { reasoning: reasoningParts.join('') } : {}),
    ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
  };
}

/**
 * Detect the thinking part supplied by newer VS Code hosts without requiring
 * the proposal type at compile time. The host owns the conversation history;
 * this adapter only forwards the part it already provided.
 */
function isThinkingPart(part: unknown): part is { value: string | string[] } {
  const ThinkingPart = (vscode as typeof vscode & {
    LanguageModelThinkingPart?: new (...args: any[]) => unknown;
  }).LanguageModelThinkingPart;
  return typeof ThinkingPart === 'function' && part instanceof ThinkingPart;
}

function thinkingPartToText(part: { value: string | string[] }): string {
  return Array.isArray(part.value) ? part.value.join('') : part.value;
}

/**
 * Convert a user message to OpenAI format. Splits tool results into separate
 * `role: 'tool'` messages and emits text/image parts as the user message.
 */
export function convertUserMessage(msg: vscode.LanguageModelChatRequestMessage): OpenAIChatMessage[] {
  const result: OpenAIChatMessage[] = [];
  const contentParts: OpenAIContentPart[] = [];
  const toolResults: vscode.LanguageModelToolResultPart[] = [];

  for (const part of msg.content) {
    if (part instanceof vscode.LanguageModelTextPart) {
      contentParts.push({ type: 'text', text: part.value });
    } else if (part instanceof vscode.LanguageModelToolResultPart) {
      toolResults.push(part);
    } else if (isImagePart(part)) {
      contentParts.push({
        type: 'image_url',
        image_url: { url: imagePartToDataUri(part) },
      });
    }
  }

  // Tool results first (they respond to the previous assistant's tool_calls)
  for (const toolResult of toolResults) {
    result.push({
      role: 'tool',
      tool_call_id: toolResult.callId,
      content: extractToolResultContent(toolResult),
    });
  }

  if (contentParts.length > 0) {
    result.push({
      role: 'user',
      content: contentParts.length === 1 && contentParts[0].type === 'text'
        ? contentParts[0].text
        : contentParts,
    });
  }

  // Always emit at least one message so the request isn't dropped
  if (result.length === 0) {
    result.push({ role: 'user', content: '' });
  }

  return result;
}

/**
 * Extract text content from a tool result part.
 *
 * Filters out `LanguageModelDataPart` (binary data such as images or internal metadata
 * like cache_control/usage). While VS Code's type system allows `LanguageModelDataPart`
 * in tool results, OpenAI's API only accepts `string` content for `role: 'tool'`
 * messages, so binary data cannot be forwarded anyway.
 */
export function extractToolResultContent(part: vscode.LanguageModelToolResultPart): string {
  // content is always an array per the LanguageModelToolResultPart type definition.
  // Filter out LanguageModelDataPart — binary data cannot be sent to the model via
  // OpenAI's tool role (string content only), so internal metadata (cache_control,
  // usage) and any hypothetical binary results are both correctly dropped here.
  return part.content
    .map(c => {
      if (c instanceof vscode.LanguageModelTextPart) return c.value;
      if (typeof c === 'string') return c;
      // Filter LanguageModelDataPart class instances (the normal case).
      if (c instanceof vscode.LanguageModelDataPart) return '';
      // Filter raw VS Code protocol objects that weren't instantiated as the class
      // but still carry internal metadata. $mid is VS Code's internal stream protocol
      // identifier and is safe to use as the discriminator — unlike 'mimeType' which
      // could appear in legitimate tool output (e.g. file-info tools).
      if (typeof c === 'object' && c !== null && '$mid' in c) return '';
      return JSON.stringify(c);
    })
    .filter(s => s !== '')
    .join('\n');
}

/**
 * Parse tool call arguments with JSON repair fallback.
 *
 * Three tiers, each more lenient than the last:
 *   1. `JSON.parse` — strict. Handles the normal case (complete, valid JSON).
 *   2. `jsonrepair` — repairs malformed-but-complete JSON (missing quotes,
 *      trailing commas, etc.).
 *   3. `parsePartialJson` (best-effort-json-parser) — recovers *truncated* JSON,
 *      e.g. when `finish_reason: 'length'` cuts a tool call mid-string-value
 *      (`{"path":"foo.ts","content":"def hello():\n    print(`). This is the case
 *      jsonrepair throws on (it can only close structures, not open strings).
 *      Adopted from Copilot's BYOK path, which uses the same library for the
 *      same reason.
 *
 * Returns `null` only when args are present but *completely* unparseable so the
 * caller can fall back to `{}` (matching BYOK). Returns `{}` for empty/absent
 * args (legitimate empty-call case).
 */
export function parseToolCallArgs(
  toolCall: FinalizedToolCall,
  onUnparseable?: (toolName: string, raw: string) => void
): object | null {
  if (!toolCall.arguments || toolCall.arguments === '{}') return {};

  try {
    const parsed = JSON.parse(toolCall.arguments);
    if (typeof parsed === 'object' && !Array.isArray(parsed) && parsed !== null) return parsed;
  } catch {
    // fall through to repair
  }

  try {
    const repaired = jsonrepair(toolCall.arguments.trim());
    const parsed = JSON.parse(repaired);
    if (typeof parsed === 'object' && !Array.isArray(parsed) && parsed !== null) return parsed;
  } catch {
    // fall through to partial-parse
  }

  // Third tier: recover truncated JSON. parsePartialJson closes open strings,
  // arrays, and objects — the one case jsonrepair can't handle (it throws on
  // an unterminated string value). This preserves the partial content the model
  // produced before being cut off by maxOutputTokens.
  try {
    const partial = parsePartialJson(toolCall.arguments);
    if (typeof partial === 'object' && !Array.isArray(partial) && partial !== null) return partial;
  } catch {
    // fall through to unparseable
  }

  onUnparseable?.(toolCall.name, toolCall.arguments);
  return null; // unparseable — caller should fall back to {}
}

/**
 * Walk an error's `cause` chain, yielding each cause value in order.
 * Caps traversal depth to guard against cyclic/self-referential chains.
 */
export function* iterateCauses(err: unknown, maxDepth = 5): Generator<unknown> {
  let cause = (err as { cause?: unknown } | null | undefined)?.cause;
  let depth = 0;
  while (cause && depth < maxDepth) {
    yield cause;
    cause = (cause as { cause?: unknown }).cause;
    depth++;
  }
}

/**
 * Detect whether an error is a graceful termination rather than a hard failure.
 *
 * VS Code may close the fetch connection internally (e.g., after reading files
 * during tool orchestration) without firing the cancellation token. This produces
 * `TypeError: terminated` (possibly with a network-level cause like ECONNRESET).
 *
 * A `TypeError: terminated` means something called `.terminate()` on the response
 * ReadableStream — that is always an intentional action (not a random network
 * failure), so it is by definition graceful.
 *
 * NOTE: Bare ECONNRESET, "socket hang up", etc. (without the TypeError wrapper)
 * are genuine network failures, NOT graceful terminations — they should surface
 * to the user as connectivity errors.
 *
 * Timeouts and user cancellations are handled separately and should NOT match here.
 */
export function isGracefulTermination(err: unknown): boolean {
  if (typeof err === 'string') {
    // Plain string throws from fetch are typically our own abort reasons
    // (inactivity timeout, user cancelled), not graceful terminations.
    return false;
  }
  if (err instanceof Error) {
    const name = err.name ?? '';
    const msg = err.message ?? '';

    // `TypeError: terminated` — the response ReadableStream was terminated by
    // something calling `.terminate()` on it. This is always intentional
    // (e.g., VS Code's internal fetch layer after tool orchestration).
    if (name === 'TypeError' && msg === 'terminated') {
      return true;
    }

    // Check cause chain for the same pattern (wrapping can nest the original).
    for (const cause of iterateCauses(err)) {
      if (cause instanceof Error && cause.name === 'TypeError' && cause.message === 'terminated') {
        return true;
      }
    }
  }
  return false;
}

/**
 * True when the request failed at the transport layer: the server never
 * answered (connection refused, DNS failure, undici `fetch failed`). HTTP
 * error responses (the server answered, even with a 5xx) are NOT transport
 * failures, and neither are cancellations, timeouts, or mid-stream resets.
 *
 * Used to invalidate the model cache: a transport failure means the picker
 * was advertising a server that no longer exists, so the next resolve should
 * re-probe rather than reuse the snapshot.
 */
export function isTransportFailure(err: unknown): boolean {
  if (typeof err === 'string' || !(err instanceof Error)) return false;
  const combined = [err, ...iterateCauses(err)]
    .map(c => (c instanceof Error ? `${c.name} ${c.message}` : String(c)))
    .join(' ');
  return combined.includes('ECONNREFUSED')
    || combined.includes('fetch failed')
    || combined.includes('ENOTFOUND');
}

/**
 * Serialize an error to a multi-line string with full diagnostic info:
 * name, message, cause chain, and stack trace.
 * Handles both Error objects and plain string throws (fetch abort returns a string!).
 * Use this for OUTPUT channel / file log entries — never for user-facing text.
 */
export function serializeError(err: unknown): string {
  // Node.js fetch() throws a plain string when aborted, not an Error object.
  // e.g., "Stream inactivity timeout (30000ms without data)"
  if (typeof err === 'string') {
    return `Fetch abort (string): ${err}`;
  }
  if (err instanceof Error) {
    const lines: string[] = [];
    lines.push(`${err.name}: ${err.message}`);
    // Unwrap cause chain (fetch errors often wrap the real cause)
    for (const cause of iterateCauses(err)) {
      const causeStr = cause instanceof Error
        ? `${cause.name}: ${cause.message}`
        : String(cause);
      lines.push(`  caused by: ${causeStr}`);
    }
    if (err.stack) {
      const stackLines = err.stack.split('\n').slice(1);
      lines.push(...stackLines);
    }
    return lines.join('\n');
  }
  // Fallback for any other thrown value
  try { return `Non-error thrown: ${JSON.stringify(err)}`; }
  catch { return `Non-error thrown: ${String(err)}`; }
}

/**
 * Compact one-line description of an error that unwraps its `cause` chain.
 *
 * Node's global `fetch` (undici) throws `TypeError: fetch failed` and buries the
 * real reason in `err.cause` — e.g. a TLS failure behind a corporate MITM proxy
 * (`UNABLE_TO_GET_ISSUER_CERT_LOCALLY`, `SELF_SIGNED_CERT_IN_CHAIN`), a refused
 * connection (`ECONNREFUSED`), DNS failure (`ENOTFOUND`), or a proxy `407`.
 * Logging only `err.message` hides all of that, so this appends each cause
 * (with its `.code` when present) to keep one-liner log entries diagnosable.
 */
export function describeError(err: unknown): string {
  if (typeof err === 'string') return err;
  if (!(err instanceof Error)) return String(err);

  const format = (e: Error): string => {
    const code = (e as { code?: unknown }).code;
    return `${e.name}: ${e.message}${code ? ` [${String(code)}]` : ''}`;
  };

  const parts = [format(err)];
  for (const cause of iterateCauses(err)) {
    parts.push(cause instanceof Error ? format(cause) : String(cause));
  }
  return parts.join(' ← caused by: ');
}

/**
 * Extract a server-reported HTTP status from a non-OK fetch-response error.
 *
 * `fetchWithRetry` throws `HTTP <code>: <statusText> — <body>` (the 5xx retry
 * path builds a similar line). This parses the code and the server's own
 * message: the OpenAI-compatible `error.message` from the JSON body when
 * present, otherwise the HTTP status text.
 *
 * Matches only a real status marker (`HTTP \d{3}`), so a bare "50000" in the
 * body can never be misread as an HTTP 500 (the old substring classifier did).
 */
function extractServerErrorInfo(text: string): { code: string; message?: string } | undefined {
  const m = text.match(/HTTP\s+(\d{3})\b/);
  if (!m) return undefined;
  const code = m[1];

  // Prefer the server's JSON error.message (OpenAI-compatible error envelope).
  const jsonMessage = extractServerErrorMessage(text);
  if (jsonMessage !== undefined) return { code, message: jsonMessage };

  // Fall back to the HTTP status text ("Payment Required", "Unauthorized", …),
  // trimmed at the body separator, any newline, or the 5xx-retry suffix.
  const rest = text.slice(m.index! + m[0].length).replace(/^:\s*/, '');
  const end = [rest.indexOf('—'), rest.indexOf('{'), rest.indexOf('\n')]
    .filter(i => i >= 0)
    .reduce((min, i) => Math.min(min, i), rest.length);
  const statusText = rest.slice(0, end).trim().replace(/ from server$/, '');
  return { code, message: statusText || undefined };
}

/**
 * Extract the human-readable message(s) from an OpenAI-compatible
 * `{"error":{"message":"…"}}` body. OpenRouter buries the real provider reason
 * under `error.metadata.raw` while `error.message` is a terse stub ("Provider
 * returned error") — so every message-like field is gathered and joined, instead
 * of dead-ending on the stub. Full JSON parse first (correct escaping); a
 * tolerant regex recovers `message` + `raw` even when the body was truncated
 * (fetchWithRetry caps the body length embedded in the error).
 */
function extractServerErrorMessage(text: string): string | undefined {
  const brace = text.indexOf('{');
  if (brace >= 0) {
    try {
      const parsed = JSON.parse(text.slice(brace)) as { error?: unknown };
      const messages = collectErrorMessages(parsed.error);
      if (messages.length > 0) return messages.join(' — ');
    } catch {
      // Truncated or non-JSON — fall through to the tolerant regex.
    }
  }
  const parts: string[] = [];
  const msgMatch = text.match(/"message"\s*:\s*"((?:[^"\\]|\\.)*)/);
  if (msgMatch && msgMatch[1] && msgMatch[1].trim()) parts.push(msgMatch[1]);
  const rawMatch = text.match(/"raw"\s*:\s*"((?:[^"\\]|\\.)*)/);
  if (rawMatch && rawMatch[1] && rawMatch[1].trim()) parts.push(rawMatch[1]);
  return parts.length > 0 ? [...new Set(parts)].join(' — ') : undefined;
}

/**
 * Format an error for user-facing display. Maps common network/server failures
 * to actionable messages.
 * Handles both Error objects and plain string throws (fetch abort returns a string!).
 */
export function formatError(err: unknown): string {
  // Node.js fetch() throws a plain string when aborted — the string IS the reason.
  if (typeof err === 'string') {
    return _classifyMessage(err);
  }
  if (!(err instanceof Error)) return 'Unknown error occurred.';

  const name = err.name ?? '';
  const msg = err.message ?? '';
  // Collect the full cause chain once — reuse for both classification and combined checks.
  const allCauses = [...iterateCauses(err)].map(c =>
    c instanceof Error ? `${c.name} ${c.message}` : String(c)
  );

  // Check each cause message individually against known patterns.
  for (const cause of allCauses) {
    const classified = _classifyMessage(cause);
    if (classified !== cause) return classified;
  }

  // Check combined message + full cause chain for transport failures.
  // Build a single string so deeply-nested errors (e.g. error.cause.cause.message = 'ECONNREFUSED')
  // are still matched.
  const combined = `${name} ${msg} ${allCauses.join(' ')}`;

  // Server-reported HTTP rejection — the single, honest surface for any non-OK
  // response (401/402/403/429/5xx/…): state the HTTP code and the server's own
  // message (JSON `error.message`, else the status text). No per-status guessing —
  // the server's real words beat a generic template, and matching the status
  // marker (`HTTP \d{3}`) can't misread a "50000" in the body as an HTTP 500.
  for (const text of [msg, ...allCauses]) {
    const serverErr = extractServerErrorInfo(text);
    if (serverErr) {
      return `Server error [${serverErr.code}]${serverErr.message ? `. ${serverErr.message}` : '.'}`;
    }
  }

  // Transport-level failures — the server never answered, so there is no HTTP
  // status: connectivity, context limits, stream truncation, unexpected closes.
  if (combined.includes('ECONNREFUSED') || combined.includes('fetch failed') || combined.includes('ENOTFOUND')) {
    return `Cannot connect to the server. Make sure it's running and the URL is correct (${msg}).`;
  }
  if (combined.includes('context length') || combined.includes('max_model_len') || combined.includes('maximum context')) {
    return `Context window exceeded. The conversation is too long for the model. Use /compact or start a new chat.`;
  }
  if (combined.includes('closed prematurely') || combined.includes('Premature close') || combined.includes('ERR_STREAM_PREMATURE_CLOSE')) {
    return `The connection was closed prematurely by the network or a reverse proxy. This happens when a proxy (Cloudflare, nginx, corporate gateway) drops the connection mid-stream, or when the network drops while the model is still generating. Try again — if it persists, check whether a proxy timeout is too short for this model's response time.`;
  }
  if (combined.includes('other side closed') || combined.includes('ECONNRESET') || combined.includes('socket hang up') || combined.includes('SocketError')) {
    return `The server closed the connection unexpectedly. This can happen if the server is under heavy load or a reverse proxy (e.g. Cloudflare) timed out the idle connection.`;
  }

  // Try primary message
  const classified = _classifyMessage(msg);
  if (classified !== msg) return classified;

  // Generic abort/terminated
  if (name === 'AbortError' || msg === 'terminated') {
    // Try the cause chain as a fallback (our detailed abort reasons land there after signal chaining)
    for (const cause of iterateCauses(err)) {
      const causeMsg = cause instanceof Error ? cause.message : String(cause);
      const fromCause = _classifyMessage(causeMsg);
      if (fromCause !== causeMsg) return fromCause;
    }
    return `Request was aborted. See Output for details.`;
  }
  return `Error: ${msg}`;
}

/**
 * Short suggestion for anything that looks like a certificate issue: propose the
 * network diagnostic, and only mention VS Code's `http.systemCertificatesNode`
 * setting as a conditional step — it changes which trust store Node loads, so it
 * only helps when the certificate is actually valid and already trusted by the
 * OS store (it cannot repair an expired certificate). No technical essay.
 */
export const TLS_CERT_SUGGESTION =
  `This may be a certificate issue — the server's certificate could be expired, self-signed, or trusted differently by your OS than by VS Code. Run "Diagnose Connection" to confirm. If the certificate is valid and trusted by your OS, you can also try setting "http.systemCertificatesNode": true in your user settings and reload the window (Developer: Reload Window).`;

/** Error fragments that indicate a TLS certificate verification failure. */
const TLS_ERROR_PATTERNS = [
  // OpenSSL / undici error codes (uppercase)
  'UNABLE_TO_GET_ISSUER_CERT',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'SELF_SIGNED_CERT',
  'CERT_HAS_EXPIRED',
  'CERTIFICATE_VERIFY_FAILED',
  'ERR_CERT',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  // Common human-readable undici/Node messages (lowercase)
  'unable to verify the first certificate',
  'unable to get local issuer certificate',
  'self-signed certificate',
  'self signed certificate',
  'certificate has expired',
];

/** True when an error message indicates a TLS certificate verification failure. */
export function isTlsCertificateError(msg: string): boolean {
  return TLS_ERROR_PATTERNS.some((p) => msg.includes(p));
}

/**
 * Classify a single error message against known patterns.
 * Returns an actionable user message if matched, or the original message if not.
 */
function _classifyMessage(msg: string): string {
  if (msg.includes('Stream inactivity timeout')) {
    return `Stream timed out due to inactivity. The server stopped sending data. Increase streamInactivityTimeout setting or check server health. See Output for details.`;
  }
  if (msg.includes('Initial request timed out')) {
    // The abort string carries the ACTUAL configured value (e.g. "after 600000ms").
    const m = msg.match(/after (\d+)ms/);
    return `The server did not respond within ${m ? `${m[1]}ms` : 'the configured timeout'} — the model may still be loading or the server busy/queued. To allow more time, set the per-model "initialResponseTimeoutMs" setting in vllm-copilot.models to a higher value (milliseconds; 0 = wait indefinitely). See Output for details.`;
  }
  if (msg === 'User cancelled' || msg === 'Request cancelled by user') {
    return `Request was cancelled.`;
  }
  // Certificate-ish error — one bucket, one short suggestion (network test +
  // maybe the setting). No deeper classification; simplicity over cleverness.
  if (isTlsCertificateError(msg)) {
    return `TLS certificate verification failed. ${TLS_CERT_SUGGESTION}`;
  }
  // Proxy authentication errors
  if (msg.includes('407') || msg.includes('Proxy Auth') || msg.includes('PROXY_AUTH_REQUIRED')) {
    return `Proxy authentication failed. Your corporate proxy requires authentication. Check VS Code's http.proxy setting and ensure proxy credentials are configured.`;
  }
  // Mid-stream server error (no HTTP status — the request already streamed a 200
  // before the server aborted, e.g. a credit/moderation/overload rejection).
  // Surface the server's own text the same way as the pre-stream Server error
  // [code] path, for any backend, not just OpenRouter/402. Not anchored to the
  // string start — cause-chain entries are formatted as "<Name> <message>".
  const midStream = msg.match(/Server error \(mid-stream\): ([\s\S]*)$/);
  if (midStream) {
    return `Server error (mid-stream). ${midStream[1]}`;
  }
  return msg; // not matched
}

// ---- Image helpers ----

export function isImagePart(part: unknown): part is vscode.LanguageModelDataPart {
  return part instanceof vscode.LanguageModelDataPart && part.mimeType?.startsWith('image/');
}

export function imagePartToDataUri(part: vscode.LanguageModelDataPart): string {
  const base64 = Buffer.from(part.data).toString('base64');
  return `data:${part.mimeType};base64,${base64}`;
}
