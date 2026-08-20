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
    if (e.data && e.data.type === 'data') {
      // Preserve the user's current server/model selection across refreshes —
      // the host always posts the first server/first model, which would reset
      // the dropdown to #1 after e.g. applying a personality to a lower model.
      // Fall back to the posted values only when the current selection is gone.
      const prevServer = S.selServer;
      const prevModel = S.selModel;
      S.servers = e.data.servers;
      S.selServer = S.servers.some(s => s.url === prevServer) ? prevServer : e.data.selectedServerUrl;
      const sv = S.servers.find(s => s.url === S.selServer);
      const modelExists = !!sv && [...(sv.models || []).map(m => m.id || m.vllmModelId), ...(sv.serverModelIds || [])].includes(prevModel);
      S.selModel = modelExists ? prevModel : e.data.selectedModelId;
      S.knownParams = e.data.knownParams || {};
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
    const sv = S.servers.find(s => s.url === S.selServer) || S.servers[0];
    if (sv.url !== S.selServer) S.selServer = sv.url;

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
    S.servers.forEach(s => { h += '<option' + (s.url === S.selServer ? ' selected' : '') + '>' + E(s.url) + '</option>'; });
    h += '</select>';
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
    h += '</select></div>';

    // Display name sits right after the model selector — it's the user-facing label.
    h += '<div class="field"><label>displayName</label>' +
      '<input type="text" data-f="displayName" value="' + E(String(mc.displayName || '')) + '">' +
      '<div class="field-hint">Name shown in model picker</div></div>';

    // Backend type: every released config is vLLM. Secondary backends are opt-in.
    // A select persists serverType; unset stays undefined (→ vLLM by policy).
    // For unconfigured server models the select is pre-set from the backend
    // auto-detected via /v1/models (max_model_len → vllm, owned_by "llamacpp" → llamacpp).
    h += '<div class="field"><label>serverType</label>' +
      '<select data-f="serverType">' +
      ['vllm', 'openrouter', 'llamacpp', 'lmstudio', 'ollama'].map(t =>
        '<option value="' + t + '"' + (mc.serverType === t ? ' selected' : '') + '>' + t + '</option>').join('') +
      '</select>' +
      '<div class="field-hint">Backend serving this model. Auto-detected from /v1/models for unconfigured models; default vllm.</div></div>';

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
      h += sec('Token Budget', fields([{ k: 'maxOutputTokens', t: 'number', v: m.maxOutputTokens ?? 4096, h: 'Max output tokens (default: 4096)' },
        { k: 'maxInputTokens', t: 'number', v: m.maxInputTokens ?? '', h: 'Auto-computed; set to reserve headroom' },
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
          ? { type: 'applyPersonality', serverUrl: S.selServer, id: S.selModel, clear: true }
          : { type: 'applyPersonality', serverUrl: S.selServer, id: S.selModel, sourcePath: sourcePath });
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
    if (autoCfgBtn) autoCfgBtn.onclick = () => vscode.postMessage({ type: 'autoConfigure', serverUrl: S.selServer, id: S.selModel });
    const rmBtn = document.getElementById('removeModelBtn');
    if (rmBtn) rmBtn.onclick = async () => {
      if (await webviewConfirm('Remove model "' + S.selModel + '" from ' + S.selServer + '?')) {
        vscode.postMessage({ type: 'removeModel', serverUrl: S.selServer, id: S.selModel });
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
      // Empty value is an explicit CLEAR signal: `''` reaches the store, which maps
      // '' → delete for every clearable scalar field (normalizeModelEntry). A typed
      // `0` is a real value and stays (e.g. streamInactivityTimeout 0 = infinite).
      u[k] = el.type === 'number' ? (el.value === '' ? '' : Number(el.value)) : el.value;
    });
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
    u.serverUrl = S.selServer;
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
