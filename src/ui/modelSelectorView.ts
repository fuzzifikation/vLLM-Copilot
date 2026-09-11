/**
 * OpenRouter Model Selector — editor-area webview plotting every
 * benchmark-scored OpenRouter model *per serving provider* by REAL-USAGE cost
 * against benchmark quality.
 *
 * The differentiator over OpenRouter's own model list: the cost axis is not
 * the sticker price but what a job costs under the user's actual token mix,
 * calibrated from this extension's own usage data. Measured usage showed
 * 93.6% of prompt tokens served from cache with output at 0.83% of prompt —
 * under that mix, providers with cheap cache reads beat providers with a cheap
 * sticker input price, and a sticker-price ranking picks the wrong models.
 *
 *   p_eff = rNew·p_new + rCached·p_cache_read + rOut·p_out
 *   p_new = p_write (in place of p_in) when a write rate is published and the
 *   mix has cache activity - the input buckets are disjoint; else p_in
 *                                                        (USD per 1M prompt)
 *
 * Rates are PER PROVIDER, read from `GET /v1/models/{id}/endpoints` — the
 * catalog headline is a single provider's rate and the advertised context is
 * the max across providers (both live-verified), so a model's dot is really a
 * (model, provider) pair and pairs without enough context are dropped. A
 * provider with no cache-read price pays FULL input for the cached share (it
 * cannot serve the workload's cache hits); with cache activity the new-input
 * share pays the published cache-write rate IN PLACE OF input (disjoint
 * buckets: creation bills at 1.25x base, never base + creation). A
 * long-context tier (`pricing.overrides`, "one request above N prompt tokens
 * costs more") prices the job when the <i>pricing prompt size</i> control -
 * the user's declared typical request, independent of the min-context
 * capacity filter - sits strictly above its threshold; every applicable tier
 * contributes per price key (OpenAPI: later entries win, omitted keys keep
 * base), shown as a peak upper bound.
 * The webview re-derives every cost client-side from the raw rates on each
 * control move, so tuning the profile is instant; the extension fetches raw
 * data once per open/refresh only. The benchmarks endpoint is rate-limited
 * (500/day) and is NEVER polled; provider lists come through the shared
 * per-session cache the dashboard and Model Settings already use.
 *
 * Universe: EVERY text-output catalog model, narrowed by two capability
 * checkboxes read from the catalog payload: TOOL-CALLING (on by default —
 * `supported_parameters` ∋ `tools`; without it Copilot agent mode cannot work)
 * and IMAGE INPUT (off by default — `input_modalities` ∋ `image`; pasted
 * screenshots are a nice-to-have, defaulting it on would hide the strongest
 * pure-text coders). Both are view filters, never add gates: uncheck to see
 * the full text-output universe again.
 * Models Artificial Analysis
 * scores (via OpenRouter's `GET /v1/benchmarks`, joined on the catalog
 * `canonical_slug`) get the full treatment: per-provider endpoint rows, dots,
 * Pareto stars. Everything else still appears in the searchable list as ONE
 * row at the catalog list price (headline rates, worst window folded, same
 * tier parser) - listed and searchable, but no dot, no star, no provider
 * breakdown. Selecting a list-price row lazily fetches that one model's
 * provider endpoints through the shared cache, upgrading it to the normal
 * per-provider view with "Use" (user ruling 2026-09-11: the plot stays
 * scored-only, the list stays complete, and any listed model stays addable).
 * Auth: the OpenRouter server entry the view was OPENED from (its
 * context-menu is the only entry point — deliberately no palette command, so
 * with several OpenRouter servers/tokens the panel always knows whose key
 * fetches the data and which entry "Use this model now" adds to).
 */

import * as vscode from 'vscode';
import {
  fetchOpenRouterBenchmarks,
  fetchOpenRouterCatalog,
  getOpenRouterModelEndpointsCached,
  normalizeOpenRouterFromCatalog,
  openRouterCatalogConfigFields,
  openRouterInfoDetailLines,
  parseEndpointPricingOverrides,
  perMillion,
  worstCasePricing,
} from '../backends/openRouter.js';
import type {
  OpenRouterBenchmarkRow,
  OpenRouterModelData,
  OpenRouterModelEndpoint,
} from '../backends/openRouter.js';
import { buildModelId, isOpenRouterUrl, normalizeServerUrl, resolveConfigId, resolveVllmModelId, sanitizeRequestHeaders, type ModelConfig } from '../state/config.js';
import { readModels, readServers, type IdentifiedModelConfig } from '../state/configStore.js';
import { confirmAndSaveAddedModel, handleDuplicateModelGate } from '../commands/addServerCore.js';

/**
 * Real-usage calibration (agentic Copilot sessions, measured through this
 * extension, 2026-09). The single source of truth for the default profile:
 *   prompt 4,113,894,637 · cached 3,852,036,800 · output 33,962,390
 * New input is prompt − cached; cache writes fall inside that new share and
 * are billed at the write rate in place of input (not on top of it).
 */
const USAGE = { prompt: 4_113_894_637, cached: 3_852_036_800, output: 33_962_390 };
const R_CACHED = USAGE.cached / USAGE.prompt;
const R_OUT = USAGE.output / USAGE.prompt;

type ReadyMessage = { type: 'ready' };
type RefreshMessage = { type: 'refresh' };
type UseMessage = { type: 'use'; id: string; tag: string; provider: string; srv?: string };
type OpenMessage = { type: 'open'; url: string };
/** Lazy provider-list request for one list-price row (the webview echoes the
 *  server its visible rows were fetched for; the answer repeats it so a
 *  response racing a server switch can be discarded). */
type EndpointsRequestMessage = { type: 'endpoints'; id: string; srv?: string };
type WebviewMessage = ReadyMessage | RefreshMessage | UseMessage | OpenMessage | EndpointsRequestMessage;

/**
 * One serving provider of a model, flattened to per-1M USD rates. This is the
 * unit the cost axis is computed on — the catalog headline is one provider's
 * rate, so the panel plots (model, provider) pairs, not catalog rows.
 */
