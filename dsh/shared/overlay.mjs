/**
 * Single source of truth for the bridge's dsh overlay. Consumed by
 * `scripts/generate-overlay.mjs` (CLI, plain node, no build) and by the
 * extension at runtime (dynamic import off `context.extensionPath`). Both must
 * agree on which rows are privacy rows and how the default-model row is
 * rewritten, so there is exactly one copy of that list, here.
 *
 * Input is `dsh --dump-config` output. Every emitted row id is checked against
 * the composed tree: dsh's semver is decorative, so a vanished or renamed row
 * must fail loudly rather than compose a profile that quietly keeps phoning
 * home or points at the wrong provider.
 *
 * Patch semantics (certified against 0.2.0-rc.2): an override entry replaces
 * the WHOLE `config` of the targeted row. Restating `agent-default-model`
 * therefore has to carry every key it already had, not just provider+model, or
 * a future key added upstream would be silently dropped from the composed tree.
 */

/**
 * Rows that reach a DeepSeek service or export telemetry. Verified against the
 * 0.2.0-rc.2 packages, not against their names: each maps to a bundle holding
 * `deepseek.com` endpoints or an OTLP exporter.
 *
 * `otel` and `credentials` stay enabled on purpose: the first is the SDK the
 * exporters plug into (no exporter, no egress, and disabling it breaks rows
 * that inject it), the second is `dsh-credentials-local`, a local store.
 */
export const PRIVACY_ROWS = [
  'deepseek-account', // dsh-deepseek-account-platform: account/login platform endpoints
  'llm-deepseek', // api-key-backed DeepSeek provider: must not be reachable at all
  'llm-deepseek-account', // same provider, account-bound
  'session-log-deepseek', // session transcripts to DeepSeek
  'plugin-package-inventory-deepseek', // installed-plugin inventory to DeepSeek
  'web-search-deepseek', // web search queries to DeepSeek (default searchProvider)
  'session-telemetry-otel', // OTLP session telemetry exporter
  'desktop-product-telemetry', // OTLP product telemetry (present only in web/desktop compositions)
]

/**
 * Rows that exist only to serve a disabled feature. Disabling the service rows
 * above without these leaves the composition warning `pending (waiting for
 * service: deepseekAccount)` on every single boot, which trains the user to
 * ignore warnings; disabling the dependents composes the tree clean. Verified
 * against the 0.2.0-rc.2 web composition, where `account-controller` was the
 * one entry left dangling by disabling `deepseek-account`.
 */
export const DEPENDENT_ROWS = [
  'account-controller',
  'ui-settings-account',
]

export const DEFAULT_MODEL_ROW = 'agent-default-model'

/**
 * The Preview Notice row and the acknowledgement the client renders against.
 * Upstream gates the notice on `ui-settings-general.welcomeNoticeVersion`
 * equalling `WELCOME_NOTICE_VERSION` exactly (certified in
 * `@deepseek-ai/dsh-client-ui-settings-models/lib/client.js`, welcome-store),
 * and its Continue button persists through a settings path that never sticks
 * in a no-account profile: the ack has failed silently in every bridge
 * composition since the first boot (the owner has seen "The acknowledgement
 * could not be saved" for as long as this extension exists). The row config
 * is a legitimate patch target, so the bridge states the acknowledgement the
 * owner ruled to give: the notice stops rendering instead of nagging behind a
 * button that cannot work. Bump `version` together with the dsh pin whenever
 * upstream bumps their notice constant, or the notice reappears.
 */
export const WELCOME_NOTICE_ROW = 'ui-settings-general'
export const WELCOME_NOTICE_ACK_FIELD = 'welcomeNoticeVersion'
export const WELCOME_NOTICE_ACK_VERSION = '2026-09-28.1'

