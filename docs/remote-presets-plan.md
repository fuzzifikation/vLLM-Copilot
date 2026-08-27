# Remote Model Presets — live lookup against the GitHub repo during Add / Auto-Configure

**Status:** ✅ Implemented 2026-08-27, released as v1.34.0 (commit 1: format v2 `c09e318`; commit 2: live lookup + index + Action + dialog provenance; squashed monolith, rc.1 promoted to GA). Kept as the design record.
**Post-implementation deviation:** the planned permanent legacy shim (bare configs loading without the `PRESET_CONFIG_KEYS` allow-list) was **removed before the release shipped**. It never appeared in any published version, validated nothing (wholesale spread into `ModelConfig` — a transport-field smuggle path), and its only consumers were its own test fixtures. The v2 envelope is now the ONLY accepted format everywhere; `ModelPreset.config` is honestly typed `PresetConfig`, and the separate remote `presetVersion` probe became redundant with the guard and was deleted too.
**Date:** 2026-08-27 (rev 2 — live fetch replaces the download-and-cache design after user review: no globalStorage, no commands to remember).
**Origin:** [feature-ideas.md](./feature-ideas.md) → "Remote Model Presets" (P3). Promoted to a plan after v1.33.1 + v1.33.2 shipped two *preset-only* releases in one day, each requiring a full VSIX build + marketplace publish for pure JSON data.
**Motivating case:** GLM-5.3 releases 2026-08-28 — with this feature its preset reaches every user the same day via `git push`, no release round-trip.

---

## 0. TL;DR

No cache, no commands, no globalStorage. When the user runs **Add Server /
Auto-Configure** — the ONE moment preset knowledge is actually needed — the
flow already talks to the network (server probe, HF discovery). It now also
fetches a tiny **list file** from the repo
(`model-configs/index.json`: pattern → filename), matches the identified model
against the remote patterns **in memory**, and if a remote preset wins the
longest-match contest, downloads **that one file** and offers it exactly like
a bundled preset. No match, no network, timeout → behaves exactly like today,
silently.

**Precondition: Preset Format v2 (§4).** The `match` / `meta` / `config`
envelope makes identity/routing fields structurally impossible in a remote
file (the sandbox becomes a type guarantee) and gives the list file its
match patterns. Bundled files migrate in one commit; the loader accepts the
legacy shape forever.

The whole feature is: one small fetch module (~80 lines), an envelope +
unknown-key guard, the list file, tests. Nothing downstream changes —
`findPresetForModel` and `mergePresetWithUserConfig` already treat presets as
plain config objects, and the runtime has exactly **one** preset consumer:
`hfDiscovery.ts` (apply-on-add). Dashboard, provider, and request path never
touch presets.

---

## 1. Goals / Non-goals

**Goals**

1. A preset pushed to `main` reaches users without a VSIX release — at the moment they add the model.
2. Zero new user actions. No commands to remember; the lookup is opportunistic inside the flow that needs it.
3. Bundled presets keep working untouched: offline, air-gapped, marketplace installs. `test/modelConfigPresets.test.ts` keeps guarding exactly what ships in the VSIX.
4. A sloppy or hostile remote preset **cannot** repoint a user's traffic or attach headers — only client request-shaping fields survive the sandbox.
5. Failure is invisible: any error → the flow continues with bundled presets as if nothing changed.

**Non-goals**