interface SelectorEndpoint {
  /** Exact provider slug (routing id) — identity for detail selection. */
  tag: string;
  provider: string;
  quant?: string;
  /** Base-tier rates, per-1M USD. `in`/`out` always defined (row kept). */
  in: number;
  out: number;
  /** undefined = no cache price → the cached share pays full input. */
  cache?: number;
  /** Published cache-write rate (billed in place of input for the new share); 0 when absent. */
  write: number;
  /** Published 1-hour-TTL cache-write rate (used when the config's policy is '1h'); undefined when not published. */
  w1h?: number;
  /** Provider's own context window — NOT the catalog max. */
  ctx?: number;
  /** 0 = operational; anything else (e.g. -2 degraded) is filtered out. */
  status?: number;
  uptime?: number;
  /** p50 time-to-first-token (ms, last 30 min) — undefined = not reported. */
  lat?: number;
  /** p50 output throughput (tok/s, last 30 min) — undefined = not reported. */
  tput?: number;
  /**
   * The endpoint prices by time-of-day windows; `in`/`out`/`cache`/`write`
   * are then the parser's WORST window per field (`pricing.worst_case`), and
   * the webview marks the price with a clock. The spec documents the windows
   * (half-open HHMM ranges, optionally weekday-scoped) - resolving "now"
   * would still bake a clock into a planning tool. Off-peak discounts
   * (live-verified tencent/hy3: -37.5% off-peak) are real - the user is
   * pointed at the provider page to exploit them, not given a fake number.
   */
  timeWorst?: true;
  /**
   * Prompt-threshold tiers from `pricing.overrides`, in ARRAY ORDER: the
   * OpenAPI spec lets every applicable entry contribute and later entries
   * win per price key, so order carries meaning and must survive the wire.
   * A tier applies when the pricing prompt size is STRICTLY above `at`
   * (spec) and reports only the fields it overrides - gaps stay undefined
   * so the webview accumulates applicable tiers per key over the time-peak
   * base. Filling gaps with the base here would let a later partial tier
   * silently discard an earlier tier's still-applicable override (external
   * review 2026-09-09). Undefined when the endpoint has no tiers.
   */
  tiers?: { at: number; in?: number; out?: number; cache?: number; write?: number; w1h?: number }[];
}

/** A catalog variant with its usable provider endpoints (scored variants get
 *  the endpoint fan-out; everything else rides on the `list` fallback). */
interface SelectorModelRow {
  /** Full catalog variant id (`author/slug[:variant]`). */
  id: string;
  /**
   * Benchmark join key: the catalog's `canonical_slug` — the stable, DATED
   * permaslug (`z-ai/glm-5.3-20260816`) that the benchmarks endpoint uses as
   * `model_permaslug`. Joining on the plain `id` instead matches only models
   * whose slug never changed, silently dropping every recent release from the
   * quality axis. Fallback: id without its `:variant` suffix.
   */
  base: string;
  endpoints: SelectorEndpoint[];
  /**
   * Catalog list price, present exactly when the fan-out produced no usable
   * provider (every non-scored model, or a scored one whose endpoints all
   * failed). The webview draws a single "list price" row from it: searchable
   * and priceable, but never plotted and without a "Use" button.
   */
  list?: SelectorListPrice;
  /** Catalog advertises tool-calling (`supported_parameters` ∋ `tools`). The
   *  tool-calling checkbox filters on this; unknown counts as false, exactly
   *  like the add-time capability read. */
  tools: boolean;
  /** Catalog advertises image input (`input_modalities` ∋ `image`). The
   *  image-input checkbox filters on this. */
  img: boolean;
}

/** Endpoint-shaped fields read from the catalog headline instead of a real
 *  provider: same worst-window fold, same sparse tier contract, but the
 *  headline is ONE provider's rate (documented caveat of this view). */
type SelectorListPrice = Pick<
  SelectorEndpoint,
  'in' | 'out' | 'cache' | 'write' | 'w1h' | 'ctx' | 'timeWorst' | 'tiers'
>;

let openPanel: { panel: vscode.WebviewPanel; refresh: () => void } | undefined;

/**
 * The registry entry the open panel was opened FROM (captured at command
 * time). Benchmarks fetch with its key and "Use this model now" adds to it —
 * with several OpenRouter servers (several tokens), this is what makes "which
 * credential, which target" a decided fact instead of a guess.
 */
let openerServerId: string | undefined;

/**
 * Register the "Model Selector" command (menu label; the panel tab keeps the
 * full "OpenRouter Model Selector"). The ONLY entry point is the dashboard's
 * OpenRouter server row: VS Code hands the tree item to the command, and its
 * `serverId` is the registry entry the view belongs to. No palette entry —
 * without a server row there is no credential to pick.
 */
export function registerOpenModelSelectorCommand(
  context: vscode.ExtensionContext,
  output: vscode.OutputChannel,
): vscode.Disposable {
  return vscode.commands.registerCommand('vllm-copilot.openModelSelector', (element?: unknown) => {
    const serverId = (element as { serverId?: unknown } | undefined)?.serverId;
    if (typeof serverId !== 'string' || !serverId) {
      void vscode.window.showInformationMessage(
        'vLLM-Copilot: the Model Selector opens from an OpenRouter server row - right-click one in the vLLM-Copilot dashboard.',
      );
      return;
    }
    openerServerId = serverId;
    if (openPanel) {
      openPanel.panel.reveal(vscode.ViewColumn.Active);
      openPanel.refresh();
      return;
    }
    openModelSelector(context, output);
  });
}

/** The registry entry the view was opened from, or undefined when it no
 *  longer exists (removed/renamed while the panel stayed open). */
function findOpenerEntry() {
  if (!openerServerId) return undefined;
  const entry = readServers().find((s) => s.id === openerServerId);
  return entry && (entry.serverType === 'openrouter' || isOpenRouterUrl(entry.serverUrl)) ? entry : undefined;
}

/**
 * Which wire ids the user already configured, sent to the webview for the
 * ✓/◇ row marks: a config on the OPENER entry marks its rows with ✓, one on a
 * DIFFERENT entry SHARING THE OPENER'S URL carries that entry's name so the
 * webview can show ◇ and explain up front why adding would hit the per-URL
 * duplicate gate. Entries on other URLs are not marked — that gate never
 * fires for them.
 * A pinned config marks only its provider row (the pin is the row's identity);
 * Auto marks every provider row of the model, because Auto is a routing
 * choice, not a provider identity.
 */
