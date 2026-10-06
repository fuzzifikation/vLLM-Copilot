/**
 * Public entry of the editor-free core package.
 *
 * This is the contract an adapter codes against: the Copilot provider today,
 * a harness gateway tomorrow, and any standalone Node consumer that wants
 * model discovery, request assembly/execution, personalities and accounting
 * without an editor. Exported here: operations and types an adapter needs —
 * internal helpers stay module-internal on purpose.
 *
 * Everything reachable from this file is plain Node ESM: no `vscode`, no
 * settings reads, no host paths. Host inputs (URLs, headers, registries,
 * directories, storage paths, log sinks) are arguments. The executable JS is
 * the extension's own compiled `out/core` tree — one source build, no copies.
 *
 * THIS EXPORT LIST IS THE PUBLIC API of the core package, same discipline as
 * any published one: adding, renaming or re-typing an export is a contract
 * change for staged consumers (the dsh bridge pins the extension version in
 * its staging stamps), so it must ride an extension version bump — the
 * bridge's `bridge:check` rail then catches it at pin time instead of the
 * user catching it at harness boot. The compiled `out/core` ships its `.d.ts`
 * tree beside the JS, so consumers compile against these declarations
 * instead of duck-typing guesses.
 */

// ─── Wire vocabulary ─────────────────────────────────────────────────────
export type {
  FinalizedToolCall,
  OpenAIChatMessage,
  OpenAIContentPart,
  OpenAIToolCall,
  RuntimeModelLimits,
  StreamEvent,
  VllmChatOptions,
  VllmModel,
  WireChunk,
  WireChoice,
  WireDelta,
  WireMetrics,
  WireToolCallDelta,
  WireUsage,
} from './types.js';

// ─── Configuration policy and server registry ────────────────────────────
export type { ModelConfig, VllmConfig } from './config/config.js';
export {
  buildDisplayKeys,
  DEFAULT_MODEL_SETTINGS,
  findModelConfig,
  normalizeModelEntry,
  resolveConfigId,
  resolveMaxTokensForRequest,
  resolveModelSettings,
  resolveOverrideForModel,
  resolveRequestParams,
  resolveServerConfig,
  resolveServerType,
  resolveVllmModelId,
  validateConfig,
} from './config/config.js';
export type { ServerType } from './config/serverCore.js';
export { KNOWN_SERVER_TYPES, isOpenRouterUrl, normalizeServerUrl, sanitizeRequestHeaders } from './config/serverCore.js';
export type { EffectiveServer, ServerEntry } from './config/serverRegistry.js';
export { resolveServer } from './config/serverRegistry.js';
export type { OutputBudgetValue } from './shared/tokenBudget.js';
export { buildOutputLengthLadder, deriveTokenBudget, isValidContextWindow, resolveOutputLengthVector } from './shared/tokenBudget.js';

// ─── Catalog: discovery facts and neutral descriptors ────────────────────
export type { DescribeModelInput, ModelDescriptor, ModelLimitsResolver } from './catalog/describe.js';
export { describeModel, describeModels } from './catalog/describe.js';
// The served-model VERDICT (served / absent / unknown) — the answer only; each
// consumer keeps its own reaction (see the module header).
export type { ModelServedState, ModelServedVerdict } from './catalog/served.js';
export { resolveServedModels } from './catalog/served.js';
export type { ServerModelEntry } from './backends/runtimeLimits.js';
export {
  MissingContextWindowError,
  ServerProbeError,
  clearRuntimeLimitsCache,
  detectServerType,
  listServerModels,
  resolveRuntimeLimits,
} from './backends/runtimeLimits.js';

// ─── OpenRouter specifics an adapter meets as a server kind ──────────────
export type { OpenRouterModelEndpoint, OpenRouterModelInfo } from './backends/openRouter.js';
export {
  OpenRouterModelNotFoundError,
  PermanentContextError,
  getOpenRouterModelEndpointsCached,
  normalizeOpenRouterFromCatalog,
} from './backends/openRouter.js';

// ─── Request pipeline: assembly, transport, SSE, execution ───────────────
export type { AssembleRequestInput, BuildRequestResult, RequestTool, ServerConfig } from './request/assemble.js';
export { assembleRequest } from './request/assemble.js';
export { ChatTransport } from './request/chatTransport.js';
export type { PendingToolCall } from './request/sseParser.js';
export { finalizePendingToolCalls, parseToolCallArgs, processSSEChunk } from './request/sseParser.js';
export { readSseStream } from './request/streamReader.js';
export type {
  AttemptCompletionEvent,
  ExecutionEvent,
  ExecutionInput,
  ExecutionState,
  ExecutionTransport,
  StreamOutcome,
} from './request/execute.js';
export {
  createExecutionState,
  createOutcome,
  executeChatRequest,
  isAttemptCompletionEvent,
  resetOutcome,
  sanitizeUsage,
} from './request/execute.js';

// ─── Logging and error vocabulary (structural, host-free) ────────────────
export type { RequestLog, RequestTrace } from './shared/trace.js';
export { describeError, iterateCauses, isTransportFailureText } from './shared/errors.js';

// ─── Personalities: prompt rules, resolution, capture ────────────────────
export type { ApplyResult, PersonalityMeta, PromptReplacement } from './personality/promptReplacer.js';
export { applyPromptReplacements, clearPersonalityCache, loadPromptReplacements } from './personality/promptReplacer.js';
export type { PersonalityDirs, PersonalityEntry, ResolvedReplacements, ResolveReplacementsOptions } from './personality/store.js';
export { discoverPersonalities, resolveModelReplacements, syncBundledPersonalities } from './personality/store.js';
export type { CaptureEntry } from './personality/capture.js';
export { CaptureQueue, isCaptureEntry } from './personality/capture.js';

// ─── Accounting: ledger, records, money ──────────────────────────────────
export type {
  PersistedUsage,
  ServerCost,
  ServerUsage,
  UsageCostMap,
  UsageCounts,
  UsageLedgerHost,
  UsageServerMap,
} from './usage/ledger.js';
export { UsageLedger, emptyCounts, findModelCost, mergePersisted, parsePersisted } from './usage/ledger.js';
export type { LastRequestData } from './usage/record.js';
// The external-usage handoff plan (dedupe, reset barriers, accountability) —
// pure decisions; the host owns files and the live ledger.
export type {
  ExternalIngestPlan,
  ExternalRequestOutcome,
  ExternalRequestRecord,
  ExternalUsageState,
} from './usage/ingest.js';
export { ingestExternalUsage } from './usage/ingest.js';
export type { CostRates } from './usage/money.js';
export { formatCost, formatCostFine, formatCostRate, formatCostSummary } from './usage/money.js';
