import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

/**
 * File-based logger for vLLM-Copilot.
 * Writes all request/response traffic to a log file in the extension's storage path.
 * Enabled via `vllm-copilot.enableFileLogging` setting.
 */
export class FileLogger implements vscode.Disposable {
  private logStream: fs.WriteStream | null = null;
  private logFilePath: string | null = null;
  /** In-flight close promise, so repeated close() calls share one flush. */
  private closingPromise: Promise<void> | null = null;
  /** Max body size per log line. 0 = no limit. Configurable via `vllm-copilot.logBodyLimit`. */
  private logBodyLimit: number = 4000;

  constructor(
    private context: vscode.ExtensionContext,
    private output?: vscode.OutputChannel,
  ) {}

  /**
   * Initialize the logger. Creates the log file and opens the write stream.
   * Call this once during extension activation.
   */
  init(): void {
    // Close any existing stream (fire-and-forget — the old stream's flush is
    // independent of the new one). Reset closingPromise so a subsequent close()
    // targets the new stream, not the already-closing old one.
    void this.close();
    this.closingPromise = null;

    // Read configurable body limit (0 = no truncation)
    const configLimit = vscode.workspace.getConfiguration('vllm-copilot').get<number>('logBodyLimit');
    this.logBodyLimit = typeof configLimit === 'number' ? configLimit : 4000;

    const logDir = this.context.globalStorageUri?.fsPath || this.context.extensionPath;
    // Use a full timestamp (with millis) so long-running sessions don't keep appending
    // to a stale day file, and parallel tests don't collide on the same path.
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 23);
    const logFileName = `vllm-copilot-${stamp}.log`;
    this.logFilePath = path.join(logDir, logFileName);