function configuredMarks(): { id: string; provider?: string; elsewhere?: string; pc?: 'on' | '1h' | 'off' }[] {
  const opener = findOpenerEntry();
  if (!opener) return [];
  // Siblings are entry-point-scoped by URL, exactly like the per-URL duplicate
  // gate: an OpenRouter entry on a DIFFERENT URL never triggers that gate, so
  // marking its models here would promise a duplicate question that never
  // comes. Same URL = the gate will fire = honest diamond.
  const servers = readServers();
  const openerUrl = normalizeServerUrl(opener.serverUrl);
  const marks: { id: string; provider?: string; elsewhere?: string; pc?: 'on' | '1h' | 'off' }[] = [];
  for (const m of readModels()) {
    const entry = servers.find((s) => s.id === m.server);
    if (!entry) continue;
    if (!(entry.serverType === 'openrouter' || isOpenRouterUrl(entry.serverUrl))) continue;
    const id = resolveVllmModelId(m);
    if (!id) continue;
    // pc rides along so the webview can price a configured row under the
    // policy the wire will actually use (cfgPolicy applies the family gate).
    const pc = m.promptCache;
    if (entry.id === opener.id) marks.push({ id, provider: m.provider, ...(pc ? { pc } : {}) });
    else if (normalizeServerUrl(entry.serverUrl) === openerUrl) {
      marks.push({ id, provider: m.provider, elsewhere: entry.displayName ?? entry.id, ...(pc ? { pc } : {}) });
    }
  }
  return marks;
}

function openModelSelector(context: vscode.ExtensionContext, output: vscode.OutputChannel): void {
  const panel = vscode.window.createWebviewPanel(
    'vllm-copilot.modelSelector',
    'OpenRouter Model Selector',
    vscode.ViewColumn.Active,
    { enableScripts: true, retainContextWhenHidden: true },
  );

  const resourcesUri = vscode.Uri.joinPath(context.extensionUri, 'resources');
  const scriptUri = panel.webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, 'resources', 'modelSelector.js'));
  const styleUri = panel.webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, 'resources', 'modelSelector.css'));
  // Shared fuzzy matcher (same function the Model Settings dropdown runs) -
  // loaded before modelSelector.js, which calls into it for the search box.
  const searchJsUri = panel.webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, 'resources', 'webview-search.js'));
  panel.webview.options = { enableScripts: true, localResourceRoots: [resourcesUri] };
  panel.webview.html = buildHtml(panel.webview, scriptUri, styleUri, searchJsUri);

  let isReady = false;
  let loading = false;
  // A re-open WHILE a fetch runs (right-click a second OpenRouter server)
  // must not be swallowed: the opener id has already moved to the new entry,
  // so dropping the refresh would leave the running entry's fetch feeding a
  // panel that marks and saves against the other one. Park the request and
  // re-run when the in-flight pass finishes.
  let pendingRefresh = false;

  /** Fetch fresh and push. One in-flight at a time (a double click while a
   *  fetch runs must not stack OpenRouter calls — the benchmarks quota is
   *  account-wide at 500/day). Benchmarks gate everything: without them
   *  there is nothing to plot and no provider fan-out, so the whole refresh
   *  stops at the catalog. */
  async function refresh(): Promise<void> {
    if (!isReady) return;
    if (loading) { pendingRefresh = true; return; }
    loading = true;
    panel.webview.postMessage({ type: 'loading' });
    const entry = findOpenerEntry();
    // The panel must always NAME the entry it fetches with and adds to —
    // several OpenRouter servers means several keys and several save targets.
    panel.title = entry
      ? `Model Selector - ${entry.displayName ?? entry.id}`
      : 'OpenRouter Model Selector';

    // Step 1 — benchmarks define the plot universe (which models get a
    // quality axis and a provider fan-out).
    let bm: OpenRouterBenchmarkRow[] = [];
    let citation: string | undefined;
    let asOf: string | undefined;
    let bmError: string | undefined;
    if (!entry) {
      bmError = 'The OpenRouter server entry this view was opened from no longer exists (removed or changed). Reopen the selector from a current OpenRouter server row in the dashboard.';
    } else {
      try {
        const result = await fetchOpenRouterBenchmarks(sanitizeRequestHeaders(entry.requestHeaders ?? {}));
        bm = result.rows;
        citation = result.citation;
        asOf = result.asOf;
      } catch (err) {
        bmError = err instanceof Error ? err.message : String(err);
      }
    }

    // Step 2 — every text-output catalog variant, each carrying its catalog
    // list price; Step 3 — fan out per-provider endpoint lists for exactly
    // the benchmark-scored ids (the fan-out volume stays as before: one call
    // per scored variant, never per catalog row). Variants the fan-out did
    // not price keep their list row. No benchmarks (no quality axis) means
    // no catalog work and no provider fan-out.
    let models: SelectorModelRow[] = [];
    let catalogError: string | undefined;
    if (bm.length > 0) {
      try {
        const scoredBases = new Set(bm.map((r) => r.slug));
        const catalog = await fetchOpenRouterCatalog();
        const variants = catalogToTextVariants(catalog);
        const priced = new Map(
          (await buildSelectorRows(variants.filter((v) => scoredBases.has(v.base))))
            .map((r) => [r.id, r] as const),
        );
        models = variants.map(
          (v) =>
            priced.get(v.id) ?? {
              id: v.id,
              base: v.base,
              endpoints: [],
              tools: v.tools,
              img: v.img,
              ...(v.list ? { list: v.list } : {}),
            },
        );
      } catch (err) {
        catalogError = err instanceof Error ? err.message : String(err);
      }
    }

    loading = false;
    if (pendingRefresh) {
      // A re-open (or manual Refresh) arrived mid-flight. If the opener ENTRY
      // changed, this payload belongs to the PREVIOUS server: posting it
      // would show one server's data under another's configured-marks
      // (external review 2026-09-09) - DISCARD it and refetch under the
      // current opener. If the entry is unchanged (a double-click on the
      // same server, or a manual Refresh), this payload IS what the pending
      // refresh asked for: post it. Discarding a valid same-server payload
      // would burn another benchmarks call against the account-wide 500/day
      // quota for nothing.
      pendingRefresh = false;
      if (entry?.id !== findOpenerEntry()?.id) {
        void refresh();
        return;
      }
    }
    panel.webview.postMessage({
      type: 'data',
      models,
      bm,
      citation,
      asOf,
      catalogError,
      bmError,
      profile: { rCached: R_CACHED, rOut: R_OUT },
      configured: configuredMarks(),
      // The rows belong to THIS entry's fetch; the webview echoes it back in
      // 'use' so a click during a server-switch refetch (old rows still on
      // screen, opener already moved) cannot silently add to the new server.
      srv: entry?.id,
    });
  }

  /**
   * Answer a lazy provider-list request for one list-price row: the SAME
   * shared per-session cache the fan-out uses (a warm hit answers instantly;
   * failures resolve to an empty list, which the webview shows as "no usable
   * providers" instead of a toast). The response echoes the REQUESTER's srv
   * so a response racing a server switch is discarded by the webview - and
   * so a vanished opener entry answers as a failure instead of leaving the
   * row stuck on "loading…" forever.
   */
  async function fetchEndpointsFor(wireId: string, requesterSrv: string | undefined, output: vscode.OutputChannel): Promise<void> {
    const entry = findOpenerEntry();
    if (!entry) {
      panel.webview.postMessage({ type: 'endpoints', id: wireId, srv: requesterSrv, endpoints: [] });
      return;
    }
    let endpoints: SelectorEndpoint[] = [];
    try {
      endpoints = (await getOpenRouterModelEndpointsCached(wireId))
        .filter((ep) => ep.status === undefined || ep.status >= 0)
        .map(toSelectorEndpoint)
        .filter((e): e is SelectorEndpoint => e !== undefined);
    } catch (err) {
      output.appendLine(
        `[WARN] Model Selector lazy provider lookup for "${wireId}": ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    panel.webview.postMessage({ type: 'endpoints', id: wireId, srv: requesterSrv, endpoints });
  }

  const msgDisposable = panel.webview.onDidReceiveMessage((msg: WebviewMessage) => {
    if (msg.type === 'ready') {
      isReady = true;
      void refresh();
    } else if (msg.type === 'refresh') {
      void refresh();
    } else if (msg.type === 'use' && typeof msg.id === 'string' && typeof msg.tag === 'string') {
      if (typeof msg.srv === 'string' && msg.srv !== openerServerId) {
        // The visible rows were fetched for another OpenRouter entry while the
        // panel switched servers - saving now would hit the wrong credentials.
        void vscode.window.showInformationMessage(
          'vLLM-Copilot: this selector is reloading for a different OpenRouter server - wait for the new list, then use the model.',
        );
        return;
      }
      void useModelNow(msg.id, msg.tag, typeof msg.provider === 'string' ? msg.provider : msg.tag, output);
    } else if (msg.type === 'endpoints' && typeof msg.id === 'string') {
      void fetchEndpointsFor(msg.id, msg.srv, output);
    } else if (msg.type === 'open' && typeof msg.url === 'string') {
      // A webview cannot open external links itself (sandbox + CSP). Open the
      // OpenRouter model page through the workbench. The URL is one the webview
      // built as `https://openrouter.ai/<catalog id>` — a plain https GET that
      // just shows the public model page (the model id is public catalog data).
      const target = vscode.Uri.parse(msg.url, true);
      if (target.scheme === 'https' && target.authority === 'openrouter.ai') {
        void vscode.env.openExternal(target);
      }
    }
  });

  panel.onDidDispose(() => {
    msgDisposable.dispose();
    openPanel = undefined;
  });
  openPanel = { panel, refresh };
}

