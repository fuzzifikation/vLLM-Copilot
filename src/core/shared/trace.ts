/**
 * The core's logging hooks — structural types only. The host's FileLogger
 * satisfies `RequestTrace` and a `vscode.OutputChannel` satisfies `RequestLog`
 * structurally; neither editor type is imported into core, not even as
 * `import type`. The core never chooses a log directory or reads logging
 * settings; it just calls the hooks it always called.
 */
import type { FinalizedToolCall } from '../types.js';

/** Minimal line-oriented log surface. `vscode.OutputChannel` satisfies this structurally. */
export interface RequestLog {
  appendLine(value: string): void;
}

/**
 * The structural trace sink covering the request/stream hooks the core
 * actually invokes. Owned by the host (file logger, telemetry, or nothing at
 * all — the parameter is optional at every call site).
 */
export interface RequestTrace {
  logRequest(method: string, url: string, headers?: Record<string, string>, body?: unknown): void;
  logStreamChunk(chunkId: number, content: string, toolCalls?: FinalizedToolCall[], reasoningContent?: string): void;
  logStreamFinish(finishReason: string, usage?: unknown): void;
  logError(method: string, url: string, status: number, errorText: string): void;
}