- **No disk cache, no "Fetch Presets" command, no update badge** (rev-1 design, deleted: users don't remember commands; the add flow is the only consumer). No in-memory cache either (§5) — the payload is trivial and freshness is free.
- No user-configurable repo/URL (that's the Shareable Profiles idea, §10). Hardcoded repo only.
- No GPG/Sigstore signing — envelope guard + hardcoded HTTPS repo + apply-on-confirm is proportionate here.
- No remote *deletions* propagating (absence from the list = bundled baseline applies, which is correct).
- No server registry ("B") interaction — orthogonal, zero shared surface.
- No remote lookup anywhere else (dashboard refresh, Test & Refresh, provider): Add/Auto-Configure only.

---

## 2. Architecture decisions

| Decision | Choice | Why |
|---|---|---|
| When | **Live, inside Add Server / Auto-Configure**, after model identification | The only moment a preset matters. The flow is already interactive + network-bound; one more fetch with a hard timeout is invisible. |
| What is fetched | Tiny **list file** first; then **at most one** preset file — the match winner | No directory scraping (raw can't list; API rate-limits). Pattern matching happens in memory against the list, so a non-match costs one small request. |
| Source | `https://raw.githubusercontent.com/fuzzifikation/vLLM-Copilot/main/model-configs/…` hardcoded | No settings surface. Same trust model as bundled files (curation), just fresher. |
| File format | **Preset Format v2** (§4), required for remote files | Identity/routing fields get no legal location → sandbox is structural, not procedural. List entries reuse `match[]`. |
| Matching | Remote candidate is placed **first in the array** passed to the existing longest-match rule | Its tie rule (equal length → first wins) makes remote beat a same-pattern bundled entry for free. A bundled-specific preset (`X-Pro-0813`) still beats a generic remote one (`X-Pro`) by length. No new selection logic. |
| Offer UX | Identical to bundled presets, plus `meta.notes` + provenance line (§4) | "As always and like it was local" — the confirm dialog already exists; notes + provenance are the informed-consent screen for a git-fetched request-shaping file. |
| Failure model | Timeout / offline / bad JSON / guard reject → skip remote, continue bundled. One output-channel line, no user-facing error. | Preset freshness must never break Add Server. |
| Trust | v2 envelope + whole-file rejection (§7) | A remote file carrying out-of-schema keys is dropped whole, not trimmed. |

---

## 3. List file format

`model-configs/index.json` (committed to the repo; **generated, never hand-
edited** — see freshness chain below):

```jsonc
{
  "schemaVersion": 1,                 // bump only on incompatible semantic changes
  "updated": "2026-08-27",
  "presets": [
    { "match": ["GLM-5.3"],         "file": "GLM-5.3.json" },
    { "match": ["DeepSeek-V4-Pro"], "file": "DeepSeek-V4-Pro.json" }
    // … every remotely served preset
  ]
}
```

Rules:

- `match` patterns here are **authoritative for selection** (they equal the preset file's own `match` — the generator copies them, the drift test enforces it). The command decides from this file alone and only then downloads the winner.
- `schemaVersion` > supported → **skip the whole lookup**, bundled-only. Never half-interpret a future format. Per-preset compatibility needs no second gate: `presetVersion` + the whole-file guard (§7) already stop an old client at the *file* level.
- **Forward compatibility:** the loader MUST ignore unknown fields (same permissive-wire convention as `OpenRouterModelData`). Additive changes therefore need no version bump — an old extension reads a new list and simply skips what it doesn't know. Only a *semantic* change to an existing field bumps `schemaVersion` (= "old clients must skip", per the rule above). No `comment`/reserved fields: this file is generated, human commentary lives in the generator script and this doc.
- `file` must be a bare `*.json` name — path characters rejected.
- ~1 KB at current scale; the cost of a non-match.

**Freshness chain (the "I forget" problem — two layers):**

1. **GitHub Action (primary):** `on: push: paths: model-configs/**` → run
   `node scripts/gen-preset-index.mjs`; if `index.json` changed, commit + push
   it (bot commit, `[skip ci]`). This feature's whole premise is preset pushes
   *without* a release build — the Action is the only layer that covers that
   path, so the remote list can never lag the directory.
2. **Drift test (gate):** Vitest regenerates the expected list in memory and
   fails with `run "npm run gen:presets"` on mismatch. Because `npm run build`
   runs the suite, a stale index **cannot ship** — no third auto-fix layer is
   needed, and nothing at runtime reads the bundled copy anyway (bundled
   matching comes from the preset envelopes themselves).

---

## 4. Preset Format v2 (precondition)

The current preset file **is** a bare `ModelConfig`, which means:

- `vllmModelId` does double duty — substring *match key* for `findPresetForModel` AND suggested *exact wire id* when the user has none. The header comments in existing files contradict each other about it. The GLM-5.3 rename (2026-08-27) worked by *exploiting* this ambiguity.
- All provenance (source, verification date, caveats) is locked in `//` prose — unvalidatable, undisplayable. Remote presets *need* displayed provenance; this finally gives it a home.
- Identity fields (`id`, `serverUrl`, `requestHeaders`, `serverType`, `provider`) are syntactically legal in a file that should never carry them.
- No per-file version stamp.

v2 envelope:

```jsonc
{
  "presetVersion": 1,
  "match": ["GLM-5.3"],              // substrings; longest match across all presets wins (rule unchanged)
  "meta": {
    "name": "GLM-5.3 family (Z.ai)",
    "source": "https://huggingface.co/zai-org/GLM-5.3-Flash",  // https only, validated
    "verified": "2026-08-27",                                  // ISO date, validated
    "notes": "glm5_next; thinking always on; effort via reasoning_effort."
  },
  "config": {                        // ModelConfig MINUS identity — enforced by type, not by filter
    "displayName": "GLM-5.3",
    "family": "glm5_next",
    "maxOutputTokens": 65536,
    "capabilities": { "toolCalling": true, "imageInput": true },
    "modelModes": { "Think (Max)": { /* … */ } },
    "defaultMode": "Think (Max)"
  }
}
```

**Design rules**

- `type PresetConfig = Omit<ModelConfig, 'id' | 'serverUrl' | 'requestHeaders' | 'serverType' | 'provider'>` (the identity/routing set). A remote file physically has nowhere to put a server URL; the runtime guard (§7) collapses to "reject files with keys outside the envelope schema".
- `match: string[]` decouples matching from the wire id — and the list file (§3) copies from it, which is why v2 is a *precondition*, not a parallel idea.
- `meta` is validated (https source, ISO date) and **displayed**: the Add/Auto-Configure confirm dialog shows `meta.notes` + provenance — "GLM-5.3 preset — thinking always on, effort via `reasoning_effort` · from vLLM-Copilot/main · verified 2026-08-27 · source ↗". That is the informed-consent screen for a git-fetched request-shaping file. **`notes` is the displayable summary** (one or two sentences — it renders in a dialog); long-form authoring rationale stays as `//` comments above the envelope (still stripped by `parsePresetJson`, maintainer-only, never displayed or sent). Bundled presets show their `meta` too (uniform UI, no "remote = scary" asymmetry).
- `presetVersion` gates per file: unknown version → file skipped (per-file isolation in `parsePresetJson` already exists).
- `config.vllmModelId` remains the suggested wire id when the user has none — now its ONLY job.

**What stays**

- Mode names remain free text (`Think (Max)`, `No Think`, …) — per-model UX; standardizing across vendors would fake a consistency that doesn't exist.
- One model per file. Multi-variant files buy nothing `match[]` doesn't cover.
- The preset-header policy (client config only, no hosting tips, bare recipe links) carries into `meta.notes` unchanged.

**Migration**

- Loader detects legacy shape (no `presetVersion`) and converts in place: `vllmModelId` → `match[0]` + `config.vllmModelId`, `meta.name` from `displayName`. ~10 lines, same pattern as the usage-store v1→v3 migration. Legacy support is **permanent** (cheap; third-party files may exist once the format is public).
- All 13 bundled presets are rewritten to v2 in one mechanical commit: the distilled one-liner from each header goes into `meta.notes`, the remaining header prose stays as `//` comments above the envelope (authoring rationale preserved, §4). `test/modelConfigPresets.test.ts` validates the envelope instead of "is it a ModelConfig".
- Ships as its own commit/PR **before** any remote code — independently revertable at the release boundary.

---

## 5. Live lookup flow

New module `src/presetRemote.ts`, called from the one place presets are read today (`hfDiscovery.ts`, in the shared Add/Auto-Configure path):

```
model identified (server /v1/models + root)
  ├─ bundled presets = loadModelPresets(extensionUri)          // unchanged
  ├─ list = fetch index.json   (hard timeout ~2 s, HTTPS, size cap,
  │                             signal = timeout ∥ user cancel; no cache)
  │        on any failure → skip remote entirely, continue bundled
  ├─ candidates = bundled ++ remote-list-matches               // pattern match in memory
  ├─ winner = longest-match rule (same pattern → remote wins)
  ├─ winner is remote? → fetch its ONE file (same timeout/cap)
  │        parse → v2 required → envelope guard → ModelConfig validation
  │        on any failure → fall back to bundled winner
  └─ offer as today (confirm dialog + merge), with meta provenance line
```

Notes:

- **Parallel, not sequential.** Kick off the list fetch as soon as the model id is known — concurrent with the existing server probe / HF discovery — and await it only at selection time. The flow already waits on network work, so the lookup costs ~nothing perceived; a sequential fetch would tax every Add of a *non-bundled* model (the common case) with a GitHub round-trip.
- **Cost on a miss:** one ~1 KB GET. On a hit: two GETs. Only during Add/Auto-Configure — a manual, rare, already-interactive flow. No polling anywhere else.
- **No cache.** The payload is a 1 KB list off GitHub's CDN in a manual, rare flow — module-level state, a reset hook, and staleness semantics cost more than the bytes they save. Every lookup fetches fresh; a reload is automatically fresh too.
- **Cancellation:** the fetch gets `AbortSignal.any([AbortSignal.timeout(~2s), userCancelToken])` — the timeout bounds it, the user's Escape kills it immediately (repo rule: cancellation tokens are always respected; no zombie fetch outlives a cancelled flow).
- **Ordering:** runs *after* the model id is known (needs it to match) and *before* the preset offer. The server probe and HF discovery are untouched.
- The list file ships nowhere else: not in the VSIX logic, not probed on activation.

---

## 6. Overlay semantics

- Selection is a single pass of the existing longest-match rule — `findPresetForModel` itself unchanged (it learns to read `match`, with a legacy shim). **Remote-wins-same-pattern is array order**: the caller passes `[remote, ...bundled]` and the matcher's existing "equal length → first wins" tie rule does the rest. Zero new logic.
- Bundled wins longer-pattern (specificity): `X-Pro-0813` bundled still beats `X-Pro` remote.
- A remote hit that fails the guard (§7) is dropped **before** entering selection — never half-merged.
- `mergePresetWithUserConfig` unchanged: user's `id`/`vllmModelId` preserved; nothing a remote file can touch.
- Offline = no remote array = byte-identical to today.

---

## 7. Trust model — the envelope guard

With v2, identity/routing fields have **no legal location** in a remote preset. What remains is structural + one guard:

| Kept (client request-shaping) | Rejected |
|---|---|
| `config`: exactly the `PresetConfig` keys (`displayName`, `family`, `maxOutputTokens`, `capabilities`, `modelModes`, `defaultMode`, `defaultParams`, `maxInputTokens`, `vllmModelId`) | any key outside `PresetConfig` — `serverUrl`, `requestHeaders`, `apiKey`, `serverType`, `provider` included (routing is the user's choice, not a preset's) |
| `meta`: `name`, `source`, `verified`, `notes` (displayed, never sent on the wire) | any other top-level key; legacy (non-v2) remote files entirely |

Notes:

- **Asymmetric guard:** an unknown key in `config` → **drop the whole file** (wire-affecting — its presence means the file isn't what it claims to be, and half-trusting it is worse). An unknown key in `meta` → **ignore the field** (display-only, cannot affect any request). This keeps `meta` forward-compatible: adding a display field later never makes old extensions discard the preset.
- Rejection is **whole-file, not key-trimming**: the dropped file is logged (output channel) and the bundled winner applies. A legitimate preset never needs out-of-schema config keys, so their presence is itself the signal.
- Bundled presets skip the guard (two review gates: PR + release). The guard applies only to fetched files.
- `capabilities` stays in the allowlist deliberately — it gates toolCalling/imageInput advertised to Copilot, which is exactly the value of a fast preset fix (a wrong `true` costs a failed request, not a security breach).
- The user still **confirms** the offer before anything is written — same as today's preset offer. Live fetch changes *where* the preset came from, not *whether* the user says yes.
- **"Why is there no opt-out setting?"** Because HF discovery *already* makes outbound `huggingface.co` requests in this exact flow — the GitHub lookup adds no new privacy category, no new capability, and no new failure mode. A toggle would also violate the one-global-setting doctrine. If a future review disagrees, the honest answer is "remove HF discovery too, or neither."
- **What the guard cannot stop:** a schema-valid but *wrong* remote edit (bad sampling pushed to `main`) reaches users via same-pattern remote-wins. That is not a new risk class — it is the bundled curation trust already accepted, just with a shorter fuse. The existing human gates are the mitigation: your push is the review, `meta.verified` shows the freshness in the dialog, and the user confirms every apply. No new machinery for a risk the release process already carries.

---

## 8. Minimal change set

| File | Change |
|---|---|
| `src/commands/presets.ts` | v2 envelope types (`PresetFile`, `PresetConfig`), legacy→v2 shim, `findPresetForModel` reads `match[]`. |
| `src/presetRemote.ts` | **NEW** — list fetch + pattern pre-match + single-file fetch + envelope guard. ~80–120 lines, one exported `resolveRemotePreset(modelId, root)`. |
| `src/commands/hfDiscovery.ts` | one call: merge remote candidate into the candidate set before selection. ~5 lines. |
| `package.json` | no commands/settings; add `"gen:presets": "node scripts/gen-preset-index.mjs"` (used by the Action and the drift-test message). |
| `.github/workflows/preset-index.yml` | **NEW** — regenerate + commit `index.json` on any push touching `model-configs/**` (§3, layer 1). |
| `model-configs/*.json` + `index.json` | mechanical v2 rewrite of all 13 presets (**separate earlier commit**); **NEW** `index.json` + `scripts/gen-preset-index.mjs`. |
| `test/modelConfigPresets.test.ts` | validate the v2 envelope + index-drift guard (list `match` == file `match`, list == directory). |
| Docs | usage/README: "new presets arrive automatically when you Add a model — bundled offline, refreshed from GitHub when online". CHANGELOG at ship time. |

No `extension.ts` command registration, no globalStorage, no cache, no disposables — the deleted rev-1 surface is the review point.

---

## 9. Tests

- **Format:** legacy shape converts to v2 (match/config/meta filled, selection unchanged); unknown key in `config` → file dropped + logged; unknown key in `meta` → field ignored, preset still applies; `presetVersion` too new → skipped.
- **Selection:** remote wins same-pattern over bundled; bundled longer-pattern beats remote generic (`X-Pro-0813` bundled beats `X-Pro` remote); remote-only id extends coverage; empty/no-remote set = today's behavior.
- **List:** `schemaVersion` too new → skip; path traversal in `file` rejected; size cap enforced; pattern match is case-insensitive substring like the matcher.
- **Failure:** timeout / offline / malformed list / malformed preset / guard reject → bundled winner offered, no throw into the Add flow, one log line each; user cancel during the lookup aborts the fetch (signal-composition contract).
- **Parallel-start:** structural contract, not wall clock — with mocked fetches, assert the list request is initiated before the HF-discovery await resolves (call-order assertion; no timing assertions that go flaky in CI).
- **Index drift:** `index.json` lists exactly the files in `model-configs/` with identical `match` arrays (auto-discovery, same style as the preset guard test).
- Existing suite untouched; `modelConfigPresets.test.ts` keeps covering bundled files only (remote module mocked out).

---

## 10. Acceptance criteria

- Push a new preset + updated `index.json` to `main` → user adds that model the next minute → preset is offered with provenance line, confirmed, saved. No VSIX update, no command run.
- Air-gapped / firewalled machine: Add Server behaves exactly as today (bundled set), no error, no delay beyond the timeout.
- Hostile list/preset cannot change the endpoint, headers, or backend type of any user model. (Tested, not trusted.)
- After the v2 migration commit alone (before any remote code): every existing preset applies exactly as before; full suite green.
- `npm run compile && npm test` green; no change to provider/request-path behavior; no new commands or settings in the palette.

---

## 11. Future (recorded, not built)

- **Provenance in Model Settings:** show `meta` beside a model configured from a preset — `notes`, verified date, source link. The "after loading" half of the display story; the data is already in the envelope.
- **Shareable Model-Mode Profiles** ([feature-ideas](./feature-ideas.md)): team profiles = the same live-lookup pipeline with a *user-provided* list URL + per-source trust choice. Explicitly NOT generalized now — one hardcoded source keeps the trust story trivial. v2's envelope is already the format they'd share.
- **A "check for preset updates" nudge** *only if* real usage shows the add-flow-only moment is too late (e.g. users add a model, get bundled config, and never re-run Auto-Configure). One dashboard item, reusing `presetRemote.ts`. Not before evidence.
- If community preset PRs arrive: the drift test + envelope guard are the review surface — CI failing on a list/file mismatch or an out-of-schema key in a PR diff is the review assistant.

## 12. Reference implementation sketch (the "is it really this small?" proof)

The entire remote surface — list fetch, pre-match, guard, single-file fetch.
~70 lines, zero state, never throws:

```ts
// src/presetRemote.ts
import type { ModelPreset } from './commands/presets.js';

const BASE = 'https://raw.githubusercontent.com/fuzzifikation/vLLM-Copilot/main/model-configs';
const TIMEOUT_MS = 2000, MAX_BYTES = 64 * 1024, LIST_SCHEMA = 1, PRESET_VERSION = 1;

/** config keys a remote preset may set — everything else rejects the whole file (§7). */
const CONFIG_KEYS = new Set(['displayName', 'family', 'vllmModelId', 'maxOutputTokens',
  'maxInputTokens', 'capabilities', 'modelModes', 'defaultMode', 'defaultParams', 'estimateCharsPerToken']);

interface ListEntry { match: string[]; file: string }

async function getJson(url: string, signal: AbortSignal): Promise<unknown | undefined> {
  try {
    const res = await fetch(url, { signal });
    if (!res.ok) return undefined;
    const buf = await res.arrayBuffer();
    return buf.byteLength <= MAX_BYTES ? JSON.parse(new TextDecoder().decode(buf)) : undefined;
  } catch { return undefined; }           // offline/timeout/bad JSON → undefined, never throws
}

/** Same case-insensitive substring rule as findPresetForModel, over list entries. */
function longestListMatch(list: ListEntry[], modelId: string, root?: string): ListEntry | undefined {
  const hays = [modelId.toLowerCase(), root?.toLowerCase()].filter(x => x !== undefined);
  let best: ListEntry | undefined, bestLen = -1;
  for (const e of list) {
    if (!/^[^/\\]+\.json$/.test(e.file ?? '')) continue;             // bare filename or nothing
    for (const m of e.match ?? []) {
      const mL = String(m).toLowerCase();
      if (mL && hays.some(h => h.includes(mL)) && mL.length > bestLen) { best = e; bestLen = mL.length; }
    }
  }
  return best;
}

/**
 * Live preset lookup: list → (winner only) preset file → guard.
 * Returns a remote ModelPreset or undefined. Every failure path is undefined.
 */
export async function fetchRemotePreset(
  modelId: string, root: string | undefined, cancel: AbortSignal,
  log: (msg: string) => void,
): Promise<ModelPreset | undefined> {
  const signal = AbortSignal.any([AbortSignal.timeout(TIMEOUT_MS), cancel]); // §5: bound + respect cancel

  const list = await getJson(`${BASE}/index.json`, signal) as
    { schemaVersion?: number; presets?: ListEntry[] } | undefined;
  if (!list || (list.schemaVersion ?? 1) > LIST_SCHEMA) return undefined;    // future format → skip
  const hit = longestListMatch(list.presets ?? [], modelId, root);
  if (!hit) return undefined;                                               // miss — ~1 KB total cost

  const raw = await getJson(`${BASE}/${hit.file}`, signal) as Record<string, unknown> | undefined;
  if (!raw || raw.presetVersion !== PRESET_VERSION) return undefined;       // legacy/unknown → remote files must be v2
  const cfg = raw.config as Record<string, unknown> | undefined;
  const meta = raw.meta as Record<string, unknown> | undefined;
  if (!cfg || !meta) return undefined;
  if (Object.keys(cfg).some(k => !CONFIG_KEYS.has(k))) {                    // §7: config guard, whole-file reject
    log(`[WARN] Remote preset ${hit.file} rejected: unknown config key`);
    return undefined;
  }
  // meta: unknown keys ignored (§7 asymmetric); required fields validated for display only
  return {
    config: cfg as ModelPreset['config'],
    sourceFile: `remote:${hit.file}`,
    meta: { name: String(meta.name ?? hit.file), source: meta.source as string | undefined,
            verified: meta.verified as string | undefined, notes: meta.notes as string | undefined },
  };
}
```

Call site — `hfDiscovery.ts`, the whole integration (parallel start, awaited at selection):

```ts
const remotePreset = fetchRemotePreset(modelId, root, token, log);  // ← fire alongside HF discovery
// … existing server probe / HF discovery continues …
const remote = await remotePreset;                                   // already settled by now
const presets = remote ? [remote, ...bundled] : bundled;             // array order = remote-wins ties (§6)
const preset = findPresetForModel(presets, modelId, root);           // unchanged
```

`ModelPreset` gains one optional field (`meta?`) that the confirm dialog renders when present — which bundled presets also fill after the v2 migration, so the UI has no remote/bundled branch.

That's it: no class, no cache, no settings, no commands, no disposal. If the real implementation drifts much above this shape, the reviewer's answer is "delete the drift."