/**
 * "Use this model now": add the clicked (model, provider) pair's MODEL to the
 * server entry this selector was opened from — the same credentials that
 * produced the chart are the ones that will serve it. Reuses the Add flows'
 * shared tail end-to-end: catalog metadata resolution, the duplicate gate,
 * and the modal confirm-and-save dialog. Only the config HEAD differs from
 * the OpenRouter add flow: the target entry already exists, so nothing is
 * created and no auth rotates.
 *
 * Re-configure = overwrite (user ruling): when this ENTRY already has a
 * config for the wire id (the ✓-marked rows), the Update Auth / Replace
 * question is skipped and the existing config is simply overwritten — the
 * deliberate act of re-adding a model you own is "re-choose it", usually for
 * a different routing. Several configs sharing the wire id on this entry
 * still pick their victim through a QuickPick; guessing would destroy the
 * wrong one. Configs on a SIBLING entry that merely shares the URL keep the
 * old per-URL gate (Update Auth / Replace / cancel), because silently writing
 * into another entry is never an overwrite the user asked for here.
 *
 * Before saving, a routing dialog asks Auto vs pinning the clicked provider
 * (the `provider` field, applied as `provider.only` at request time) and
 * carries the no-warranty disclaimer: every rate shown is a published-data
 * best guess, and price responsibility stays with the user.
 */