/**
 * Agent presets that get the bridge's editor tool surface as an extra child
 * plugin. The child is dsh's OWN `dsh-mcp-client`: it dials the bridge's
 * loopback MCP endpoint (src/bridge/mcp.ts), so the editor tool list lives
 * entirely on the extension side and adding tool number ten touches zero
 * harness-side files. Mounting as a preset child is not optional: the `tools`
 * service exists only inside preset child fibers (verified on 0.2.0-rc.2: a
 * profile-root module can never see it), the same way the composed tree mounts
 * `dsh-plugin-manager/tools` under `preset-standard`. Restating the row
 * replaces its WHOLE config, so the emit carries the dumped config verbatim
 * and splices one child entry in right after `plugins:`.
 *
 * Every tool-bearing preset is listed, not just `standard`: the Web GUI
 * defaults its sessions to the `ptc` preset (live incident 2026-11-07: a GUI
 * session on `preset-ptc` saw zero editor tools while the overlay logged a
 * successful mount on its one preset). `preset-cordis` authors presets and
 * must be able to test the editor surface it composes. `preset-minimal` is
 * deliberately read-only-by-design and stays unmounted. Absent rows skip
 * gracefully, so a composition without the web-app presets is unaffected.
 */
export const TOOL_PRESET_ROWS = ['preset-standard', 'preset-ptc', 'preset-cordis']

/** The preset child id spliced into each row above. Doubles as the dedupe needle. */
export const MCP_PRESET_CHILD_ID = 'vllmc-editor-mcp'

/**
 * The preset child row wiring dsh's upstream MCP client to our endpoint.
 * `serverName` must match the client's /^[A-Za-z0-9_-]{1,32}$/ and stay unique
 * per agent scope. `failOnStartupError` keeps the shipped default (false): if
 * the editor is gone, the harness boots without editor tools instead of dying,
 * and reconnects on its own when the window returns.
 *
 * @param endpoint { url, token } of the loopback control server
 */
export function mcpPresetChildLines(endpoint) {
  if (!endpoint || typeof endpoint.url !== 'string' || typeof endpoint.token !== 'string') {
    throw new Error('mcpPresetChildLines requires { url, token }')
  }
  return [
    `      - id: ${MCP_PRESET_CHILD_ID}`,
    "        name: '@deepseek-ai/dsh-mcp-client'",
    '        config:',
    '          transport: streamable-http',
    '          serverName: vllmc_editor',
    `          url: ${endpoint.url}/mcp`,
    '          headers:',
    `            authorization: Bearer ${endpoint.token}`,
    // A build in the editor terminal outruns the client's default budget.
    '          toolCallTimeoutMs: 600000',
  ]
}

/**
 * Remove every \`vllmc-editor-mcp\` child (and only it) from a preset's config
 * lines, so the mount can be restated fresh. Necessary because the generated
 * rows feed the dump through the profile patch layer: the previous mount
 * travels back verbatim, carrying the token and port of the editor that
 * generated it.
 */
export function stripMcpChildLines(cfgLines) {
  const out = []
  for (let i = 0; i < cfgLines.length; i++) {
    const m = cfgLines[i].match(/^(\s*)- id: '?([\w.@-]+)'?\s*$/)
    if (!m || m[2] !== MCP_PRESET_CHILD_ID) {
      out.push(cfgLines[i])
      continue
    }
    const indent = m[1].length
    while (++i < cfgLines.length) {
      const line = cfgLines[i]
      if (line.trim() === '') continue
      if (line.match(/^\s*/)[0].length > indent) continue
      i-- // a sibling or a dedent: it survives; this loop ate only the child
      break
    }
  }
  return out
}

/**
 * Top-level row ids only: rows live at column 0 in a dump, and a nested
 * `- id:` (a preset child named like a row) must never convince the generator
 * that a privacy row exists. A false positive there skips the row's disable
 * line and phones home with a smile.
 */
export function rowIds(dumpText) {
  const ids = new Set()
  for (const line of dumpText.split(/\r?\n/)) {
    const m = line.match(/^- id:\s*'?([\w.@/-]+)'?\s*$/)
    if (m) ids.add(m[1])
  }
  return ids
}

/**
 * The literal `config:` block lines belonging to a top-level `- id:` row,
 * returned without the leading `config:` line and de-indented by two. Empty
 * when the row has no config or is absent. Text is copied verbatim so scalars,
 * nested maps, and `!!js` tags survive a regenerate unchanged.
 */
