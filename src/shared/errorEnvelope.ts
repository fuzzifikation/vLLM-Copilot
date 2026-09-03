/**
 * Pure helpers for extracting human-readable messages from OpenAI-compatible
 * error envelopes. No dependencies — unit-testable in isolation.
 *
 * OpenRouter commonly sends a terse `error.message` ("Provider returned error")
 * with the real provider reason nested under `error.metadata.raw`; other
 * backends bury detail in `message`/`detail`/`reason` fields arbitrarily deep.
 * These helpers gather every message-like field so callers surface the real
 * reason instead of the stub.
 */

/**
 * Gather every plausible human-readable message from an OpenAI-compatible error
 * envelope. The top-level `error.message` is canonical and kept first;
 * OpenRouter nests the real provider reason under `error.metadata.raw`, and
 * other backends bury detail in `message`/`detail`/`reason` fields arbitrarily
 * deep. String-form envelopes (`{"error":"…"}`) are handled too. Result is
 * deduped with order preserved.
 */
export function collectErrorMessages(error: unknown): string[] {
  const out: string[] = [];
  if (typeof error === 'string') {
    if (error.trim()) out.push(error.trim());
    return out;
  }
  if (error === null || typeof error !== 'object') return out;

  const obj = error as Record<string, unknown>;
  if (typeof obj.message === 'string' && obj.message.trim()) {
    out.push(obj.message.trim());
  }

  const walk = (value: unknown): void => {
    if (value === null || typeof value !== 'object') return;
    if (Array.isArray(value)) {
      for (const item of value) walk(item);
      return;
    }
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (typeof child === 'string' && /^(message|raw|detail|reason|error|description|code_reason)$/i.test(key)) {
        if (child.trim()) out.push(child.trim());
      } else if (child !== null && typeof child === 'object') {
        walk(child);
      }
    }
  };
  walk(obj);
  return [...new Set(out)];
}

/**
 * Best single human-readable message for an error envelope, or undefined when
 * none can be found. Joins {@link collectErrorMessages} with " - ".
 */
export function serverErrorMessage(error: unknown): string | undefined {
  const messages = collectErrorMessages(error);
  return messages.length > 0 ? messages.join(' - ') : undefined;
}