async function useModelNow(wireId: string, providerTag: string, providerName: string, output: vscode.OutputChannel): Promise<void> {
  const entry = findOpenerEntry();
  if (!entry) {
    void vscode.window.showErrorMessage(
      'vLLM-Copilot: the OpenRouter server entry this selector was opened from no longer exists. Nothing was added.',
    );
    return;
  }
  let info: ReturnType<typeof normalizeOpenRouterFromCatalog>;
  try {
    info = normalizeOpenRouterFromCatalog(await fetchOpenRouterCatalog(), wireId);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    output.appendLine(`[ERROR] Model Selector "use" for "${wireId}": ${detail}`);
    void vscode.window.showErrorMessage(`vLLM-Copilot: ${detail}`);
    return;
  }
  const headers = sanitizeRequestHeaders(entry.requestHeaders ?? {});
  const apiBase = normalizeServerUrl(entry.serverUrl);
  // Re-configure in place: a config of this wire id already ON THIS ENTRY is
  // overwritten without the Update Auth / Replace question. Several configs
  // sharing the wire id pick their victim through a QuickPick - replacing a
  // blind first-match would silently destroy the wrong one.
  const onOpener = readModels().filter(
    (m) => m.server === entry.id && resolveVllmModelId(m) === wireId,
  );
  let replaceTarget: IdentifiedModelConfig | undefined;
  if (onOpener.length === 1) {
    replaceTarget = onOpener[0];
  } else if (onOpener.length > 1) {
    const items = onOpener.map((m) => ({
      label: m.displayName ?? resolveConfigId(m) ?? '',
      description: resolveConfigId(m),
      detail: `routing: ${m.provider ? `pinned to ${m.provider}` : 'Auto'} - vllmModelId: ${m.vllmModelId ?? m.id}`,
    }));
    const picked = await vscode.window.showQuickPick(items, {
      ignoreFocusOut: true,
      placeHolder: `Multiple configs share "${wireId}" on this server - choose which one to overwrite`,
    });
    if (!picked) {
      output.appendLine(`[INFO] Model Selector "use" for "${wireId}" cancelled - overwrite target not chosen.`);
      return;
    }
    // Index into the array the QuickPick was built from (gate doctrine): a
    // description-string re-lookup picks the wrong twin when two share an id.
    replaceTarget = onOpener[items.indexOf(picked)];
  }
  let gate: { replaceExistingId?: string; replaceTargetServer?: string } = {};
  if (!replaceTarget) {
    // Nothing on this entry: the shared per-URL gate still guards a sibling
    // entry sharing the URL (Update Auth / Replace / cancel).
    const g = await handleDuplicateModelGate(wireId, apiBase, headers, 'Model Selector', output);
    if (!g) return; // cancelled, or Update Auth took over
    gate = g;
  }
  // Routing question: Auto lets OpenRouter pick per request; Exact pins the
  // clicked provider via the config's `provider` field. The disclaimer states
  // the honest status of every number in this view: published-data best
  // guesses, no warranty, price responsibility with the user.
  const exactTitle = `Exact: ${providerName}`;
  const routing = await vscode.window.showInformationMessage(
    `How should "${wireId}" be included?\n\n` +
    `Auto: OpenRouter chooses a provider per request. Exact: every request is pinned to ${providerName} (${providerTag}).\n\n` +
    'Every price and statistic shown is a best guess from published rate cards, not a guarantee. Rates and providers change, and bugs happen. This extension takes no responsibility for price accuracy and is not liable for any over-charging a bug may cause - checking prices remains your responsibility.',
    { modal: true },
    'Auto',
    exactTitle,
  );
  if (routing === undefined) {
    output.appendLine(`[INFO] Model Selector "use" for "${wireId}" cancelled at the routing dialog. Nothing was saved.`);
    return;
  }
  const pinProvider = routing === exactTitle ? providerTag : undefined;
  // On any replace the model KEEPS the replaced config's identity —
  // replaceModelConfig matches on (id, server), a fresh id would append a twin.
  const replaceId = replaceTarget ? resolveConfigId(replaceTarget) : gate.replaceExistingId;
  const replaceServer = replaceTarget ? replaceTarget.server : gate.replaceTargetServer;
  // The config actually being overwritten: the same-entry target found above,
  // or (duplicate-gate path) the sibling entry's config picked by the gate's
  // identity. Choices the dialog never asks again must survive EITHER replace
  // route (the Auto-Configure preserve doctrine): routing order and the
  // prompt-cache billing policy. Provider is NOT here — routing (Auto/Exact)
  // was just asked, so the answer above is deliberately authoritative.
  const preserveVictim: ModelConfig | undefined =
    replaceTarget ??
    (gate.replaceExistingId !== undefined
      ? readModels().find(
          (m) => m.server === gate.replaceTargetServer && resolveConfigId(m) === gate.replaceExistingId,
        )
      : undefined);
  const finalConfig: IdentifiedModelConfig = {
    id: replaceId ?? buildModelId(entry.id, wireId),
    vllmModelId: wireId,
    displayName: info.displayName ?? wireId,
    server: replaceId ? replaceServer ?? entry.id : entry.id,
    ...(pinProvider !== undefined ? { provider: pinProvider } : {}),
    ...(preserveVictim?.routingMode ? { routingMode: preserveVictim.routingMode } : {}),
    ...(preserveVictim?.promptCache ? { promptCache: preserveVictim.promptCache } : {}),
    ...openRouterCatalogConfigFields(info),
  };
  const summary = [
    `OpenRouter model: ${info.wireModelId}`,
    ...(info.canonicalSlug && info.canonicalSlug !== info.wireModelId ? [`Canonical: ${info.canonicalSlug}`] : []),
    `Context window: ${info.runtimeLimits.contextWindow.toLocaleString('en-US')} tokens`,
    `Routing: ${pinProvider !== undefined ? `pinned to ${providerName} (${pinProvider})` : 'Auto (OpenRouter picks per request)'}`,
    ...(replaceTarget
      ? [`Replaces: overwrites this server's existing config "${resolveConfigId(replaceTarget) ?? wireId}" - its fields are replaced (a custom system-prompt file, the routing mode, and the prompt-cache policy carry over).`]
      : []),
    ...openRouterInfoDetailLines(info),
  ].join('\n');
  const saved = await confirmAndSaveAddedModel(finalConfig, wireId, apiBase, summary, output);
  if (saved) {
    // The ✓ in the table must reflect the write the moment it lands. Config
    // edits made elsewhere while the panel sits open refresh with the ↻ button.
    openPanel?.panel.webview.postMessage({ type: 'configured', configured: configuredMarks() });
  }
}

/**
 * Map the catalog to its text-output variants — the complete list the panel
 * shows. Drops only image/audio/video models (non-text output is not this
 * selector's question); benchmark scoring gates the PLOT (the endpoint
 * fan-out), never the list. Each catalog VARIANT keeps its own id —
 * `:free`/`:batch` are separate entries with their own providers, resolved
 * verbatim (no slug derivation). Every variant carries its catalog list
 * price so the webview can list and price what it cannot plot.
 */
function catalogToTextVariants(
  catalog: OpenRouterModelData[],
): { id: string; base: string; tools: boolean; img: boolean; list?: SelectorListPrice }[] {
  const variants: { id: string; base: string; tools: boolean; img: boolean; list?: SelectorListPrice }[] = [];
  for (const m of catalog) {
    const outs = m.architecture?.output_modalities;
    if (Array.isArray(outs) && outs.length > 0 && !outs.includes('text')) continue;
    const id = m.id;
    if (!id) continue;
    const base = m.canonical_slug?.trim() || id.split(':')[0];
    // Capability flags for the webview's checkboxes. Absent/unknown counts as
    // not-advertised — the same reading `normalizeOpenRouterModel` applies at
    // add time, so the selector and the saved config never disagree.
    const tools = m.supported_parameters?.includes('tools') ?? false;
    const img = m.architecture?.input_modalities?.includes('image') ?? false;
    const list = toListPrice(m);
    variants.push({ id, base, tools, img, ...(list ? { list } : {}) });
  }
  return variants;
}

/**
 * Catalog list price of one variant: the headline `pricing` record folded to
 * its worst time window and split into tiers by the SAME parser the endpoint
 * fan-out uses — the catalog payload carries the identical `overrides` array
 * (live-verified 2026-09-09), so both price surfaces share one fold.
 * Undefined when the headline carries no parseable input/output rate: the
 * variant still appears in the list (searchable, scored where joined), it
 * simply carries no numbers.
 */
