// Model Settings Webview - runs inside webview iframe
// Receives data via postMessage from extension

(function() {
  'use strict';

  const vscode = acquireVsCodeApi();
  let S = { servers: [], selServer: '', selModel: '', mc: null, knownParams: {}, personalities: [], activePersonalities: {} };
  const secState = {};

  // Dirty tracking: the form is a draft over the persisted config (S.servers).
  // Any edit marks it dirty; render() (Revert, a server/model switch, or a host
  // refresh after save) resets it. Save All / Revert are enabled only while dirty.
  let dirty = false;
  function markDirty() { if (!dirty) { dirty = true; setDirtyUI(); } }
  function setDirtyUI() {
    const status = document.getElementById('dirtyStatus');
    const saveBtn = document.getElementById('saveBtn');
    const revertBtn = document.getElementById('revertBtn');
    if (status) { status.textContent = dirty ? '\u25CF Unsaved changes' : ''; status.classList.toggle('dirty', dirty); }
    if (saveBtn) saveBtn.disabled = !dirty;
    if (revertBtn) revertBtn.disabled = !dirty;
  }
  // Routing mode only applies when routing is Auto. Called on render (initial
  // paint) and whenever the Provider dropdown changes, so the Routing dropdown
  // tracks the LIVE provider selection instead of the last-saved config.
  function syncRoutingMode() {
    const provider = document.querySelector('select[data-f="provider"]');
    const routing = document.querySelector('select[data-f="routingMode"]');
    const hint = document.getElementById('routingHint');
    if (!provider || !routing) return;
    const pinned = provider.value !== '';
    routing.disabled = pinned;
    if (hint) hint.hidden = !pinned;
  }
  // Field edits bubble input/change from inside #root. Navigation and auto-applied
  // controls are excluded: the server/model selects (their re-render resets dirty)
  // and the personality dropdown + capture toggle (auto-save via their own handlers).
  // Modal inputs live outside #root, so they are naturally excluded.
  document.addEventListener('input', e => {
    if (e.target.closest && e.target.closest('#root') && !e.target.closest('#sSel, #mSel, #personalitySel, #captureCb')) markDirty();
  });
  document.addEventListener('change', e => {
    if (e.target.closest && e.target.closest('#root') && !e.target.closest('#sSel, #mSel, #personalitySel, #captureCb')) markDirty();
  });

  // Set before posting a 'save' and consumed by the next 'data' message. A save is
  // answered with a full re-render (the form then reflects persisted state and the
  // dirty indicator resets). Any OTHER 'data' message — an auto-applied personality
  // change, or a models write from another command (auto-configure, add/remove model,
  // Set Personality) — must NOT wipe an open draft: when the form is dirty, state is
  // merged and the draft preserved instead of re-rendering. The decision is made on
  // live state at message time (not a one-shot flag), so it cannot misfire under
  // concurrent refreshes.
  let pendingSave = false;

  // Wait for data from extension
  window.addEventListener('message', e => {
    // A failed save: the extension answers with 'save-failed' (no 'data' refresh
    // follows, so `pendingSave` would otherwise stay set and the NEXT unrelated
    // 'data' message would be misread as the save's answer and wipe the draft).
    // Clear the stale flag and re-arm the dirty indicator WITHOUT touching field
    // values — the user's unsaved edits stay put, and a later external refresh
    // correctly merges instead of discarding them.
    if (e.data && e.data.type === 'save-failed') {
      pendingSave = false;
      markDirty();
      return;
    }
    if (e.data && e.data.type === 'data') {
      // Preserve the user's current server/model selection across refreshes —
      // the host always posts the first server/first model, which would reset
      // the dropdown to #1 after e.g. applying a personality to a lower model.
      // Fall back to the posted values only when the current selection is gone.
      const prevServer = S.selServer;
      const prevModel = S.selModel;
      S.servers = e.data.servers;
      S.selServer = S.servers.some(s => s.key === prevServer) ? prevServer : e.data.selectedServerKey;
      const sv = S.servers.find(s => s.key === S.selServer);
      const modelExists = !!sv && [...(sv.models || []).map(m => m.id || m.vllmModelId), ...(sv.serverModelIds || [])].includes(prevModel);
      S.selModel = modelExists ? prevModel : e.data.selectedModelId;
      S.knownParams = e.data.knownParams || {};
      S.providersByModel = e.data.providersByModel || {};
      S.personalities = e.data.personalities || [];
      S.activePersonalities = e.data.activePersonalities || {};
      S.systemMessageCapture = e.data.systemMessageCapture === true;
      // External change while the form is dirty (unsaved edits) must not be wiped by
      // a full re-render. After a 'save' (pendingSave), or when the form is clean,
      // re-render so the form reflects the latest persisted state.
      const keepDraft = dirty && !pendingSave;
      pendingSave = false;
      if (keepDraft) {
        // Merge the new baseline + active-personality label without rebuilding the
        // form, so the rest of the draft (unsaved edits) is not discarded.
        const activeName = S.activePersonalities[S.selModel];
        const pSel = document.getElementById('personalitySel');
        const hint = pSel && !pSel.disabled ? document.querySelector('.personality-card .field-hint') : null;
        if (hint) hint.textContent = activeName ? 'Active: ' + activeName : 'Copilot\'s original system prompt';
      } else {
        try { render(); } catch(err) {
          document.getElementById('root').innerHTML = '<p style="color:var(--vscode-errorForeground)">Render error: ' + E(err.message) + '</p>';
        }
      }
    }
  });
  vscode.postMessage({ type: 'ready' });

  function E(s) { const d = document.createElement('div'); d.textContent = s; return d.innerHTML; }

  // Compact token-count label for provider rows: 32768 → "32.8k", 131072 →
  // "131k", 1000000 → "1M". Whole units when ≥ 100 (no noisy decimals), one
  // decimal below, a trailing ".0" is never shown, and a near-1M value rolls
  // to "1M" (999500+ → "1M", same as the dashboard's fmtCount). null/0 → null.
  // Kept tiny — these are informational annotations on a dropdown option, not
  // precise accounting.
  function fmtTok(n) {
    if (typeof n !== 'number' || !isFinite(n) || n <= 0) return null;
    const fmt = (v) => (v >= 100 ? String(Math.round(v)) : String(Math.round(v * 10) / 10));
    if (n >= 1e6) return fmt(n / 1e6) + 'M';
    if (n >= 1e3) {
      const k = n / 1e3;
      if (k >= 1000) return fmt(k / 1000) + 'M'; // 999,500+ → "1M"
      return fmt(k) + 'k';
    }
    return String(n);
  }
  // The provider's limits as a compact suffix for the dropdown option, e.g.
  // " · Ctx (131k tot, 2k out)". Both parts are present only when the API
  // reported them — never invented. The exact numbers ride in the hover title.
  function providerLimitsLabel(ep) {
    const ctx = fmtTok(ep.contextLength);
    const out = fmtTok(ep.maxCompletionTokens);
    const parts = [];
    if (ctx) parts.push(ctx + ' tot');
    if (out) parts.push(out + ' out');
    return parts.length > 0 ? ' · Ctx (' + parts.join(', ') + ')' : '';
  }

  // Per-token USD string → per-1M USD, or null when absent/malformed/negative
  // (OpenRouter reports "-1" for unknown dynamic-router prices). Same conversion
  // as the dashboard's perMillion — mirrored here because the webview can't
  // import the TS helper.
  function perM(v) {
    if (typeof v !== 'string' || v.trim() === '') return null;
    const n = Number(v);
    if (!isFinite(n) || n < 0) return null;
    return n * 1e6;
  }
  // Compact per-1M USD: up to 4 decimals, trailing zeros trimmed ("1.2052",
  // "0.66", "3.17"). Locale-independent (always "." decimal, no grouping) —
  // same discipline as the dashboard's money display.
  function fmtUsd(v) {
    if (v === null || !isFinite(v)) return null;
    return '$' + (Math.round(v * 1e4) / 1e4).toString();
  }
  // " · Cost/M (in $0.66, out $1.98[, cache $0.12])" — only present fields are
  // shown; a provider without cache pricing simply omits it. Exact values ride
  // in the hover title (same pattern as the context/output limits).
  function providerPricingLabel(ep) {
    const p = (ep && ep.pricing) || {};
    const parts = [];
    const inRate = fmtUsd(perM(p.prompt));
    const outRate = fmtUsd(perM(p.completion));
    const cacheRate = fmtUsd(perM(p.input_cache_read));
    if (inRate) parts.push('in ' + inRate);
    if (outRate) parts.push('out ' + outRate);
    if (cacheRate) parts.push('cache ' + cacheRate);
    return parts.length > 0 ? ' · Cost/M (' + parts.join(', ') + ')' : '';
  }
  // Full-precision per-1M prices for the hover title, e.g. "prompt $1.2052/M,
  // completion $3.1655/M, cache $0.1205/M".
  function providerPricingTitle(ep) {
    const p = (ep && ep.pricing) || {};
    const parts = [];
    const inRate = perM(p.prompt);
    const outRate = perM(p.completion);
    const cacheRate = perM(p.input_cache_read);
    if (inRate !== null) parts.push('prompt $' + (Math.round(inRate * 1e6) / 1e6) + '/M');
    if (outRate !== null) parts.push('completion $' + (Math.round(outRate * 1e6) / 1e6) + '/M');
    if (cacheRate !== null) parts.push('cache $' + (Math.round(cacheRate * 1e6) / 1e6) + '/M');
    return parts.join(', ');
  }

  // Selection is keyed by server-group identity (a URL may host several header
  // identities). Messages that target a server need the real display URL.
  function selServerUrl() {
    const sv = S.servers.find(s => s.key === S.selServer) || S.servers[0];
    return sv ? sv.url : '';
  }

  function showModal(html, onOk) {
    const overlay = document.getElementById('modal');
    const body = document.getElementById('modalBody');
    body.innerHTML = html;
    overlay.classList.add('show');
    const input = body.querySelector('input');
    if (input) setTimeout(() => input.focus(), 50);
    return new Promise(resolve => {
      body.querySelector('#modalOk').onclick = () => { resolve(onOk ? onOk() : null); overlay.classList.remove('show'); };
      const cancel = body.querySelector('#modalCancel');
      if (cancel) cancel.onclick = () => { resolve(null); overlay.classList.remove('show'); };
    });
  }

  function webviewPrompt(title, defaultVal) {
    return showModal(
      '<label>' + E(title) + '</label><input type="text" id="modalInput" value="' + E(defaultVal || '') + '" />' +
      '<div class="modal-actions"><button id="modalCancel">Cancel</button><button id="modalOk">OK</button></div>',
      () => document.getElementById('modalInput').value
    );
  }

  function webviewConfirm(msg) {
    return showModal(
      '<p>' + E(msg) + '</p><div class="modal-actions"><button id="modalCancel">Cancel</button><button id="modalOk">Confirm</button></div>',
      () => true
    );
  }

  function webviewAlert(msg) {
    return showModal(
      '<p>' + E(msg) + '</p><div class="modal-actions"><button id="modalOk">OK</button></div>',
      () => true
    );
  }

  function render() {
    const r = document.getElementById('root');
    if (!S.servers.length) {
      r.innerHTML = '<p class="empty-state">No servers configured. Run "Add vLLM Server & Model" first.</p>';
      return;
    }
    const sv = S.servers.find(s => s.key === S.selServer) || S.servers[0];
    if (sv.key !== S.selServer) S.selServer = sv.key;

    // Combined model list: configured models (keyed by the extension `id`) plus
    // server-reported models that have no configured entry (keyed by the server
    // model id). A server model already covered by a configured entry — either by
    // its `id` or its wire `vllmModelId` — is not listed a second time.
    const configKey = (m) => m.id || m.vllmModelId || '';
    const configKeys = new Set(sv.models.map(configKey));
    const coveredWire = new Set(sv.models.map(m => m.vllmModelId || m.id || ''));
    const allOptions = [
      ...sv.models.map(m => ({ value: configKey(m), configured: true, mc: m })),
      ...(sv.serverModelIds || [])
        .filter(serverId => !configKeys.has(serverId) && !coveredWire.has(serverId))
        .map(serverId => ({ value: serverId, configured: false, mc: {
          vllmModelId: serverId, id: serverId, serverUrl: sv.url,
          // Backend auto-detected from the server's /v1/models (max_model_len → vllm,
          // owned_by "llamacpp" → llamacpp). Absent when there's no honest signal —
          // then serverType is left unset and the select defaults to vllm.
          ...(sv.detectedServerType ? { serverType: sv.detectedServerType } : {})
        } })),
    ];

    // Find the currently selected model config, or the matching option (unconfigured stub).
    let mc = sv.models.find(m => configKey(m) === S.selModel);
    if (!mc) {
      const opt = allOptions.find(o => o.value === S.selModel);
      if (opt) mc = opt.mc;
    }
    if (!mc) {
      // The selection may be a wire id whose configured entry uses a composite id
      // (e.g. just saved an unconfigured stub — patchModelConfig derives the id).
      // Remap to that entry instead of bouncing to the first model.
      const byWire = allOptions.find(o => o.configured && (o.mc.vllmModelId || o.mc.id) === S.selModel);
      if (byWire) { mc = byWire.mc; S.selModel = byWire.value; }
    }
    if (!mc) { mc = (allOptions[0] && allOptions[0].mc) || null; if (mc) S.selModel = configKey(mc); }
    S.mc = mc;

    let h = '<div class="selector-row">';
    h += '<label>Server</label><select id="sSel">';
    // A URL may host several header identities (per-model credentials). The option
    // VALUE is the group key; the label prefers the user-set server display name,
    // falling back to the URL, disambiguated when more than one identity shares it.
    const urlCount = {};
    S.servers.forEach(s => { urlCount[s.url] = (urlCount[s.url] || 0) + 1; });
    const urlSeen = {};
    S.servers.forEach(s => {
      const n = (urlSeen[s.url] || 0) + 1;
      urlSeen[s.url] = n;
      // Prefer the user-set server display name over the URL — trimmed, and
      // never for OpenRouter relays (fixed managed endpoint, not renamable).
      const relay = (s.models || []).some(function (m) { return m && m.serverType === 'openrouter'; });
      const nm = relay ? '' : String(s.serverDisplayName || '').trim();
      const base = nm || s.url;
      const label = urlCount[s.url] > 1 ? base + ' (identity ' + n + ')' : base;
      h += '<option value="' + E(s.key) + '"' + (s.key === S.selServer ? ' selected' : '') + '>' + E(label) + '</option>';
    });
    h += '</select>';
    // Backend type: every released config is vLLM. Secondary backends are opt-in.
    // A select persists serverType; unset stays undefined (→ vLLM by policy).
    // For unconfigured server models the select is pre-set from the backend
    // auto-detected via /v1/models (max_model_len → vllm, owned_by "llamacpp" → llamacpp).
    // serverType describes the SERVER, so it sits next to the Server selector —
    // general → specific (serverType → Server → Model).
    h += '<label>Server Type</label><select id="sTypeSel" data-f="serverType">' +
      ['vllm', 'openrouter', 'llamacpp', 'lmstudio', 'ollama'].map(t =>
        '<option value="' + t + '"' + (mc.serverType === t ? ' selected' : '') + '>' + t + '</option>').join('') +
      '</select>';
    h += '<label>Model (vllmModelId)</label><select id="mSel">';
    // Option VALUE is the extension `id` (the key for personalities/settings);
    // the LABEL shows the real vllmModelId. When several presets share a wire id
    // the label is disambiguated with the composite id.
    const wireCounts = {};
    sv.models.forEach(m => { const w = m.vllmModelId || m.id || ''; wireCounts[w] = (wireCounts[w] || 0) + 1; });
    // Only when the server probe succeeded do we know what's actually running.
    // A configured model whose wire id is NOT reported by the server is stale —
    // mark it so the user can see it won't serve requests. Empty probe result
    // (unreachable / non-`/v1/models` backend) means "unknown", not "inactive".
    const knowsRunning = !!sv.serverModelIds && sv.serverModelIds.length > 0;
    allOptions.forEach(opt => {
      let label;
      if (opt.configured) {
        const wire = opt.mc.vllmModelId || opt.mc.id;
        label = wireCounts[wire] > 1 ? wire + ' (' + opt.value + ')' : wire;
        if (knowsRunning && !sv.serverModelIds.includes(wire)) {
          label += ' (inactive)';
        }
      } else {
        label = opt.value + ' (not configured)';
      }
      h += '<option value="' + E(opt.value) + '"' + (opt.value === S.selModel ? ' selected' : '') + '>' + E(label) + '</option>';
    });
    h += '</select>';

    // OpenRouter provider pinning — only for OpenRouter models. Options come
    // EXCLUSIVELY from the authoritative per-model provider list
    // (`/api/v1/models/{id}/endpoints`, fetched when Model Settings opened and
    // keyed by wire id in S.providersByModel). The option value is the exact API
    // `tag` — never derived. "Auto" (empty) = let OpenRouter route. If the list
    // is unavailable (fetch failed), only "Auto" shows; nothing is fabricated.
    if (mc.serverType === 'openrouter') {
      const wire = mc.vllmModelId || mc.id || '';
      const endpoints = (S.providersByModel || {})[wire] || [];
      h += '<label>Provider</label><select data-f="provider">';
      h += '<option value=""' + (!mc.provider ? ' selected' : '') + '>Auto</option>';
      endpoints.forEach(ep => {
        const label = ep.providerName + (ep.quantization && ep.quantization !== 'unknown' ? ' (' + ep.quantization + ')' : '');
        // Annotate each provider with its reported context window + output
        // ceiling + per-1M pricing (compact in the label, exact in the hover
        // title) so the user can pick a provider with their eyes open —
        // display-only, never saved.
        const limits = providerLimitsLabel(ep);
        const pricing = providerPricingLabel(ep);
        const titleParts = [];
        if (typeof ep.contextLength === 'number' && ep.contextLength > 0) titleParts.push(ep.contextLength.toLocaleString('en-US') + ' context');
        if (typeof ep.maxCompletionTokens === 'number' && ep.maxCompletionTokens > 0) titleParts.push(ep.maxCompletionTokens.toLocaleString('en-US') + ' max output');
        const pricingTitle = providerPricingTitle(ep);
        if (pricingTitle) titleParts.push(pricingTitle);
        const title = titleParts.length > 0 ? ' title="' + E(ep.providerName + ' — ' + titleParts.join(', ')) + '"' : '';
        h += '<option value="' + E(ep.tag) + '"' + (mc.provider === ep.tag ? ' selected' : '') + title + '>' + E(label + limits + pricing) + '</option>';
      });
      h += '</select>';
      if (endpoints.length === 0) {
        h += '<div class="field-hint">Provider list unavailable — only Auto. Check the connection and reopen Model Settings.</div>';
      }
      // Routing mode — how OpenRouter sorts among providers when routing is Auto.
      // Standard (default) = price-weighted load balancing; Nitro = throughput-first;
      // Exacto = quality/tool-calling-first. Only meaningful when no provider is
      // pinned (sorting a single provider is meaningless) — disabled then.
      // The disabled state is re-synced LIVE when the Provider dropdown changes
      // (see syncRoutingMode) so the user doesn't have to save-and-re-render to
      // pick a mode — this initial value only reflects the persisted config.
      const routingDisabled = !!mc.provider;
      h += '<label>Routing</label><select data-f="routingMode"' + (routingDisabled ? ' disabled' : '') + '>';
      h += '<option value="standard"' + (!mc.routingMode || mc.routingMode === 'standard' ? ' selected' : '') + '>Standard</option>';
      h += '<option value="nitro"' + (mc.routingMode === 'nitro' ? ' selected' : '') + '>Nitro</option>';
      h += '<option value="exacto"' + (mc.routingMode === 'exacto' ? ' selected' : '') + '>Exacto</option>';
      h += '</select>';
      h += '<div class="field-hint" id="routingHint"' + (routingDisabled ? '' : ' hidden') + '>Routing is fixed when a provider is pinned — set Provider to Auto to choose a routing mode.</div>';
    }
    h += '</div>';

    // Display name sits right after the model selector — it's the user-facing label.
    h += '<div class="field"><label>displayName</label>' +
      '<input type="text" data-f="displayName" value="' + E(String(mc.displayName || '')) + '">' +
      '<div class="field-hint">Name shown in model picker</div></div>';

    // Action buttons row — these address the model, not the personality.
    h += '<div class="action-btn-row">';
    h += '<button id="autoConfigureBtn" class="secondary">Auto-Configure</button>';
    h += '<button id="removeModelBtn" class="secondary" style="color:var(--vscode-errorForeground)">Remove Model</button>';
    h += '</div>';

    if (S.mc) {
      const m = S.mc;
      // Personality picker lives in General, alongside the model's identity fields —
      // the Auto-Configure/Remove buttons above address the model, not the personality.
      const isConfigured = configKeys.has(S.selModel);
      const activeName = S.activePersonalities[S.selModel] || '';
      // Personality dropdown (global) + raw replacements-file path + the system
      // prompt recording toggle — one section for everything that shapes the
      // system prompt a model receives.
      h += sec('Personality and System Prompt',
        personalityCard(isConfigured, activeName) +
        '<div class="field"><label>systemMessageReplacementsFile</label>' +
        '<input type="text" data-f="systemMessageReplacementsFile" value="' + E(String(m.systemMessageReplacementsFile || '')) + '">' +
        '<div class="field-hint">Path to JSON find/replace rules file (relative paths resolve against the workspace root)</div></div>' +
        '<div class="checkbox-row"><input type="checkbox" id="captureCb" ' + (S.systemMessageCapture ? 'checked' : '') + '><label>Record system prompts</label></div>' +
        '<div class="field-hint">Capture Copilot system prompts to the workspace\'s .vllm/system-messages.json — used to build replacement rules</div>');
      h += sec('Token Budget',
        '<div class="field"><label>maxOutputTokens</label>' +
        '<input type="text" data-f="maxOutputTokens" placeholder="65536, 32768, 16384" value="' + E(Array.isArray(m.maxOutputTokens) ? m.maxOutputTokens.join(', ') : String(m.maxOutputTokens ?? '')) + '">' +
        '<div class="field-hint">Max output tokens — or comma-separated choices (descending, first = default) to show the Copilot picker\'s "Output length" dropdown. Values above the model cap are hidden. Empty = default 4096</div></div>' +
        fields([{ k: 'maxInputTokens', t: 'number', v: m.maxInputTokens ?? '', h: 'Auto-computed; set to reserve headroom' },
        { k: 'estimateCharsPerToken', t: 'number', v: m.estimateCharsPerToken ?? 3.5, h: 'Avg chars/token (default: 3.5)' }]));
      h += sec('Capabilities',
        '<div class="checkbox-row"><input type="checkbox" data-k="caps.toolCalling" ' + ((m.capabilities?.toolCalling ?? true) ? 'checked' : '') + '><label>Tool Calling (default: enabled)</label></div>' +
        '<div class="checkbox-row"><input type="checkbox" data-k="caps.imageInput" ' + (!!m.capabilities?.imageInput ? 'checked' : '') + '><label>Image Input (Vision)</label></div>');
      h += sec('Request Params', '<div class="field-hint">Baseline parameters — overridden by Model Modes</div>' + dpSection(m));
      h += sec('Transport', fields([{ k: 'streamInactivityTimeout', t: 'number', v: m.streamInactivityTimeout ?? 0, h: 'SSE timeout in ms (0 = infinite)' },
        { k: 'initialResponseTimeoutMs', t: 'number', v: m.initialResponseTimeoutMs ?? 600000, h: 'First-response-header timeout in ms (0 = infinite)' },
        { k: 'autoContinueRetries', t: 'number', v: m.autoContinueRetries ?? 1, h: 'Auto-retry count (default: 1)' }]));
      h += sec('Model Modes', modesSection(m));
    }
    r.innerHTML = h;

    if (S.mc) {
      // Sticky action bar — pinned while scrolling the (long) form. Save All
      // commits the draft; Revert discards it and re-renders from persisted
      // state. Both are disabled until a field is edited (see dirty tracking).
      r.insertAdjacentHTML('afterbegin',
        '<div class="action-bar" id="actionBar">' +
        '<span id="dirtyStatus" class="dirty-status"></span>' +
        '<button id="saveBtn">Save All Changes</button>' +
        '<button class="secondary" id="revertBtn">Revert</button>' +
        '</div>');
    }

    r.querySelectorAll('details').forEach(d => {
      const title = d.dataset.sec;
      d.ontoggle = () => { if (title) secState[title] = d.open; };
    });

    document.getElementById('sSel').onchange = () => { S.selServer = document.getElementById('sSel').value; render(); };
    document.getElementById('mSel').onchange = () => { S.selModel = document.getElementById('mSel').value; render(); };
    // Routing mode only makes sense when routing is Auto. The Provider dropdown
    // and Routing dropdown are sibling fields, so react to the provider's LIVE
    // selection — no save-and-re-render needed to enable/disable routing.
    const providerSelect = document.querySelector('select[data-f="provider"]');
    if (providerSelect) {
      providerSelect.onchange = () => syncRoutingMode();
      syncRoutingMode();
    }
    const pSel = document.getElementById('personalitySel');
    if (pSel) {
      const activeName = S.activePersonalities[S.selModel] || '';
      for (let i = 0; i < pSel.options.length; i++) {
        if (pSel.options[i].dataset.name === activeName) { pSel.selectedIndex = i; break; }
      }
      updatePersonalityDesc(pSel);
      pSel.onchange = () => {
        updatePersonalityDesc(pSel);
        const opt = pSel.options[pSel.selectedIndex];
        const targetPath = opt.value; // '' for Default
        const sourcePath = opt.dataset.src || '';
        // Sync the raw systemMessageReplacementsFile input so a quick "Save All
        // Changes" writes the new value instead of the stale one.
        const pathInput = document.querySelector('[data-f="systemMessageReplacementsFile"]');
        if (pathInput) pathInput.value = targetPath;
        // The host answers with a full re-render; the data handler preserves the
        // draft (merges state) whenever the form is dirty, so no flag is needed here.
        vscode.postMessage(targetPath === ''
          ? { type: 'applyPersonality', serverUrl: selServerUrl(), id: S.selModel, clear: true }
          : { type: 'applyPersonality', serverUrl: selServerUrl(), id: S.selModel, sourcePath: sourcePath });
      };
    }
    const captureCb = document.getElementById('captureCb');
    if (captureCb) captureCb.onchange = () => {
      vscode.postMessage({ type: 'setSystemMessageCapture', enabled: captureCb.checked });
    };
    const saveButton = document.getElementById('saveBtn');
    if (saveButton) saveButton.onclick = save;
    const revertButton = document.getElementById('revertBtn');
    if (revertButton) revertButton.onclick = render;
    // A freshly rendered form reflects persisted state — nothing to save or revert.
    // Sync unconditionally (not just on a dirty→clean transition) so the buttons
    // render disabled on first paint too.
    dirty = false;
    setDirtyUI();
    const autoCfgBtn = document.getElementById('autoConfigureBtn');
    if (autoCfgBtn) autoCfgBtn.onclick = () => {
      const sv = S.servers.find(s => s.key === S.selServer);
      vscode.postMessage({
        type: 'autoConfigure',
        serverUrl: selServerUrl(),
        id: S.selModel,
        identityModelId: sv && sv.models && sv.models[0] ? configKey(sv.models[0]) : undefined,
      });
    };
    const rmBtn = document.getElementById('removeModelBtn');
    if (rmBtn) rmBtn.onclick = async () => {
      if (await webviewConfirm('Remove model "' + S.selModel + '" from ' + selServerUrl() + '?')) {
        vscode.postMessage({ type: 'removeModel', serverUrl: selServerUrl(), id: S.selModel });
      }
    };
  }

  function sec(title, body) {
    const isOpen = secState[title] !== false;
    return '<details' + (isOpen ? ' open' : '') + ' data-sec="' + E(title) + '"><summary>' + E(title) + '</summary><div class="section-body">' + body + '</div></details>';
  }

  function fields(specs) {
    return specs.map(s => '<div class="field"><label>' + E(s.k) + '</label>' +
      (s.t === 'number'
        ? '<input type="number" data-f="' + E(s.k) + '" value="' + (s.v !== '' ? s.v : '') + '" step="any">'
        : '<input type="text" data-f="' + E(s.k) + '" value="' + E(String(s.v)) + '">') +
      (s.h ? '<div class="field-hint">' + E(s.h) + '</div>' : '') +
      '</div>').join('');
  }

  function updatePersonalityDesc(pSel) {
    const descEl = document.getElementById('personalityDesc');
    if (!descEl) return;
    const opt = pSel ? pSel.options[pSel.selectedIndex] : null;
    if (opt && opt.dataset.desc) {
      descEl.textContent = opt.dataset.desc;
      descEl.style.display = '';
    } else {
      // Default (no personality) — nothing selected, nothing to describe.
      descEl.textContent = '';
      descEl.style.display = 'none';
    }
  }

  function personalityCard(isConfigured, activeName) {
    let h = '<div class="personality-card">';
    h += '<label>Personality (global)</label>';
    h += '<select id="personalitySel"' + (isConfigured ? '' : ' disabled') + '>';
    h += '<option value="" data-name="">Default (no personality)</option>';
    S.personalities.forEach(p => {
      // value = the global target path (what gets stored); data-src = source to copy from.
      // data-desc feeds the live description line under the dropdown; title keeps the
      // hover tooltip for parity with the Set Personality command.
      h += '<option value="' + E(p.targetPath) + '" data-name="' + E(p.name) + '" data-src="' + E(p.sourcePath) + '" data-desc="' + E(p.description || '') + '" title="' + E(p.description || '') + '">' + E(p.name) + '</option>';
    });
    h += '</select>';
    // Live description of the selected personality — so users know what they're
    // getting into before they commit. Updated on change and on render.
    h += '<div id="personalityDesc" class="personality-desc"></div>';
    h += '<div class="field-hint">' + (isConfigured
      ? (activeName ? 'Active: ' + E(activeName) : 'Copilot\'s original system prompt')
      : 'Configure this model first to set a personality.') + '</div>';
    h += '</div>';
    return h;
  }

  function modesSection(mc) {
    const modes = mc.modelModes || {};
    const modeNames = Object.keys(modes);
    let h = '<div class="field"><label>defaultMode</label>' +
      '<select data-f="defaultMode">' +
      '<option value="">(none)</option>' +
      modeNames.map(n => '<option value="' + E(n) + '"' + (mc.defaultMode === n ? ' selected' : '') + '>' + E(n) + '</option>').join('') +
      '</select>' +
      '<div class="field-hint">Active model mode sent to server</div></div>';
    h += '<div id="modesList">';
    for (const [name, params] of Object.entries(modes)) { h += modeCard(name, params); }
    h += '</div><button class="secondary" id="addModeBtn">+ Add Mode</button>';
    return h;
  }

  function modeCard(name, params) {
    let h = '<div class="mode-card" data-mn="' + E(name) + '">';
    h += '<div class="mode-header"><span class="mode-title">' + E(name) + '</span><div class="mode-actions">';
    h += '<button class="secondary rename-mode-btn">Rename</button>';
    h += '<button class="secondary remove-mode-btn">Remove</button>';
    h += '</div></div><div class="mode-params">';
    for (const [key, val] of Object.entries(params)) {
      const known = S.knownParams[key];
      h += '<div class="mode-param"><label>' + E(key) + '</label>' +
        (known && known.options
          ? '<select data-mk="' + E(key) + '">' +
            '<option value="">(auto)</option>' +
            known.options.map(o => '<option value="' + E(o) + '"' + (String(val) === o ? ' selected' : '') + '>' + E(o) + '</option>').join('') +
            '</select>'
          : typeof val === 'object'
            ? '<textarea data-mk="' + E(key) + '">' + E(JSON.stringify(val, null, 2)) + '</textarea>'
            : typeof val === 'string'
              ? '<input type="text" data-mk="' + E(key) + '" value="' + E(val) + '">' 
              : '<input type="number" data-mk="' + E(key) + '" value="' + E(String(val)) + '" step="any">') +
        '<button class="secondary remove-param-btn" data-mk="' + E(key) + '">⊗</button>' +
        '</div>';
    }
    h += '<div style="margin-top:4px"><button class="secondary add-mode-param-btn">+ Add Parameter</button></div>';
    h += '</div></div>';
    return h;
  }

  function dpSection(mc) {
    const dp = mc.defaultParams || {};
    let h = '<div id="dpList">';
    for (const [key, val] of Object.entries(dp)) {
      const known = S.knownParams[key];
      h += '<div class="field-param" data-dk="' + E(key) + '"><label>' + E(key) + '</label>' +
        (known && known.options
          ? '<select data-dk="' + E(key) + '">' +
            '<option value="">(auto)</option>' +
            known.options.map(o => '<option value="' + E(o) + '"' + (String(val) === o ? ' selected' : '') + '>' + E(o) + '</option>').join('') +
            '</select>'
          : typeof val === 'object'
            ? '<textarea data-dk="' + E(key) + '">' + E(JSON.stringify(val, null, 2)) + '</textarea>'
            : typeof val === 'string'
              ? '<input type="text" data-dk="' + E(key) + '" value="' + E(val) + '">' 
              : '<input type="number" data-dk="' + E(key) + '" value="' + E(String(val)) + '" step="any">') +
        '<button class="secondary remove-param-btn" data-dk="' + E(key) + '">⊗</button>' +
        '</div>';
    }
    h += '</div><button class="secondary" id="addDpBtn">+ Add Parameter</button>';
    return h;
  }

  function save() {
    const mc = S.mc;
    if (!mc) return;
    const modeCards = [...document.querySelectorAll('.mode-card')];
    const seenModeNames = new Set();
    for (const card of modeCards) {
      const name = card.dataset.mn;
      if (seenModeNames.has(name)) {
        void webviewAlert('A mode named "' + name + '" already exists. Mode names must be unique.');
        return;
      }
      seenModeNames.add(name);
    }
    const u = { ...mc };
    document.querySelectorAll('[data-f]').forEach(el => {
      const k = el.dataset.f;
      // maxOutputTokens is a number OR number[] — the generic collector would
      // store the raw string; the same input is parsed into a value after this loop.
      if (k === 'maxOutputTokens') return;
      // Empty value is an explicit CLEAR signal: `''` reaches the store, which maps
      // '' → delete for every clearable scalar field (normalizeModelEntry). A typed
      // `0` is a real value and stays (e.g. streamInactivityTimeout 0 = infinite).
      u[k] = el.type === 'number' ? (el.value === '' ? '' : Number(el.value)) : el.value;
    });
    // maxOutputTokens: scalar cap OR comma-separated vector (Output length
    // dropdown choices). One value → number; several → number[]. Empty input is
    // the '' CLEAR signal (normalizeModelEntry deletes the key → default,
    // no dropdown). An unparsable entry aborts the save rather than silently
    // dropping menu options.
    const motInput = document.querySelector('[data-f="maxOutputTokens"]');
    if (motInput) {
      const parts = motInput.value.split(',').map(s => s.trim()).filter(s => s !== '');
      const nums = parts.map(Number);
      if (nums.some(n => !Number.isInteger(n) || n <= 0)) {
        void webviewAlert('Max output tokens must be a positive whole number, or comma-separated whole numbers (e.g. 65536, 32768, 16384).');
        return;
      }
      u.maxOutputTokens = nums.length === 0 ? '' : nums.length === 1 ? nums[0] : nums;
    }
    // Routing mode is only meaningful when routing is Auto (no pinned provider).
    // If a provider is pinned, drop the mode — sorting a single provider is
    // meaningless, and the request path ignores it anyway; keep the config honest.
    if (u.provider) u.routingMode = '';
    // "Standard" is the DEFAULT — semantically identical to omitting the field
    // (config doc: `'standard'`/omitted = default price-weighted routing). Storing
    // it explicitly would pollute every Auto-routed OpenRouter config with a
    // meaningless value. Map it to the empty-string CLEAR signal → delete.
    if (u.routingMode === 'standard') u.routingMode = '';
    const caps = {};
    document.querySelectorAll('[data-k]').forEach(el => {
      if (el.dataset.k === 'caps.toolCalling') caps.toolCalling = el.checked;
      if (el.dataset.k === 'caps.imageInput') caps.imageInput = el.checked;
    });
    u.capabilities = { toolCalling: true, ...caps };
    const modes = {};
    modeCards.forEach(card => {
      const pn = card.dataset.mn;
      const ps = {};
      card.querySelectorAll('[data-mk]').forEach(inp => {
        const k = inp.dataset.mk;
        let v;
        if (inp.tagName === 'TEXTAREA') v = jsonValueOrString(inp.value);
        else if (inp.tagName === 'SELECT') v = inp.value === '' ? undefined : jsonValueOrString(inp.value);
        else if (inp.type === 'text') v = inp.value || undefined;
        else v = inp.value === '' ? undefined : Number(inp.value);
        if (v !== undefined) ps[k] = v;
      });
      modes[pn] = ps;
    });
    u.modelModes = modes;
    const dp = {};
    document.querySelectorAll('[data-dk]').forEach(inp => {
      const k = inp.dataset.dk;
      let v;
      if (inp.tagName === 'TEXTAREA') v = jsonValueOrString(inp.value);
      else if (inp.tagName === 'SELECT') v = inp.value === '' ? undefined : jsonValueOrString(inp.value);
      else if (inp.type === 'text') v = inp.value || undefined;
      else v = inp.value === '' ? undefined : Number(inp.value);
      if (v !== undefined) dp[k] = v;
    });
    u.defaultParams = Object.keys(dp).length ? dp : ''; // '' = explicit clear (all params removed)
    u.serverUrl = selServerUrl();
    u.vllmModelId = mc.vllmModelId || mc.id;
    u.id = mc.id || mc.vllmModelId;
    pendingSave = true;
    vscode.postMessage({ type: 'save', config: u });
  }

  function jsonValueOrString(s) {
    try { return JSON.parse(s); } catch { return s; }
  }

  function modeNameExists(name, excludedCard) {
    return [...document.querySelectorAll('.mode-card')]
      .some(card => card !== excludedCard && card.dataset.mn === name);
  }

  // Event delegation for dynamically created buttons
  document.addEventListener('click', e => {
    const btn = e.target.closest('button');
    if (!btn) return;
    if (btn.id === 'addModeBtn') { addMode(); e.preventDefault(); return; }
    if (btn.id === 'addDpBtn') { addDp(); e.preventDefault(); return; }
    if (btn.classList.contains('rename-mode-btn')) { renameMode(btn); e.preventDefault(); return; }
    if (btn.classList.contains('remove-mode-btn')) { removeMode(btn); e.preventDefault(); return; }
    if (btn.classList.contains('add-mode-param-btn')) { addModeParam(btn); e.preventDefault(); return; }
    if (btn.classList.contains('remove-param-btn')) { removeParam(btn); e.preventDefault(); return; }
  });

  async function addMode() {
    const name = (await webviewPrompt('Mode name (e.g. "Think", "Coding"):') || '').trim();
    if (!name) return;
    if (modeNameExists(name)) {
      await webviewAlert('A mode named "' + name + '" already exists.');
      return;
    }
    document.getElementById('modesList').insertAdjacentHTML('beforeend', modeCard(name, {}));
    markDirty();
  }
  async function renameMode(btn) {
    const card = btn.closest('.mode-card');
    const old = card.dataset.mn;
    const nw = (await webviewPrompt('New mode name:', old) || '').trim();
    if (!nw || nw === old) return;
    if (modeNameExists(nw, card)) {
      await webviewAlert('A mode named "' + nw + '" already exists.');
      return;
    }
    card.dataset.mn = nw;
    card.querySelector('.mode-title').textContent = nw;
    markDirty();
  }
  async function removeMode(btn) {
    const card = btn.closest('.mode-card');
    if (await webviewConfirm('Remove mode "' + card.dataset.mn + '"?')) { card.remove(); markDirty(); }
  }
  async function addModeParam(btn) {
    const card = btn.closest('.mode-card');
    const used = [...card.querySelectorAll('[data-mk]')].map(el => el.dataset.mk);
    const avail = Object.entries(S.knownParams).filter(([k]) => !used.includes(k));
    if (!avail.length) {
      const k = (await webviewPrompt('Parameter name:') || '').trim();
      if (!k) return;
      if (used.includes(k)) {
        await webviewAlert('Parameter "' + k + '" already exists in this mode.');
        return;
      }
      insertMP(card, k, 'number');
      markDirty();
      return;
    }
    const pick = await webviewParamPick(avail);
    if (!pick) return;
    if (pick.info.options) {
      insertMP(card, pick.key, 'select', pick.info.label, pick.info.options);
    } else {
      insertMP(card, pick.key, pick.info.type === 'json' ? 'textarea' : pick.info.type === 'string' ? 'text' : 'number', pick.info.label);
    }
    markDirty();
  }
  function insertMP(card, key, type, label, options) {
    const cont = card.querySelector('.mode-params');
    const div = document.createElement('div'); div.className = 'mode-param';
    div.innerHTML = '<label>' + E(label || key) + '</label>' +
      (type === 'textarea' ? '<textarea data-mk="' + E(key) + '">{}</textarea>' :
       type === 'select' && options
         ? '<select data-mk="' + E(key) + '">' +
           '<option value="">(auto)</option>' +
           options.map(o => '<option value="' + E(o) + '">' + E(o) + '</option>').join('') +
           '</select>'
         : type === 'text' ? '<input type="text" data-mk="' + E(key) + '">' :
         '<input type="number" data-mk="' + E(key) + '" step="any">') +
      '<button class="secondary remove-param-btn">⊗</button>';
    cont.appendChild(div);
  }
  function removeParam(btn) {
    const el = btn.closest('.mode-param, .field-param');
    if (el) { el.remove(); markDirty(); }
  }
  async function addDp() {
    const used = [...document.querySelectorAll('[data-dk]')].map(el => el.dataset.dk);
    const avail = Object.entries(S.knownParams).filter(([k]) => !used.includes(k));
    const pick = await webviewParamPick(avail);
    if (!pick) return;
    const list = document.getElementById('dpList');
    const div = document.createElement('div'); div.className = 'field-param'; div.dataset.dk = pick.key;
    if (pick.info.type === 'json')
      div.innerHTML = '<label>' + E(pick.info.label) + '</label><textarea data-dk="' + E(pick.key) + '">{}</textarea>' +
        '<button class="secondary remove-param-btn" data-dk="' + E(pick.key) + '">⊗</button>';
    else if (pick.info.options)
      div.innerHTML = '<label>' + E(pick.info.label) + '</label><select data-dk="' + E(pick.key) + '">' +
        '<option value="">(auto)</option>' +
        pick.info.options.map(o => '<option value="' + E(o) + '">' + E(o) + '</option>').join('') +
        '</select>' +
        '<button class="secondary remove-param-btn" data-dk="' + E(pick.key) + '">⊗</button>';
    else if (pick.info.type === 'string')
      div.innerHTML = '<label>' + E(pick.info.label) + '</label><input type="text" data-dk="' + E(pick.key) + '">' +
        '<button class="secondary remove-param-btn" data-dk="' + E(pick.key) + '">⊗</button>';
    else
      div.innerHTML = '<label>' + E(pick.info.label) + '</label><input type="number" data-dk="' + E(pick.key) + '" step="any">' +
        '<button class="secondary remove-param-btn" data-dk="' + E(pick.key) + '">⊗</button>';
    list.appendChild(div);
    markDirty();
  }
  function webviewParamPick(avail) {
    let html = '<label>Known Parameters</label><select id="modalInput">';
    avail.forEach(([k, info], i) => { html += '<option value="' + i + '">' + E(info.label || k) + '</option>'; });
    html += '</select>' +
      '<div class="modal-actions"><button id="modalCancel">Cancel</button><button id="modalOk">OK</button></div>';
    return showModal(html, () => {
      const sel = document.getElementById('modalInput');
      const i = parseInt(sel.value);
      if (i >= 0 && i < avail.length) return { key: avail[i][0], info: avail[i][1] };
      return null;
    });
  }
})();