    try {
      fs.mkdirSync(logDir, { recursive: true });
      // Open the fd synchronously so the file definitely exists before init() returns
      // (createWriteStream opens async, which races with cleanup in tests / rapid shutdown).
      const fd = fs.openSync(this.logFilePath, 'a');
      this.logStream = fs.createWriteStream(this.logFilePath, { fd, flags: 'a' });
      // Catch write errors (disk full, permission change) so they don't crash the extension.
      // Capture the stream in the closure so rapid init/close/init doesn't destroy the wrong stream.
      const ws = this.logStream;
      ws.on('error', (err) => {
        if (this.logStream === ws) this.logStream = null;
        ws.destroy();
        this.output?.appendLine(`[ERROR] File logging stopped due to write error: ${err instanceof Error ? err.message : String(err)}`);
      });
      this.logStream.write(`\n=== vLLM-Copilot log started ${new Date().toISOString()} ===\n`);
      this.output?.appendLine(`[INFO] File logging enabled → ${this.logFilePath}`);
    } catch (err) {
      this.logStream = null;
      this.logFilePath = null;
      const reason = err instanceof Error ? err.message : String(err);
      this.output?.appendLine(`[ERROR] File logging FAILED to initialize: ${reason}`);
    }
  }

  /**
   * Check if file logging is active (stream is open).
   */
  isActive(): boolean {
    return this.logStream !== null;
  }

  /**
   * Get the current log file path (for "Open Log File" command).
   */
  getLogFilePath(): string | null {
    return this.logFilePath;
  }

  /**
   * Log a request to the vLLM server.
   * Writes: method, URL, headers, and body — everything, including API keys and auth headers.
   * This is an expert-level debug tool: no redaction, no guarding.
   * @param method - HTTP method (GET, POST, etc.)
   * @param url - Full request URL
   * @param headers - Request headers (logged as-is)
   * @param body - Request body (logged as-is)
   */
  logRequest(method: string, url: string, headers?: Record<string, string>, body?: any): void {
    if (!this.logStream) return;

    const ts = new Date().toISOString().slice(11, 23);
    const lines: string[] = [`${ts}] REQ ${method} ${url}`];

    if (headers) {
      lines.push(`  HEADERS: ${JSON.stringify(headers)}`);
    }

    if (body) {
      const bodyStr = JSON.stringify(body);
      lines.push(`  BODY: ${truncate(bodyStr, this.logBodyLimit)}`);
    }

    this.logStream.write(`[${lines.join('\n')}\n`);
  }

  /**
   * Log a response from the vLLM server.
   * Writes: status, URL, headers, and body — everything as-is.
   * This is an expert-level debug tool: no redaction, no guarding.
   * @param status - HTTP status code
   * @param url - Request URL
   * @param headers - Response headers (logged as-is)
   * @param data - Response body (logged as-is)
   */
  logResponse(status: number, url: string, headers?: Record<string, string>, data?: any): void {
    if (!this.logStream) return;

    const ts = new Date().toISOString().slice(11, 23);
    const lines: string[] = [`${ts}] RES ${status} ${url}`];

    if (headers) {
      lines.push(`  HEADERS: ${JSON.stringify(headers)}`);
    }

    if (data) {
      const dataStr = JSON.stringify(data);
      lines.push(`  BODY: ${truncate(dataStr, this.logBodyLimit)}`);
    }

    this.logStream.write(`[${lines.join('\n')}\n`);
  }

  /**
   * Log a failed request (error response or network failure).
   * Captures HTTP error responses and network errors that never reach
   * the happy-path logResponse call.
   * @param method - HTTP method (GET, POST, etc.)
   * @param url - Full request URL
   * @param status - HTTP status code (0 if no HTTP response was received)
   * @param errorText - Error message or response body
   */
  logError(method: string, url: string, status: number, errorText: string): void {
    if (!this.logStream) return;

    const ts = new Date().toISOString().slice(11, 23);
    const statusStr = status > 0 ? ` ${status}` : ' (no response)';
    const lines: string[] = [
      `${ts}] ERR ${method}${statusStr} ${url}`,
      `  ERROR: ${truncate(errorText, this.logBodyLimit)}`,
    ];
    this.logStream.write(`[${lines.join('\n')}\n`);
  }

  /**
   * Log a streaming chunk (for chat completions).
   */
  logStreamChunk(chunkId: number, content: string, toolCalls?: any[], reasoningContent?: string): void {
    if (!this.logStream) return;

    const ts = new Date().toISOString().slice(11, 23);
    let line = `[${ts}] SSE #${chunkId}`;

    if (reasoningContent) {
      line += ` THINKING: "${escape(reasoningContent)}"`;
    }
    if (content) {
      line += ` TEXT: "${escape(content)}"`;
    }
    if (toolCalls && toolCalls.length > 0) {
      line += ` TOOLS: ${JSON.stringify(toolCalls)}`;
    }

    this.logStream.write(line + '\n');
  }

  /**
   * Log a streaming finish event.
   */
  logStreamFinish(finishReason: string, usage?: any): void {
    if (!this.logStream) return;

    const ts = new Date().toISOString().slice(11, 23);
    let line = `[${ts}] END reason=${finishReason}`;

    if (usage) {
      line += ` usage=${JSON.stringify(usage)}`;
    }

    this.logStream.write(line + '\n');
  }

  /**
   * Delete all vLLM-Copilot log files in the storage directory.
   * Skips the currently active log file if logging is enabled.
   * Returns the number of files deleted.
   */
  async clearLogFiles(): Promise<number> {
    const logDir = this.context.globalStorageUri?.fsPath;
    if (!logDir) return 0;

    const activePath = this.logFilePath;
    let deleted = 0;

    try {
      const entries = fs.readdirSync(logDir);
      for (const entry of entries) {
        if (/^vllm-copilot-.*\.log$/.test(entry)) {
          const fullPath = path.join(logDir, entry);
          // Skip the currently active log file
          if (activePath && fullPath === activePath) continue;
          try {
            fs.unlinkSync(fullPath);
            deleted++;
          } catch {
            // Best-effort: skip files that can't be deleted
          }
        }
      }
    } catch {
      // If we can't read the directory, silently return 0
    }

    return deleted;
  }

  /**
   * Dispose the logger — closes the log stream.
   * Required by vscode.Disposable interface. Call during deactivation.
   *
   * Delegates to {@link close} but does not await it (VS Code's Disposable
   * contract is synchronous). `deactivate()` calls `await close()` separately
   * to guarantee the flush; `close()` is idempotent so the double call is safe.
   */
  dispose(): void {
    void this.close();
  }

  /**
   * Close the log stream. Call during deactivation.
   * Returns a promise that resolves once the stream has been fully flushed.
   *
   * Idempotent: if a close is already in flight (e.g. `dispose()` ran first),
   * returns the same promise so `await close()` in `deactivate()` still waits
   * for the flush instead of resolving immediately on a nulled `logStream`.
   */
  close(): Promise<void> {
    // If a close is already in flight, await it — don't return a resolved promise
    // that would skip the flush.
    if (this.closingPromise) return this.closingPromise;

    const stream = this.logStream;
    this.logStream = null;
    if (!stream) return Promise.resolve();

    this.closingPromise = new Promise<void>((resolve) => {
      try {
        // Safety net: if the stream errors during end() flush, resolve immediately
        // so deactivate() doesn't hang indefinitely (VS Code has a ~10s timeout).
        const timeout = setTimeout(resolve, 3000);
        stream.once('error', () => {
          clearTimeout(timeout);
          resolve();
        });
        stream.end(() => {
          clearTimeout(timeout);
          resolve();
        });
      } catch {
        resolve();
      }
    });
    return this.closingPromise;
  }
}

// ---- Utility functions ----

function truncate(str: string, maxLen: number): string {
  if (maxLen <= 0 || str.length <= maxLen) return str;
  return str.slice(0, maxLen) + `... [truncated, ${str.length - maxLen} more chars]`;
}

function escape(str: string): string {
  return str
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t');
}