function toListPrice(m: OpenRouterModelData): SelectorListPrice | undefined {
  const p = m.pricing;
  if (!p) return undefined;
  const worst = worstCasePricing(p, p.overrides);
  const shown = (worst ?? p) as Omit<NonNullable<OpenRouterModelData['pricing']>, 'overrides'> & {
    input_cache_write?: string | null;
    input_cache_write_1h?: string | null;
  };
  const input = perMillion(shown.prompt);
  const output = perMillion(shown.completion);
  if (input === undefined || output === undefined) return undefined;
  // Tiers keep ARRAY ORDER and sparse fields, exactly like the endpoint
  // conversion — later entries win per price key, gaps inherit the base.
  const { tiers: rawTiers } = parseEndpointPricingOverrides(p.overrides);
  const tiers = (rawTiers ?? []).map((t) => ({
    at: t.minPromptTokens,
    in: perMillion(t.prompt),
    out: perMillion(t.completion),
    cache: perMillion(t.inputCacheRead),
    write: perMillion(t.inputCacheWrite),
    w1h: perMillion(t.inputCacheWrite1h),
  }));
  return {
    in: input,
    out: output,
    cache: perMillion(shown.input_cache_read),
    write: perMillion(shown.input_cache_write) ?? 0,
    w1h: perMillion(shown.input_cache_write_1h),
    timeWorst: worst ? true : undefined,
    ctx: typeof m.context_length === 'number' && m.context_length > 0 ? m.context_length : undefined,
    tiers: tiers.length > 0 ? tiers : undefined,
  };
}

/** Convert one endpoint's raw per-token strings to per-1M, or undefined when
 *  the base input/output price is missing (endpoint can't be priced → dropped). */
function toSelectorEndpoint(ep: OpenRouterModelEndpoint): SelectorEndpoint | undefined {
  // Time-of-day windows are folded to the worst window by the parser
  // (`worst_case`, present exactly when windows exist) so every price surface
  // in the extension shares one fold implementation. A field no window
  // reports keeps the base rate; a missing cache rate keeps its worst-case
  // meaning (cached share at full input).
  const shown = ep.pricing?.worst_case ?? ep.pricing;
  const input = perMillion(shown?.prompt);
  const output = perMillion(shown?.completion);
  if (input === undefined || output === undefined) return undefined;
  const cache = perMillion(shown?.input_cache_read);
  const write = perMillion(shown?.input_cache_write) ?? 0;
  const write1h = perMillion(shown?.input_cache_write_1h);
  // Tiers keep ARRAY ORDER and sparse fields: the OpenAPI spec applies every
  // applicable entry per price key ("later entries win per price key; price
  // keys absent from an entry inherit the base price"), and a model can have
  // several thresholds (live-verified 2026-09-09: qwen/qwen3.7-flash
  // overrides at 32k AND 256k — keeping only [0] understated every
  // 1M-context rate by 50%). The webview folds applicable tiers per key over
  // the worst-case base; filling gaps with the base HERE would let a later
  // partial tier silently discard an earlier tier's override.
  const tiers = (ep.pricing?.overrides ?? []).map((t) => ({
    at: t.minPromptTokens,
    in: perMillion(t.prompt),
    out: perMillion(t.completion),
    cache: perMillion(t.inputCacheRead),
    write: perMillion(t.inputCacheWrite),
    w1h: perMillion(t.inputCacheWrite1h),
  }));
  return {
    tag: ep.tag,
    provider: ep.providerName,
    quant: ep.quantization,
    in: input,
    out: output,
    cache,
    write,
    w1h: write1h,
    timeWorst: ep.pricing?.worst_case ? true : undefined,
    ctx: typeof ep.contextLength === 'number' && ep.contextLength > 0 ? ep.contextLength : undefined,
    status: ep.status,
    uptime: ep.uptimeLast1d,
    lat: ep.latencyP50Ms,
    tput: ep.throughputP50TokPerSec,
    tiers: tiers.length > 0 ? tiers : undefined,
  };
}

/** Per-request provider cap for the fan-out (the list is public; the shared
 *  cache sends it with the OR entry's auth so perf stats are populated). Kept
 *  low out of respect for anonymous rate limits; combined with the shared
 *  5-minute cache the dashboard and Model Settings already warm, a reload is
 *  near-instant and a cold open returns in a couple of seconds (live probe:
 *  40 models at concurrency 5 in ~450 ms). */
const ENDPOINT_FANOUT_CONCURRENCY = 5;

/**
 * Build the per-(model, provider) rows: fan out the shared provider-list cache
 * for each variant id it is given (the scored subset - one call per scored
 * variant, never per catalog row), convert each endpoint, and keep only
 * operational endpoints with a parseable base price. A variant whose providers
 * all fail or all lack a usable price is absent from the result - the caller
 * falls it back to its catalog list row. The provider-list cache is the SAME
 * one the dashboard and Model Settings use, so a warm cache makes this
 * near-instant.
 */
async function buildSelectorRows(
  variants: { id: string; base: string; tools: boolean; img: boolean }[],
): Promise<SelectorModelRow[]> {
  const rows: SelectorModelRow[] = [];
  let index = 0;
  async function worker(): Promise<void> {
    while (index < variants.length) {
      const v = variants[index++];
      let eps: OpenRouterModelEndpoint[] = [];
      try {
        eps = await getOpenRouterModelEndpointsCached(v.id);
      } catch {
        eps = []; // a failed provider lookup just yields no endpoints for it
      }
      const endpoints = eps
        .filter((ep) => ep.status === undefined || ep.status >= 0)
        .map(toSelectorEndpoint)
        .filter((e): e is SelectorEndpoint => e !== undefined);
      if (endpoints.length > 0) rows.push({ id: v.id, base: v.base, tools: v.tools, img: v.img, endpoints });
    }
  }
  const lanes = Math.min(ENDPOINT_FANOUT_CONCURRENCY, variants.length);
  await Promise.all(Array.from({ length: lanes }, worker));
  return rows;
}

