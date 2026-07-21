// Server Settings Webview - runs inside webview iframe
// Receives data via postMessage from extension

(function() {
  'use strict';

  const vscode = acquireVsCodeApi();
  let S = { servers: [], selServer: '', selModel: '', mc: null, knownParams: {} };
  const secState = {};

  // Wait for data from extension
  window.addEventListener('message', e => {
    if (e.data && e.data.type === 'data') {
      S.servers = e.data.servers;
      S.selServer = e.data.selectedServerUrl;
      S.selModel = e.data.selectedModelVllmId;
      S.knownParams = e.data.knownParams || {};
      try { render(); } catch(err) {
        document.getElementById('root').innerHTML = '<p style="color:var(--vscode-errorForeground)">Render error: ' + E(err.message) + '</p>';
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
      body.querySelector('#modalCancel').onclick = () => { resolve(null); overlay.classList.remove('show'); };
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

  function render() {
    const r = document.getElementById('root');
    if (!S.servers.length) {
      r.innerHTML = '<p class="empty-state">No servers configured. Run "Add vLLM Server & Model" first.</p>';
      return;
    }
    const sv = S.servers.find(s => s.url === S.selServer) || S.servers[0];
    if (sv.url !== S.selServer) S.selServer = sv.url;

    // Build combined model list: configured models + all server models
    const configuredIds = new Set(sv.models.map(m => m.vllmModelId || m.id));
    const allModelIds = [...new Set([...configuredIds, ...(sv.serverModelIds || [])])];

    // Find currently selected model config or create stub for unconfigured
    let mc = sv.models.find(m => (m.vllmModelId || m.id) === S.selModel);
    if (!mc && allModelIds.includes(S.selModel)) {
      // Unconfigured model - create stub
      mc = { vllmModelId: S.selModel, id: S.selModel, serverUrl: sv.url };
    }
    if (!mc) { mc = sv.models[0] || { vllmModelId: allModelIds[0], id: allModelIds[0], serverUrl: sv.url }; S.selModel = mc.vllmModelId || mc.id || ''; }
    S.mc = mc;

    let h = '<div class="selector-row">';
    h += '<label>Server</label><select id="sSel">';
    S.servers.forEach(s => { h += '<option' + (s.url === S.selServer ? ' selected' : '') + '>' + E(s.url) + '</option>'; });
    h += '</select>';
    h += '<label>Model</label><select id="mSel">';
    allModelIds.forEach(id => {
      const configured = sv.models.find(m => (m.vllmModelId || m.id) === id);
      const lbl = configured ? (configured.displayName || id) : id;
      const hint = configured ? '' : ' (not configured)';
      h += '<option value="' + E(id) + '"' + (id === S.selModel ? ' selected' : '') + '>' + E(lbl + hint) + '</option>';
    });
    h += '</select></div>';

    if (S.mc) {
      const m = S.mc;
      h += sec('General', fields([{ k: 'displayName', t: 'text', v: m.displayName || '', h: 'Name shown in model picker' },
        { k: 'vllmModelId', t: 'text', v: m.vllmModelId || m.id || '', h: 'Model ID on vLLM server' }]));
      h += sec('Token Budget', fields([{ k: 'maxOutputTokens', t: 'number', v: m.maxOutputTokens ?? 4096, h: 'Max output tokens (default: 4096)' },
        { k: 'maxInputTokens', t: 'number', v: m.maxInputTokens ?? '', h: 'Auto-computed; set to reserve headroom' },
        { k: 'estimateCharsPerToken', t: 'number', v: m.estimateCharsPerToken ?? 3.5, h: 'Avg chars/token (default: 3.5)' }]));
      h += sec('Capabilities',
        '<div class="checkbox-row"><input type="checkbox" data-k="caps.toolCalling" ' + ((m.capabilities?.toolCalling ?? true) ? 'checked' : '') + '><label>Tool Calling (default: enabled)</label></div>' +
        '<div class="checkbox-row"><input type="checkbox" data-k="caps.imageInput" ' + (!!m.capabilities?.imageInput ? 'checked' : '') + '><label>Image Input (Vision)</label></div>');
      h += sec('Model Modes', modesSection(m));
      h += sec('Request Params', dpSection(m));
      h += sec('Transport', fields([{ k: 'streamInactivityTimeout', t: 'number', v: m.streamInactivityTimeout ?? 0, h: 'SSE timeout in ms (0 = infinite)' },
        { k: 'autoContinueRetries', t: 'number', v: m.autoContinueRetries ?? 1, h: 'Auto-retry count (default: 1)' }]));
      h += sec('System Prompt',
        '<div class="field"><label>systemMessageReplacementsFile</label>' +
        '<input type="text" data-f="systemMessageReplacementsFile" value="' + E(String(m.systemMessageReplacementsFile || '')) + '">' +
        '<div class="field-hint">Path to JSON find/replace rules file</div></div>' +
        '<button class="secondary" id="personalityBtn" style="margin-top:6px">Set Personality...</button>');
      h += '<div class="btn-row"><button id="saveBtn">Save All Changes</button></div>';
    }
    r.innerHTML = h;

    r.querySelectorAll('details').forEach(d => {
      const title = d.dataset.sec;
      d.ontoggle = () => { if (title) secState[title] = d.open; };
    });

    document.getElementById('sSel').onchange = () => { S.selServer = document.getElementById('sSel').value; render(); };
    document.getElementById('mSel').onchange = () => { S.selModel = document.getElementById('mSel').value; render(); };
    const saveButton = document.getElementById('saveBtn');
    if (saveButton) saveButton.onclick = save;
    const personalityButton = document.getElementById('personalityBtn');
    if (personalityButton) personalityButton.onclick = () => vscode.postMessage({ type: 'setPersonality', serverUrl: S.selServer, vllmModelId: S.selModel });
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
    h += '<button class="danger remove-mode-btn">Remove</button>';
    h += '</div></div><div class="mode-params">';
    for (const [key, val] of Object.entries(params)) {
      h += '<div class="mode-param"><label>' + E(key) + '</label>' +
        (typeof val === 'object'
          ? '<textarea data-mk="' + E(key) + '">' + E(JSON.stringify(val, null, 2)) + '</textarea>'
          : '<input type="number" data-mk="' + E(key) + '" value="' + E(String(val)) + '" step="any">') +
        '<button class="danger remove-param-btn" data-mk="' + E(key) + '">⊗</button>' +
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
      h += '<div class="field-param" data-dk="' + E(key) + '"><label>' + E(key) + '</label>' +
        (typeof val === 'object'
          ? '<textarea data-dk="' + E(key) + '">' + E(JSON.stringify(val, null, 2)) + '</textarea>'
          : '<input type="number" data-dk="' + E(key) + '" value="' + E(String(val)) + '" step="any">') +
        '<button class="danger remove-param-btn" data-dk="' + E(key) + '">⊗</button>' +
        '</div>';
    }
    h += '</div><button class="secondary" id="addDpBtn">+ Add Parameter</button>';
    return h;
  }

  function save() {
    const mc = S.mc;
    if (!mc) return;
    const u = { ...mc };
    document.querySelectorAll('[data-f]').forEach(el => {
      const k = el.dataset.f;
      let v = el.type === 'number' ? (el.value === '' ? undefined : Number(el.value)) : el.value;
      if (v === '') v = undefined;  // empty select = no value
      if (v === undefined) delete u[k]; else u[k] = v;
    });
    const caps = {};
    document.querySelectorAll('[data-k]').forEach(el => {
      if (el.dataset.k === 'caps.toolCalling') caps.toolCalling = el.checked;
      if (el.dataset.k === 'caps.imageInput') caps.imageInput = el.checked;
    });
    u.capabilities = { toolCalling: true, ...caps };
    const modes = {};
    document.querySelectorAll('.mode-card').forEach(card => {
      const pn = card.dataset.mn;
      const ps = {};
      card.querySelectorAll('[data-mk]').forEach(inp => {
        const k = inp.dataset.mk;
        let v = inp.tagName === 'TEXTAREA' ? (tryJSON(inp.value) || inp.value) : (inp.value === '' ? undefined : Number(inp.value));
        if (v !== undefined) ps[k] = v;
      });
      modes[pn] = ps;
    });
    u.modelModes = modes;
    const dp = {};
    document.querySelectorAll('[data-dk]').forEach(inp => {
      const k = inp.dataset.dk;
      let v = inp.tagName === 'TEXTAREA' ? (tryJSON(inp.value) || inp.value) : (inp.value === '' ? undefined : Number(inp.value));
      if (v !== undefined) dp[k] = v;
    });
    u.defaultParams = Object.keys(dp).length ? dp : undefined;
    u.serverUrl = S.selServer;
    u.vllmModelId = mc.vllmModelId || mc.id;
    u.id = mc.id;
    vscode.postMessage({ type: 'save', config: u });
  }

  function tryJSON(s) { try { return JSON.parse(s); } catch { return null; } }

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
    const name = await webviewPrompt('Mode name (e.g. "Think", "Coding"):');
    if (!name) return;
    document.getElementById('modesList').insertAdjacentHTML('beforeend', modeCard(name, {}));
  }
  async function renameMode(btn) {
    const card = btn.closest('.mode-card');
    const old = card.dataset.mn;
    const nw = await webviewPrompt('New mode name:', old);
    if (nw && nw !== old) { card.dataset.mn = nw; card.querySelector('.mode-title').textContent = nw; }
  }
  async function removeMode(btn) {
    const card = btn.closest('.mode-card');
    if (await webviewConfirm('Remove mode "' + card.dataset.mn + '"?')) card.remove();
  }
  async function addModeParam(btn) {
    const card = btn.closest('.mode-card');
    const used = [...card.querySelectorAll('[data-mk]')].map(el => el.dataset.mk);
    const avail = Object.entries(S.knownParams).filter(([k]) => !used.includes(k));
    if (!avail.length) { const k = await webviewPrompt('Parameter name:'); if (k) insertMP(card, k, 'number'); return; }
    const pick = await webviewParamPick(avail);
    if (!pick) return;
    insertMP(card, pick.key, pick.info.type === 'json' ? 'textarea' : 'number', pick.info.label);
  }
  function insertMP(card, key, type, label) {
    const cont = card.querySelector('.mode-params');
    const div = document.createElement('div'); div.className = 'mode-param';
    div.innerHTML = '<label>' + E(label || key) + '</label>' +
      (type === 'textarea' ? '<textarea data-mk="' + E(key) + '">{}</textarea>' : '<input type="number" data-mk="' + E(key) + '" step="any">') +
      '<button class="danger remove-param-btn">⊗</button>';
    cont.appendChild(div);
  }
  function removeParam(btn) {
    btn.closest('.mode-param, .field-param')?.remove();
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
        '<button class="danger remove-param-btn" data-dk="' + E(pick.key) + '">⊗</button>';
    else
      div.innerHTML = '<label>' + E(pick.info.label) + '</label><input type="number" data-dk="' + E(pick.key) + '" step="any">' +
        '<button class="danger remove-param-btn" data-dk="' + E(pick.key) + '">⊗</button>';
    list.appendChild(div);
  }
  function webviewParamPick(avail) {
    let html = '<label>Known Parameters</label><select id="modalInput">';
    avail.forEach(([k, info], i) => { html += '<option value="' + i + '">' + E(info.label || k) + '</option>'; });
    html += '</select><div class="field-hint" style="margin-top:4px">or type "0" for custom</div>' +
      '<div class="modal-actions"><button id="modalCancel">Cancel</button><button id="modalOk">OK</button></div>';
    return showModal(html, () => {
      const sel = document.getElementById('modalInput');
      const i = parseInt(sel.value);
      if (i >= 0 && i < avail.length) return { key: avail[i][0], info: avail[i][1] };
      return null;
    });
  }
})();