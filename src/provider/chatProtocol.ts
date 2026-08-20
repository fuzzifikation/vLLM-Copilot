import type { ServerType } from '../config.js';
import type { OpenAIChatMessage, VllmChatOptions } from '../types.js';

const PROTECTED_BODY_KEYS = new Set(['model', 'messages', 'stream', 'stream_options']);

export function buildChatBody(
  model: string,
  messages: OpenAIChatMessage[],
  options: VllmChatOptions,
  serverType: ServerType,
  onOllamaToolChoiceRemoved: () => void,
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model,
    messages,
    stream: true,
    stream_options: { include_usage: true },
  };
  for (const [key, value] of Object.entries(options)) {
    if (value !== undefined && !PROTECTED_BODY_KEYS.has(key)) body[key] = value;
  }
  if (serverType !== 'vllm') {
    delete body.continue_final_message;
    delete body.add_generation_prompt;
  }
  if (serverType === 'ollama' && 'tool_choice' in body) {
    delete body.tool_choice;
    onOllamaToolChoiceRemoved();
  }
  return body;
}

export function validateMessages(messages: unknown): void {
  if (!Array.isArray(messages)) {
    throw new Error(`Invalid messages in request body: expected array, got ${typeof messages}`);
  }
  let seenNonSystem = false;
  for (const [index, message] of messages.entries()) {
    if (typeof message !== 'object' || message === null || typeof (message as any).role !== 'string') {
      throw new Error(`Invalid message at index ${index}: ${JSON.stringify(message).slice(0, 200)}`);
    }
    const role = (message as any).role as string;
    if (role === 'system') {
      if (seenNonSystem) {
        throw new Error(
          `Message ordering violation: system message at index ${index} appears after user/assistant/tool messages. ` +
          `All system messages must come first. Roles so far: ${(messages as any[]).slice(0, index + 1).map((entry: any) => entry.role).join(', ')}`
        );
      }
    } else {
      seenNonSystem = true;
    }
  }
}

export async function checkResponseContentType(response: Response): Promise<void> {
  const contentType = response.headers.get('content-type') || '';
  if (contentType.includes('application/json')) {
    const cloned = response.clone();
    const data: any = await cloned.json().catch(() => null);
    if (data?.error) {
      const message = typeof data.error === 'object' && data.error !== null
        ? data.error.message || JSON.stringify(data.error).slice(0, 500)
        : String(data.error);
      throw new Error(`Server error (mid-stream): ${message}`);
    }
    throw new Error(`Server returned unexpected JSON response (expected SSE stream)`);
  }
  if (contentType.includes('text/html')) {
    const html = await response.text().catch(() => '');
    throw new Error(`Server returned HTML instead of SSE stream (possible reverse proxy error). Body: ${html.substring(0, 500)}`);
  }
}