function buildHtml(webview: vscode.Webview, scriptUri: vscode.Uri, styleUri: vscode.Uri, searchJsUri: vscode.Uri): string {
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline' ${webview.cspSource}; script-src ${webview.cspSource};">
  <link href="${styleUri}" rel="stylesheet">
</head>
<body>
  <div id="busy">
    <div class="busy-card"><span class="spinner"></span>Downloading data, please wait&hellip;</div>
  </div>
  <header>
    <h1>OpenRouter Model Selector</h1>
    <span id="stamp">Loading…</span>
    <span class="head-right">
      <button id="btn-warn" class="round-btn warn" title="Disclaimer: prices are best guesses, you carry the cost">!</button>
      <button id="btn-help" class="round-btn help" title="How the cost is calculated">?</button>
    </span>
  </header>
  <div id="banner" hidden></div>
  <section id="controls">
    <div class="ctl">
      <label for="s-cache">Cache hit rate <b id="v-cache"></b></label>
      <input id="s-cache" type="range" min="0" max="99" step="0.1">
    </div>
    <div class="ctl">
      <label for="s-out">Output per prompt <b id="v-out"></b></label>
      <input id="s-out" type="range" min="0" max="5" step="0.01">
    </div>
    <div class="ctl">
      <label for="sel-axis">Quality axis</label>
      <select id="sel-axis">
        <option value="coding">Coding index</option>
        <option value="agentic">Agentic index</option>
        <option value="intelligence">Intelligence index</option>
        <option value="blend">Weighted blend (relative)</option>
      </select>
    </div>
    <div class="ctl" id="w-c" hidden>
      <label for="sw-c">weight: coding <b id="v-wc"></b></label>
      <input id="sw-c" type="range" min="0" max="2" step="0.05" value="1">
    </div>
    <div class="ctl" id="w-a" hidden>
      <label for="sw-a">weight: agentic <b id="v-wa"></b></label>
      <input id="sw-a" type="range" min="0" max="2" step="0.05" value="1">
    </div>
    <div class="ctl" id="w-i" hidden>
      <label for="sw-i">weight: intelligence <b id="v-wi"></b></label>
      <input id="sw-i" type="range" min="0" max="2" step="0.05" value="1">
    </div>
    <div class="ctl">
      <label for="sel-ctx">Min context <span class="sub">(provider window)</span></label>
      <select id="sel-ctx" title="Capacity filter: a provider must serve at least this window to appear. Does NOT price anything - the prompt-size control next to it does.">
        <option value="0">any</option>
        <option value="32768">32k</option>
        <option value="65536">64k</option>
        <option value="131072">128k</option>
        <option value="200000" selected>200k</option>
        <option value="262144">256k</option>
        <option value="1048576">1M</option>
      </select>
    </div>
    <div class="ctl">
      <label for="sel-prompt">Pricing prompt size <span class="sub">(long-context tiers)</span></label>
      <select id="sel-prompt" title="Your typical request prompt size. A provider's long-context tier prices the job when this exceeds the tier threshold - independent of the min-context filter.">
        <option value="8192">8k</option>
        <option value="32768">32k</option>
        <option value="65536">64k</option>
        <option value="131072">128k</option>
        <option value="200000" selected>200k</option>
        <option value="262144">256k</option>
        <option value="1048576">1M</option>
      </select>
    </div>
    <label class="chk" title="Copilot agent mode needs tool-calling. On: only models the catalog advertises tools for. Off: everything."><input id="cb-tools" type="checkbox" checked> tool-calling</label>
    <label class="chk" title="On: only models that accept image input (pasted screenshots). Off (default): everything - image-blind models are still excellent coders."><input id="cb-img" type="checkbox"> image input</label>
    <label class="chk"><input id="cb-free" type="checkbox" checked> free variants</label>
    <label class="chk"><input id="cb-batch" type="checkbox"> batch variants</label>
    <input id="q" type="text" placeholder="search all models…" spellcheck="false">
    <button id="btn-refresh" title="Re-fetch benchmarks + catalog + provider lists">&#x21bb; Refresh</button>
  </section>
  <section id="chart-wrap"><div id="chart"></div></section>
  <section id="lower">
    <div id="table-wrap" tabindex="0" aria-label="Result list - Up and Down arrow keys select a model, the buttons in the detail panel act on the selection"><table id="tbl"><thead></thead><tbody></tbody></table></div>
    <aside id="detail"><div class="hint">Click a dot or row for the provider cost breakdown.</div></aside>
  </section>
  <footer>
    <div id="legend" class="legend" hidden></div>
    <div class="disclaimer">Costs are best-guess estimates from published provider rates. No warranty: rates change, bugs happen, verify prices yourself - your spend is your responsibility.</div>
    <div id="citation"></div>
  </footer>
  <div id="modal" class="modal" role="dialog" aria-modal="true" aria-labelledby="modal-title" hidden>
    <div class="modal-card">
      <div class="modal-head">
        <h2 id="modal-title">How the cost is calculated</h2>
        <button id="modal-close">Close</button>
      </div>
      <p>Every number is a cost per <b>day</b> - an accounting unit of <b>one hundred million prompt tokens</b> plus the output your profile implies, roughly a heavy day of agentic work (calibrated 2026-09-09 against real usage: a session that reaches ~90M tokens by 20:00). A real request is not a hundred million tokens: the day is just a comparison unit, prices scale linearly, so any scale you pick ranks providers identically. Long-context tiers key off the separate <i>pricing prompt size</i> control, not off this unit. Nothing is re-fetched, the sliders only re-weight these rates.</p>
      <h3>Usage profile</h3>
      <ul class="varlist">
        <li><b>r<sub>cached</sub></b> &middot; share of prompt tokens the provider serves from its own cache</li>
        <li><b>r<sub>new</sub> = 1 &minus; r<sub>cached</sub></b> &middot; share billed as fresh input</li>
        <li><b>r<sub>out</sub></b> &middot; output tokens per prompt token</li>
      </ul>
      <h3>Effective price of one job</h3>
      <div class="eq">p<sub>eff</sub> = r<sub>new</sub> &middot; p<sub>new</sub> + r<sub>cached</sub> &middot; p<sub>cache</sub> + r<sub>out</sub> &middot; p<sub>out</sub></div>
      <p class="where"><b>p<sub>new</sub></b> = p<sub>write</sub> when the provider publishes a write rate and the mix has cache activity, otherwise p<sub>in</sub>: the input buckets are disjoint, so a token written to the cache pays the creation rate <i>instead of</i> the input rate (Sonnet 4.6: 3.75 replaces 3.00, it never becomes 6.75).</p>
      <p class="where">All four p values are the serving provider's published rates in USD per 1M tokens.
        All three r values come from the sliders. Result in USD per million prompt tokens.</p>
      <h3>Table and chart columns</h3>
      <div class="eq">USD per 100M-token day = p<sub>eff</sub> &times; 100</div>
      <h3>Rate selection per provider</h3>
      <ul class="varlist">
        <li><b>p<sub>cache</sub></b> = the provider's published cache-read rate; <b>a provider without one is charged full input</b> for the cached share (it cannot serve the cache hits your workload depends on). Shown as <i>none*</i> in the table.</li>
        <li><b>p<sub>write</sub></b> = the published cache-write rate. With cache activity it REPLACES p<sub>in</sub> for the new share (a growing prompt is exactly the cache delta); providers publishing no write rate (many bill writes at plain input) keep p<sub>new</sub> = p<sub>in</sub>, and the write column shows "-".</li>
        <li>A model you already <b>configured</b> with a non-default <i>Prompt cache</i> policy is priced under <b>that</b> policy: <i>off</i> rows drop the cached share entirely (plain input, no write), <i>1h</i> rows pay the provider's published 1-hour write rate. The detail card badges which policy was priced.</li>
        <li>Long-context tiers replace the base rates when <i>pricing prompt size</i> sits strictly above the provider's threshold; when a provider reports several, every applicable one contributes per rate (later entries win per key, keys none override stay at base), shown at the peak - exactly like its billing. <i>Min context</i> only filters provider windows - the two knobs are independent: a provider that stays visible because it serves 1M tokens is still priced at your typical prompt size, not at 1M.</li>
        <li>Some providers price by <b>time of day</b> (e.g. <i>tencent/hy3</i> is 37.5% cheaper between 16:00 and 24:00 UTC). This view never bakes your clock into a price: such a provider is shown at its <b>most expensive window</b>, marked with a <b>clock</b> (also in the detail card). Off-peak savings are real - look them up on the provider's OpenRouter page; the exact windows are deliberately not modeled here.</li>
        <li>A provider only appears when <b>its own</b> context window reaches the min-context selector. The model's catalog max is the largest window across providers, not a promise from the cheap one. A <b>list price</b> row (a model with no per-provider rows) is filtered by the catalog's advertised window instead.</li>
      </ul>
      <h3>Performance columns</h3>
      <ul class="varlist">
        <li><b>latency</b> = the provider's p50 time-to-first-token in ms over the last 30 minutes; identical prices are told apart by how fast the provider answers.</li>
        <li><b>tok/s</b> = p50 output throughput over the same window.</li>
        <li><b>uptime</b> = reported availability over the last day.</li>
        <li><i>-</i> means OpenRouter had no recent traffic to measure, not that the provider is down. The fetch carries your OpenRouter key because the API reports these stats only to authenticated requests.</li>
      </ul>
      <h3>Quality axis and the Pareto front</h3>
      <div class="eq">blend = 100 &middot; &Sigma; w<sub>i</sub>n<sub>i</sub> / &Sigma; w<sub>i</sub> &nbsp; with &nbsp; n<sub>i</sub> = (q<sub>i</sub> − min<sub>i</sub>) / (max<sub>i</sub> − min<sub>i</sub>)</div>
        <p class="where">q<sub>i</sub> are the Artificial Analysis indices a model reports (coding, agentic, intelligence), w<sub>i</sub> the weights you set. The indices live on <b>different numeric scales</b> (the coding index runs far higher than the intelligence index), so each is first normalized to 0-1 against the best and worst of the loaded set - n<sub>i</sub> above - before weighting. Averaging the raw values instead would let the widest-scale axis dominate your weights, and a model missing one index could outscore the leader of all three by reweighting over its two high-scale ones. <b>Completeness rule (for the plot):</b> a dot or a star needs real data for what you rank on - the blend needs all three indices, a single axis needs that one. Nothing is reweighted, guessed, or massaged. Models without a benchmark score stay in the <b>list</b> - searchable, priced at their catalog list price, quality shown as <i>-</i> - but never earn a dot or a star; <b>selecting one loads its provider lists</b> and turns it into normal provider rows, "Use" included. A model leading every index therefore always tops the blend.</p>
      <p>A pair is on the <b>Pareto front</b> (&#9733;) when no other pair is both cheaper and better, on the currently selected axis. Because every provider of one model shares the same quality score, only that model's cheapest price reaches the front - and when several providers serve it at that exact price, they all share the star.</p>
      <p class="where">Benchmarks are never polled: they define the <i>plot</i> universe - which models get provider rows, dots and stars - so the whole view needs an OpenRouter server with a key. The list below the chart covers every text-output model in the catalog regardless. Rates and provider windows come from the shared per-session endpoint cache.</p>
      <p class="where">The <b>tool-calling</b> (on) and <b>image input</b> (off) checkboxes narrow list <i>and</i> plot by what the catalog advertises: <i>tool-calling</i> is on because Copilot agent mode cannot work without it; <i>image input</i> is off because image-blind models are still excellent coders. These are view filters only - uncheck one and its models are back, listed and addable as before.</p>
      <h3>No warranty</h3>
      <p class="where">Every price and statistic here is a best guess from OpenRouter's published rate cards, read at fetch time. Rates change, providers change, and bugs happen. This view is no guarantee and no billing promise, and this extension takes no responsibility for price accuracy or for over-charging a bug may cause. Verify prices on the model's own page before you spend; checking prices and owning your usage stays your responsibility.</p>
    </div>
  </div>
  <div id="modal-warn" class="modal" role="dialog" aria-modal="true" aria-labelledby="modal-warn-title" hidden>
    <div class="modal-card warn-card">
      <div class="modal-head">
        <h2 id="modal-warn-title">You are responsible for your costs</h2>
        <button id="modal-warn-close">Close</button>
      </div>
      <p><b>Everything on this page is a best estimate.</b> Prices come from the rate cards OpenRouter and its providers publish, read at fetch time. Providers reprice, add surcharges, and drop models without notice, and this view can lag or misread any of it.</p>
      <p><b>vLLM-Copilot is not responsible for price accuracy and is not liable for your bill.</b> That includes over-charging caused by bugs in this extension, stale rates, wrong provider routing, or a price OpenRouter changed after this page loaded. Nothing here is financial advice, a quote, or a contract.</p>
      <p><b>Verify before you spend.</b> The serving provider's own pricing page is the only source of truth. Check it before relying on any number on this page, and review your OpenRouter usage page after real use.</p>
      <p><b>"Use this model now" only writes a config entry.</b> It buys nothing and guarantees nothing about which provider or price will actually serve a request; routing stays with OpenRouter, and Auto can move between providers at any time.</p>
    </div>
  </div>
  <script src="${searchJsUri}"></script>
  <script src="${scriptUri}"></script>
</body>
</html>`;
}
