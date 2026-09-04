/**
 * Minimal stub of the VS Code API for unit tests.
 *
 * Only the surface actually used by `src/` and `test/` is typed here; runtime
 * behavior is a deliberate no-op (returns undefined, captures registrations,
 * honors the `_mockConfig` / `_mockFs*` test hooks). This is NOT a full mirror
 * of @types/vscode — when a member is missing, add it here.
 *
 * Vitest aliases `vscode` to this file (vitest.config.ts). The root tsconfig
 * (`npm run compile`) type-checks src/ against the REAL @types/vscode; this
 * mock exists so `test:typecheck` (test/tsconfig.json) can validate tests
 * against the same surface they run against at runtime.
 */

export type Thenable<T> = PromiseLike<T>;
export type Event<T> = (listener: (e: T) => any, thisArgs?: unknown, disposables?: Disposable[]) => Disposable;

// ── Enums (numeric values match the real VS Code API) ──────────────────────
export enum LanguageModelChatMessageRole { System = 1, User = 2, Assistant = 3 }
export enum LanguageModelChatToolMode { Auto = 1, Required = 2 }
export enum ExtensionKind { UI = 1, Workspace = 2 }
export enum ProgressLocation { Notification = 15 }
export enum ConfigurationTarget { Global = 1, Workspace = 2, WorkspaceFolder = 3 }
export enum QuickPickItemKind { Separator = 0, Default = 1 }
export enum FileType { File = 1, Directory = 2, SymbolicLink = 64 }

// ── Message parts ──────────────────────────────────────────────────────────
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
  constructor(public callId: string, public content: readonly unknown[]) {}
}
export class LanguageModelToolResult {
  constructor(public content: Array<unknown>) {}
}
export class CancellationError extends Error {
  constructor() { super('Cancelled'); this.name = 'Cancelled'; }
}
export class LanguageModelDataPart {
  constructor(public data: Uint8Array, public mimeType: string) {}
}

/** Wire part types a provider can emit in a response stream. */
export type LanguageModelResponsePart =
  | LanguageModelTextPart
  | LanguageModelThinkingPart
  | LanguageModelToolCallPart
  | LanguageModelToolResultPart
  | LanguageModelDataPart;

export interface LanguageModelChatMessage {
  role: LanguageModelChatMessageRole;
  content: readonly unknown[];
}
export interface LanguageModelChatRequestMessage extends LanguageModelChatMessage {
  name?: string;
}

export interface LanguageModelChatCapabilities {
  imageInput?: boolean;
  toolCalling?: boolean | number;
}
export interface LanguageModelChatInformation {
  readonly id: string;
  readonly name: string;
  readonly family: string;
  readonly version: string;
  readonly maxInputTokens: number;
  readonly maxOutputTokens: number;
  readonly capabilities: LanguageModelChatCapabilities;
}

