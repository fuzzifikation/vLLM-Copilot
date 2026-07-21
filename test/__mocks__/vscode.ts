/**
 * Minimal stub of the VS Code API for unit tests.
 * Only includes what messageConverter.ts touches (and a couple of extras for safety).
 *
 * Vitest aliases `vscode` to this file via vitest.config.ts.
 */

export class LanguageModelTextPart {
  constructor(public value: string) {}
}

export class LanguageModelThinkingPart {
  constructor(public value: string | string[]) {}
}

export class LanguageModelToolCallPart {
  constructor(public callId: string, public name: string, public input: any) {}
}

export class LanguageModelToolResultPart {
  constructor(public callId: string, public content: any) {}
}

export class LanguageModelDataPart {
  constructor(public data: Uint8Array, public mimeType: string) {}
}

export const LanguageModelChatMessageRole = {
  System: 1,
  User: 2,
  Assistant: 3,
} as const;

export const LanguageModelChatToolMode = {
  Auto: 1,
  Required: 2,
} as const;

export class RelativePattern {
  constructor(
    public base: any,
    public pattern: string,
  ) {}
}

export class EventEmitter<T> {
  private listeners: ((e: T) => void)[] = [];
  readonly event = (listener: (e: T) => void) => {
    this.listeners.push(listener);
    return { dispose: () => { this.listeners = this.listeners.filter(l => l !== listener); } };
  };
  fire(data: T): void {
    for (const l of this.listeners) l(data);
  }
  dispose(): void {
    this.listeners = [];
  }
}

// workspace stub for config tests
export const workspace = {
  getConfiguration: (_section?: string) => {
    const config = workspace._mockConfig;
    // If the test set a specific config for this section, return it.
    // Otherwise return a default config that responds to .get() with undefined.
    if (config && typeof config.get === 'function') return config;
    // Default: return an object with a .get() that returns undefined for unknown keys.
    return {
      get: (key: string) => (config && config[key] !== undefined ? config[key] : undefined),
      getSection: undefined,
      has: () => false,
      update: () => Promise.resolve(),
    };
  },
  _mockConfig: {} as any,
  workspaceFolders: undefined,
  createFileSystemWatcher: () => ({
    onDidChange: () => ({ dispose: () => {} }),
    onDidDelete: () => ({ dispose: () => {} }),
    dispose: () => {},
  }),
  onDidChangeConfiguration: () => ({ dispose: () => {} }),
} as any;

// Anything else accessed on `vscode.*` is undefined; tests should only touch the above.