export function rowConfigLines(dumpText, rowId) {
  const lines = dumpText.split(/\r?\n/)
  let i = 0
  while (i < lines.length) {
    const m = lines[i].match(/^- id:\s*'?([\w.@/-]+)'?\s*$/)
    if (m && m[1] === rowId) break
    i++
  }
  if (i >= lines.length) return []
  const out = []
  let inConfig = false
  for (let j = i + 1; j < lines.length; j++) {
    const line = lines[j]
    if (/^- /.test(line)) break // next top-level row
    // The FIRST `config:` after the row header is the row's own (top-level
    // rows sit at column 0, so their config is indented). Deeper `config:`
    // lines belong to nested entries (preset children carry them) and must
    // travel verbatim with their children, or the carry emits orphaned map
    // keys without their parent.
    if (/^\s+config:\s*$/.test(line) && !inConfig) {
      inConfig = true
      continue
    }
    if (!inConfig) continue
    if (/^\s{4,}\S/.test(line)) {
      out.push(line) // carry config children (and any nested map) verbatim
    } else if (line.trim() === '') {
      out.push('')
    } else {
      break // dedented back to the row level
    }
  }
  while (out.length && out[out.length - 1].trim() === '') out.pop()
  return out
}

/**
 * Build the overlay text. Throws when the dump is not a dump, when no known
 * privacy row is present (composition drifted), or when the default-model row
 * is missing (we could not aim the agent, which is the whole point).
 *
 * @param dumpText `--dump-config` output
 * @param opts.provider route provider id (default the bridge's `vllmc`)
 * @param opts.model snapshot model id to aim the agent at
 * @param opts.mcpEndpoint { url, token } of the editor control channel; omit
 *   to compose a harness without editor tools (rails, headless prepares)
 */
export function buildOverlay(dumpText, { provider = 'vllmc', model, mcpEndpoint } = {}) {
  const present = rowIds(dumpText)
  if (present.size === 0) throw new Error('dump contains no row ids; is it really --dump-config output?')
  if (!model) throw new Error('buildOverlay requires a target model id')

  const lines = ['# GENERATED by the dsh bridge from --dump-config output. Do not hand-edit.']
  const disabledRows = [...new Set([...PRIVACY_ROWS, ...DEPENDENT_ROWS])]
  let disabled = 0
  const skipped = []
  for (const row of disabledRows) {
    if (!present.has(row)) {
      skipped.push(row)
      continue
    }
    lines.push(`- id: ${row}`, '  disabled: true')
    disabled++
  }
  if (disabled === 0) {
    throw new Error(
      `no known privacy row found in the dump (looked for: ${PRIVACY_ROWS.join(', ')}). ` +
        'dsh composition drifted; re-verify row ids against --dump-config before trusting this overlay.',
    )
  }
  if (!present.has(DEFAULT_MODEL_ROW)) {
    throw new Error(`row '${DEFAULT_MODEL_ROW}' not found in the dump; cannot aim the default model at ${provider}/${model}`)
  }

  // Drop only the row's OWN provider/model keys (exactly the row config's
  // indent). A deeper provider/model belongs to a nested map and must travel
  // verbatim; an indent-blind filter used to delete those silently.
  const carried = rowConfigLines(dumpText, DEFAULT_MODEL_ROW).filter(
    (l) => !/^ {4}(provider|model):/.test(l),
  )
  lines.push(
    `- id: ${DEFAULT_MODEL_ROW}`,
    '  config:',
    ...carried,
    // JSON quoting is YAML quoting: the model is a user-chosen display name,
    // and an unquoted "gpt: fast" turns the row into a broken mapping while
    // "gpt #1" truncates at the comment marker. Boot dies or aims the wrong
    // model; neither is acceptable for a name typed by a user.
    `    provider: ${JSON.stringify(provider)}`,
    `    model: ${JSON.stringify(model)}`,
  )

  // State the Preview Notice acknowledgement (owner ruling 2026-10-05, see
  // WELCOME_NOTICE_ACK_* above). Restating the row replaces its whole config,
  // so carry every other key verbatim and add only the ack field.
  if (present.has(WELCOME_NOTICE_ROW)) {
    const noticeCarried = rowConfigLines(dumpText, WELCOME_NOTICE_ROW).filter((l) => !new RegExp(`^\\s*${WELCOME_NOTICE_ACK_FIELD}:`).test(l))
    lines.push(`- id: ${WELCOME_NOTICE_ROW}`, '  config:', ...noticeCarried, `    ${WELCOME_NOTICE_ACK_FIELD}: ${WELCOME_NOTICE_ACK_VERSION}`)
  } else {
    skipped.push(`${WELCOME_NOTICE_ROW} (preview notice will nag: row absent from the dump)`)
  }

  // Mount the MCP client (and through it every editor tool) into each
  // tool-bearing preset. The rows now live in the profile's own patch layer,
  // so every dump since the first prepare already carries the previous mount:
  // it is stripped and restated fresh (the port and token rotate with the
  // editor), never skipped. Skipping it would delete the mount from the
  // regenerated layer and take the editor tools with it on prepare number two.
  const presetMounts = []
  if (!mcpEndpoint) {
    skipped.push('editor tools not mounted: no control endpoint given')
  }
  for (const row of TOOL_PRESET_ROWS) {
    if (!mcpEndpoint) break
    if (!present.has(row)) {
      skipped.push(`${row} (editor tools not mounted: preset absent)`)
      continue
    }
    const cfg = stripMcpChildLines(rowConfigLines(dumpText, row))
    const at = cfg.findIndex((l) => /^\s{4}plugins:\s*$/.test(l))
    if (at === -1) {
      skipped.push(`${row} (editor tools not mounted: no plugins list)`)
      continue
    }
    cfg.splice(at + 1, 0, ...mcpPresetChildLines(mcpEndpoint))
    lines.push(`- id: ${row}`, '  config:', ...cfg)
    presetMounts.push(row)
  }

  return { yml: lines.join('\n') + '\n', disabled, skipped, presetMounts, provider, model }
}