export interface LanguageModelChatTool {
  name: string;
  description?: string;
  inputSchema?: unknown;
}
export interface LanguageModelToolInvocationOptions<T> {
  input: T;
  toolInvocationToken: unknown;
}
export interface LanguageModelTool<T> {
  invoke(options: LanguageModelToolInvocationOptions<T>, token: CancellationToken): ProviderResult<LanguageModelToolResult>;
}
export interface ProvideLanguageModelChatResponseOptions {
  tools?: readonly LanguageModelChatTool[];
  modelOptions?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface PrepareLanguageModelChatModelOptions {
  readonly silent: boolean;
}
export type ProviderResult<T> = T | undefined | null | Thenable<T | undefined | null>;

export interface LanguageModelChatProvider {
  readonly onDidChangeLanguageModelChatInformation?: Event<void>;
  provideLanguageModelChatInformation(
    options: PrepareLanguageModelChatModelOptions,
    token: CancellationToken
  ): ProviderResult<LanguageModelChatInformation[]>;
  provideLanguageModelChatResponse(
    model: LanguageModelChatInformation,
    messages: readonly LanguageModelChatRequestMessage[],
    options: ProvideLanguageModelChatResponseOptions,
    progress: Progress<LanguageModelResponsePart>,
    token: CancellationToken
  ): Thenable<void>;
  provideTokenCount(
    model: LanguageModelChatInformation,
    text: string | LanguageModelChatRequestMessage,
    token: CancellationToken
  ): Thenable<number>;
}

// ── Core interfaces ────────────────────────────────────────────────────────
export interface Disposable { dispose(): void; }
export interface CancellationToken {
  isCancellationRequested: boolean;
  onCancellationRequested: Event<any>;
}
export interface Progress<T> { report(value: T): void; }
export interface QuickPickItem {
  label: string;
  description?: string;
  detail?: string;
  kind?: QuickPickItemKind;
  picked?: boolean;
  alwaysShow?: boolean;
}
export interface QuickPick<T extends QuickPickItem = QuickPickItem> {
  value: string;
  placeholder: string | undefined;
  title: string | undefined;
  prompt: string | undefined;
  items: readonly T[];
  selectedItems: readonly T[];
  activeItems: readonly T[];
  canSelectMany: boolean;
  matchOnDescription: boolean;
  matchOnDetail: boolean;
  ignoreFocusOut: boolean;
  show(): void;
  hide(): void;
  dispose(): void;
  onDidAccept(listener: () => unknown): Disposable;
  onDidHide(listener: () => unknown): Disposable;
  onDidChangeValue(listener: (value: string) => unknown): Disposable;
}
export interface QuickPickOptions {
  canPickMany?: boolean;
  placeHolder?: string;
  matchOnDescription?: boolean;
  matchOnDetail?: boolean;
  ignoreFocusOut?: boolean;
  [key: string]: unknown;
}
export interface OutputChannel extends Disposable {
  readonly name: string;
  append(value: string): void;
  appendLine(value: string): void;
  replace(value: string): void;
  clear(): void;
  show(preserveFocus?: boolean): void;
  hide(): void;
}
export interface ConfigurationChangeEvent {
  affectsConfiguration(section: string, scope?: unknown): boolean;
  [key: string]: unknown;
}
export interface Memento {
  get<T>(key: string, defaultValue?: T): T | undefined;
  update(key: string, value: unknown): Thenable<void>;
}
export interface ExtensionContext {
  extension: { id: string; extensionUri: Uri; extensionKind: ExtensionKind; packageJSON: Record<string, unknown> };
  extensionUri: Uri;
  extensionPath: string;
  globalStorageUri: Uri;
  workspaceState: Memento;
  globalState: Memento;
  secrets: {
    get(key: string): Promise<string | undefined>;
    store(key: string, value: string): Promise<void>;
    delete(key: string): Promise<void>;
  };
  subscriptions: Disposable[];
  [key: string]: any;
}
export interface WorkspaceFolder { uri: Uri; name: string; index: number; }
export interface WorkspaceConfiguration {
  get<T>(key: string, defaultValue: T): T;
  get<T>(key: string): T | undefined;
  has(key: string): boolean;
  update(key: string, value: unknown, target?: ConfigurationTarget | boolean): Thenable<void>;
  inspect<T>(section: string): { defaultValue?: T; globalValue?: T; workspaceValue?: T; workspaceFolderValue?: T } | undefined;
}
export interface InputBoxOptions {
  title?: string;
  prompt?: string;
  placeHolder?: string;
  value?: string;
  ignoreFocusOut?: boolean;
  password?: boolean;
  validateInput?(value: string): string | undefined | Thenable<string | undefined>;
  [key: string]: unknown;
}

/**
 * Uri type + a value that keeps the historical "returns a string handle"
 * runtime. Tests drive the workspace.fs hooks with string paths, so
 * joinPath/file keep returning the last segment / path at runtime.
 */
export interface Uri {
  readonly scheme: string;
  readonly authority: string;
  readonly path: string;
  readonly query: string;
  readonly fragment: string;
  readonly fsPath: string;
  toString(): string;
}
export const Uri: {
  file(path: string): Uri;
  parse(value: string): Uri;
  joinPath(base: Uri, ...pathSegments: (string | Uri)[]): Uri;
} = {
  file: (path: string) => path as unknown as Uri,
  parse: (value: string) => value as unknown as Uri,
  joinPath: (...uris: unknown[]) => uris[uris.length - 1] as unknown as Uri,
};

// ── EventEmitter ───────────────────────────────────────────────────────────
export class EventEmitter<T> {
  private listeners: ((e: T) => any)[] = [];
  readonly event: Event<T> = (listener) => {
    this.listeners.push(listener);
    return { dispose: () => { this.listeners = this.listeners.filter(l => l !== listener); } };
  };
  fire(data: T): void { for (const l of this.listeners) l(data); }
  dispose(): void { this.listeners = []; }
}

// ── Theme / markdown classes ───────────────────────────────────────────────
// Only what test-graph modules construct: hfDiscovery builds ThemeIcons.
// The tree API (TreeItem/TreeDataProvider/ThemeColor/Command) left with CR-110 —
// its only consumer, dashboard.ts, has no tests by design.
export class ThemeIcon {
  constructor(public readonly id: string) {}
}
export class MarkdownString {
  constructor(public readonly value?: string) {}
}

// ── workspace ──────────────────────────────────────────────────────────────
export const workspace: {
  getConfiguration(section?: string, scope?: unknown): WorkspaceConfiguration;
  workspaceFolders: readonly WorkspaceFolder[] | undefined;
  fs: { readDirectory(uri: Uri): Promise<[string, FileType][]>; readFile(uri: Uri): Promise<Uint8Array>; };
  onDidChangeConfiguration(listener: (e: ConfigurationChangeEvent) => any): Disposable;
  openTextDocument(uri: Uri | string | { language?: string; content?: string }): Thenable<unknown>;
  // Test hooks (typed so tests can set them without casts).
  _mockConfig: any;
  _mockFsReadDirectory?: (uri: Uri) => Promise<[string, FileType][]>;
  _mockFsReadFile?: (uri: Uri) => Promise<Uint8Array>;
} = {
  getConfiguration: (_section?: string, _scope?: unknown) => {
    const config = workspace._mockConfig;
    // If the test set a specific config for this section, return it.
    // Otherwise return a default config that responds to .get() with undefined.
    if (config && typeof config.get === 'function') return config as WorkspaceConfiguration;
    // Default: return an object with a .get() that returns undefined for unknown keys.
    return {
      get: <T>(key: string, defaultValue?: T) => (config && config[key] !== undefined ? config[key] : defaultValue),
      has: () => false,
      update: () => Promise.resolve(),
      inspect: () => undefined,
    } as WorkspaceConfiguration;
  },
  _mockConfig: {} as any,
  workspaceFolders: undefined,
  fs: {
    readDirectory: (uri: Uri) => {
      const hook = workspace._mockFsReadDirectory;
      return hook ? hook(uri) : Promise.resolve([]);
    },
    readFile: (uri: Uri) => {
      const hook = workspace._mockFsReadFile;
      return hook ? hook(uri) : Promise.resolve(new Uint8Array());
    },
  },
  onDidChangeConfiguration: () => ({ dispose: () => {} }),
  openTextDocument: (_uri: Uri | string | { language?: string; content?: string }) => Promise.resolve({}),
};

// ── env ────────────────────────────────────────────────────────────────────
export const env: {
  remoteName: string | undefined;
  appName: string;
  clipboard: { readText(): Promise<string>; writeText(text: string): Promise<void> };
  openExternal(target: string | Uri): Promise<boolean>;
} = {
  remoteName: undefined,
  appName: 'Code',
  clipboard: { readText: () => Promise.resolve(''), writeText: () => Promise.resolve() },
  openExternal: () => Promise.resolve(true),
};

// ── window ─────────────────────────────────────────────────────────────────
export const window: {
  showInformationMessage(message: string, ...items: (string | Record<string, unknown>)[]): Promise<string | undefined>;
  showWarningMessage(message: string, ...items: (string | Record<string, unknown>)[]): Promise<string | undefined>;
  showErrorMessage(message: string, ...items: (string | Record<string, unknown>)[]): Promise<string | undefined>;
  showInputBox(options?: InputBoxOptions, token?: CancellationToken): Promise<string | undefined>;
  showQuickPick<T extends QuickPickItem>(
    items: readonly T[] | Thenable<readonly T[]>,
    options: QuickPickOptions & { canPickMany: true },
    token?: CancellationToken
  ): Promise<T[] | undefined>;
  showQuickPick<T extends QuickPickItem>(
    items: readonly T[] | Thenable<readonly T[]>,
    options?: QuickPickOptions,
    token?: CancellationToken
  ): Promise<T | undefined>;
  createQuickPick<T extends QuickPickItem>(): QuickPick<T>;
  withProgress<R>(options: unknown, task: (progress: Progress<unknown>) => Thenable<R>): Promise<R>;
  createOutputChannel(name: string): OutputChannel;
  createWebviewPanel(viewType: string, title: string, showOptions: ViewColumn, options?: unknown): WebviewPanel;
  showTextDocument(document: unknown, ..._rest: unknown[]): Promise<unknown>;
} = {
  showInformationMessage: () => Promise.resolve(undefined),
  showWarningMessage: () => Promise.resolve(undefined),
  showErrorMessage: () => Promise.resolve(undefined),
  showInputBox: () => Promise.resolve(undefined),
  showQuickPick: ((..._args: unknown[]) => Promise.resolve(undefined)) as any,
  createQuickPick: <T extends QuickPickItem>() => {
    // Minimal QuickPick stub. `show()` resolves as cancelled (fires hide) so a
    // test that forgets to drive the picker still completes instead of hanging.
    // CRITICAL: `dispose()` fires `onDidHide` — real VS Code does this, and a
    // handler that disposes before resolving would let onDidHide's resolve
    // clobber the accept. Tests must model this so the dispose→hide race is caught.
    // Tests that need selection spy on this and override show/onDidAccept.
    let accept: (() => void) | undefined;
    let hide: (() => void) | undefined;
    const fireHide = () => { if (hide) { const h = hide; hide = undefined; h(); } };
    const qp = {
      value: '',
      placeholder: undefined,
      title: undefined,
      prompt: undefined,
      items: [] as readonly T[],
      selectedItems: [] as readonly T[],
      activeItems: [] as readonly T[],
      canSelectMany: false,
      matchOnDescription: false,
      matchOnDetail: false,
      ignoreFocusOut: false,
      show: () => { queueMicrotask(() => fireHide()); },
      hide: () => {},
      dispose: () => { fireHide(); },
      onDidAccept: (fn: () => void) => { accept = fn; return { dispose: () => {} }; },
      onDidHide: (fn: () => void) => { hide = fn; return { dispose: () => {} }; },
      onDidChangeValue: () => ({ dispose: () => {} }),
      _fireAccept: () => accept?.(),
      _fireHide: () => fireHide(),
    } as QuickPick<T> & { _fireAccept: () => void; _fireHide: () => void };
    return qp;
  },
  withProgress: <R,>(_options: unknown, task: (progress: Progress<unknown>) => Thenable<R>) =>
    Promise.resolve(task({ report: () => {} })),
  createOutputChannel: (name: string): OutputChannel => ({
    name,
    append: () => {},
    appendLine: () => {},
    replace: () => {},
    clear: () => {},
    show: () => {},
    hide: () => {},
    dispose: () => {},
  }),
  showTextDocument: () => Promise.resolve({}),
  createWebviewPanel: (viewType, title) => ({
    viewType,
    title,
    webview: {
      html: '',
      options: {},
      cspSource: '',
      onDidReceiveMessage: () => ({ dispose: () => {} }),
      postMessage: () => Promise.resolve(true),
      asWebviewUri: (uri) => uri,
    },
    onDidDispose: () => ({ dispose: () => {} }),
    reveal: () => {},
    dispose: () => {},
  }),
};

// ── commands ───────────────────────────────────────────────────────────────
export const commands: {
  executeCommand<T = unknown>(command: string, ...rest: unknown[]): Thenable<T>;
  registerCommand(command: string, callback: (...args: any[]) => any, thisArg?: unknown): Disposable;
  /** Test helper: captured registrations. */
  _registrations: { name: string; fn: (...args: any[]) => any }[];
  /** Test helper: run the callback registered under `name`. */
  _run(name: string, ...args: any[]): any;
} = {
  executeCommand: <T = unknown,>(_command: string, ..._rest: unknown[]): Thenable<T> =>
    Promise.resolve(undefined as unknown as T),
  _registrations: [],
  registerCommand: (name: string, fn: (...args: any[]) => any) => {
    commands._registrations.push({ name, fn });
    return { dispose: () => {} };
  },
  _run: (name: string, ...args: any[]) => {
    const reg = commands._registrations.find(r => r.name === name);
    if (!reg) throw new Error(`no command registered as "${name}"`);
    return reg.fn(...args);
  },
};

// ── Webview (type-only surface for serverSettingsView / deepDiveView) ──────
/** Editor column placement — the subset `deepDiveView` uses (`Beside`). */
export enum ViewColumn {
  Active = -1,
  Beside = -2,
  One = 1,
  Two = 2,
  Three = 3,
  Four = 4,
  Five = 5,
  Six = 6,
  Seven = 7,
  Eight = 8,
  Nine = 9,
}

/** Editor-area webview panel — the surface `deepDiveView` uses. */
export interface WebviewPanel {
  readonly viewType: string;
  title: string;
  webview: Webview;
  onDidDispose: Event<void>;
  reveal(column?: ViewColumn, preserveFocus?: boolean): void;
  dispose(): void;
}

export interface Webview {
  html: string;
  options: Record<string, unknown>;
  cspSource: string;
  onDidReceiveMessage: Event<any>;
  postMessage(message: unknown): Thenable<boolean>;
  asWebviewUri(uri: Uri): Uri;
}
export interface WebviewView {
  webview: Webview;
  visible: boolean;
  title?: string;
  description?: string;
  onDidChangeVisibility: Event<boolean>;
  onDidDispose: Event<void>;
  show(preserveFocus?: boolean): void;
}
export interface WebviewViewResolveContext { [key: string]: unknown; }
export interface WebviewViewProvider {
  resolveWebviewView(webviewView: WebviewView, context: WebviewViewResolveContext, token: CancellationToken): Thenable<void> | void;
}

// ── lm namespace (Language Model tools) ────────────────────────────────────
// registerTool is a no-op: configSchemaTool registers a tool at activation and
// nothing reads the registration back (the old _mockRegisteredTools capture
// described tests that do not exist — CR-110).
export const lm: {
  registerTool(name: string, tool: unknown): Disposable;
} = {
  registerTool: () => ({ dispose: () => {} }),
};

// ── Misc namespace members ─────────────────────────────────────────────────
export const version = 'test';

// Anything else accessed on `vscode.*` is undefined; tests should only touch the above.
