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

  // Check combined message + full cause chain for network errors.
  // Build a single string so deeply-nested errors (e.g. error.cause.cause.message = 'ECONNREFUSED')
  // are still matched.
  const combined = `${name} ${msg} ${allCauses.join(' ')}`;
  if (combined.includes('ECONNREFUSED') || combined.includes('fetch failed') || combined.includes('ENOTFOUND')) {
    return `Cannot connect to vLLM server. Make sure it's running and the URL is correct (${msg}).`;
  }
  if (combined.includes('401')) {
    return `Authentication failed. Check your API key configuration (${msg}).`;
  }
  if (combined.includes('403')) {
    return `Permission denied. Your API key is valid but lacks access to this model or endpoint. Check server permissions (${msg}).`;
  }
  if (combined.includes('400')) {
    return `The request was rejected by the server. See Output for details (${msg}).`;
  }
  if (combined.includes('429')) {
    return `Rate limited. The server is overloaded. Try again in a moment (${msg}).`;
  }
  if (combined.includes('context length') || combined.includes('max_model_len') || combined.includes('maximum context')) {
    return `Context window exceeded. The conversation is too long for the model. Please use /compact or start a new chat.`;
  }
  if (combined.includes('closed prematurely') || combined.includes('Premature close') || combined.includes('ERR_STREAM_PREMATURE_CLOSE')) {
    return `The connection was closed prematurely by the network or a reverse proxy. This happens when a proxy (Cloudflare, nginx, corporate gateway) drops the connection mid-stream, or when the network drops while the model is still generating. Try again — if it persists, check whether a proxy timeout is too short for this model's response time.`;
  }
  if (combined.includes('other side closed') || combined.includes('ECONNRESET') || combined.includes('socket hang up') || combined.includes('SocketError')) {
    return `The server closed the connection unexpectedly. This can happen if the server is under heavy load or a reverse proxy (e.g. Cloudflare) timed out the idle connection. If you're behind Cloudflare, Gateway Timeout (524) fires after ~100s of no data. Wait a moment and try again.`;
  }
  if (combined.includes('524') || combined.includes('504') || combined.includes('Gateway Timeout')) {
    return `Reverse proxy timeout: the connection was idle for too long and was terminated by the proxy/tunnel in front of the server. ` +
      `Common codes: 524 (Cloudflare), 504 (nginx, HAProxy, ALB). This happens when a model takes longer than the proxy timeout (typically ~100s) to start responding. ` +
      `Try a smaller prompt, a faster model, or reduce the conversation length.`;
  }
  if (combined.includes('500') || combined.includes('502') || combined.includes('503')) {
    return `Server error. The vLLM server encountered a problem. Wait a moment and try again.`;
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
 * Classify a single error message against known patterns.
 * Returns an actionable user message if matched, or the original message if not.
 */
function _classifyMessage(msg: string): string {
  if (msg.includes('Stream inactivity timeout')) {
    return `Stream timed out due to inactivity. The server stopped sending data. Increase streamInactivityTimeout setting or check server health. See Output for details.`;
  }
  if (msg === 'User cancelled' || msg === 'Request cancelled by user') {
    return `Request was cancelled.`;
  }
  // TLS certificate errors (corporate MITM proxies, self-signed certs)
  if (
    msg.includes('UNABLE_TO_GET_ISSUER_CERT') ||
    msg.includes('SELF_SIGNED_CERT') ||
    msg.includes('CERT_HAS_EXPIRED') ||
    msg.includes('CERTIFICATE_VERIFY_FAILED') ||
    msg.includes('ERR_CERT') ||
    msg.includes('DEPTH_ZERO_SELF_SIGNED_CERT')
  ) {
    return `TLS certificate verification failed. This often happens behind a corporate proxy with MITM inspection. Check your server's certificate, or check VS Code's http.proxy and http.proxyStrictSSL settings.`;
  }
  // Proxy authentication errors
  if (msg.includes('407') || msg.includes('Proxy Auth') || msg.includes('PROXY_AUTH_REQUIRED')) {
    return `Proxy authentication failed. Your corporate proxy requires authentication. Check VS Code's http.proxy setting and ensure proxy credentials are configured.`;
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
