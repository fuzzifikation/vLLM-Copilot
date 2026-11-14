/**
 * Types for `shared/overlay.mjs`, the single source of truth for the dsh
 * overlay. The module is plain ESM JavaScript so the CLI rails can run it with
 * no build step; the extension loads it at runtime by absolute path (dynamic
 * import off `context.extensionPath`) rather than by static specifier, which
 * keeps the compiled layout free of cross-directory relative imports.
 */

export interface OverlayInput {
  /** Route provider id. Defaults to the bridge's `vllmc`. */
  provider?: string
  /** Snapshot model id to aim the harness agent at. Required. */
  model: string
}

export interface OverlayResult {
  /** Full overlay text, ending in a newline. */
  yml: string
  /** Privacy rows found in the composition and disabled. */
  disabled: number
  /** Known privacy rows absent from this composition (headless lacks some). */
  skipped: string[]
  provider: string
  model: string
}

export declare const PRIVACY_ROWS: readonly string[]
export declare const DEFAULT_MODEL_ROW: string
export declare function rowIds(dumpText: string): Set<string>
export declare function rowConfigLines(dumpText: string, rowId: string): string[]
export declare function buildOverlay(dumpText: string, input: OverlayInput): OverlayResult