/**
 * The bridge's rows live in the profile's own patch layer (cordis.patch.yml),
 * between these markers, and the boot must never pass \`--patch\`: an include
 * created with a \`patches\` config is not recorded as the root Include entry,
 * and every live profile reload afterwards fails with "profile reload requires
 * the root Include entry" (upstream dsh-app-boot; docs/harness-upstream-issues.md).
 * The patch layer is also the file the plugin manager edits comment-
 * preservingly when the user toggles a plugin, so regeneration preserves
 * everything outside the generated block.
 */
export const PATCH_LAYER_START = '# >>> dsh-bridge generated layer: do not edit inside; regenerated by the bridge >>>'
export const PATCH_LAYER_END = '# <<< dsh-bridge generated layer <<<'

/**
 * Merge freshly generated rows into an existing patch file. Rows the plugin
 * manager wrote (bundle enables/disables) survive verbatim; the scaffold's
 * bare \`[]\` is dropped when rows arrive (an empty flow sequence cannot
 * coexist with block entries) and restored when nothing remains. Applying the
 * merge to its own output changes nothing.
 *
 * @param existing current file text ('' when the file is absent)
 * @param overlayYml freshly rendered rows (buildOverlay().yml)
 */
export function mergePatchLayer(existing, overlayYml) {
  const kept = []
  let skipping = false
  for (const line of String(existing ?? '').split(/\r?\n/)) {
    if (line.trimEnd() === PATCH_LAYER_START) { skipping = true; continue }
    if (line.trimEnd() === PATCH_LAYER_END) { skipping = false; continue }
    if (skipping) continue
    if (/^\[\]\s*$/.test(line)) continue // the scaffold's empty list; rows replace it
    kept.push(line)
  }
  while (kept.length && kept[kept.length - 1].trim() === '') kept.pop()
  const rows = String(overlayYml ?? '').trim()
  if (rows === '') {
    if (!kept.some((l) => l.trim() === '[]')) kept.push('[]')
    return kept.join('\n') + '\n'
  }
  const block = [PATCH_LAYER_START, ...rows.split(/\r?\n/).map((l) => l.replace(/\s+$/, '')), PATCH_LAYER_END]
  const body = kept.length ? [...kept, '', ...block] : block
  return body.join('\n') + '\n'
}
