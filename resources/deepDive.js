// Deep-Dive Webview — runs inside webview iframe
// Receives raw server data via postMessage, renders everything client-side.

(function () {
  'use strict';

  const vscode = acquireVsCodeApi();
  let lastData = null;
  let lastError = '';
  let lastSnapshotAt = 0;
  let histogramTooltip = null;

  // ── Message handler ──────────────────────────────────────────
  window.addEventListener('message', function (e) {
    var data = e.data;
    if (!data) return;

    if (data.type === 'data') {
      lastData = data.raw;
      // Why the server looks empty. The raw payload carries no failure info, so
      // without this an unreachable server renders as a blank panel.
      lastError = data.error || '';
      // When the payload was captured (epoch ms). A cached push from an offline
      // engine carries its fill time, so the footer never stamps stale data
      // with 'now'. 0 = no stamp known, fall back to render time.
      lastSnapshotAt = typeof data.snapshotAt === 'number' ? data.snapshotAt : 0;
      // Mirror serverSettings.js: a broken payload must paint its failure, not
      // leave the panel frozen on the previous state forever (CR-26).
      try {
        render();
      } catch (err) {
        document.getElementById('content').innerHTML =
          '<div class="error-msg">Render error: ' + E(String(err && err.message ? err.message : err)) + '</div>';
      }
      // Reset find overlay state — innerHTML replaced all DOM nodes
      if (window._findMatches) {
        window._findMatches = [];
        var fc = document.querySelector('.find-count');
        if (fc) fc.textContent = '';
      }
    }
  });

  // Tell extension we're ready
  vscode.postMessage({ type: 'ready' });

  // ── Ctrl+F Search Overlay ───────────────────────────────────
  // WebviewPanel doesn't support findWidget, so we build our own.
  (function initFindOverlay() {
    var overlay = document.createElement('div');
    overlay.id = 'find-overlay';
    overlay.style.display = 'none';
    overlay.innerHTML = '<div class="find-widget">' +
      '<input type="text" class="find-input" placeholder="Search…" spellcheck="false">' +
      '<span class="find-count"></span>' +
      '<button class="find-btn" data-action="prev" title="Previous">▲</button>' +
      '<button class="find-btn" data-action="next" title="Next">▼</button>' +
      '<button class="find-btn" data-action="close" title="Close">✕</button>' +
      '</div>';
    document.body.appendChild(overlay);

    var input = overlay.querySelector('.find-input');
    var countEl = overlay.querySelector('.find-count');
    var currentMatch = -1;

    function removeAllHighlights() {
      var marks = document.querySelectorAll('#content mark.find-match');
      for (var i = 0; i < marks.length; i++) {
        var parent = marks[i].parentNode;
        if (!parent) continue;
        parent.replaceChild(document.createTextNode(marks[i].textContent), marks[i]);
        parent.normalize();
      }
      currentMatch = -1;
    }

    function highlightAll(query) {
      removeAllHighlights();
      window._findMatches = [];
      if (!query || query.length < 1) { countEl.textContent = ''; return; }

      var content = document.getElementById('content');
      if (!content) return;

      // Collect all text nodes FIRST, then process — DOM mutation during TreeWalker is UB
      var textNodes = [];
      var walker = document.createTreeWalker(
        content,
        NodeFilter.SHOW_TEXT,
        {
          acceptNode: function (node) {
            var p = node.parentElement;
            if (p && p.tagName === 'SCRIPT') return NodeFilter.FILTER_REJECT;
            if (p && p.id === 'find-overlay') return NodeFilter.FILTER_REJECT;
            if (p && p.tagName === 'MARK') return NodeFilter.FILTER_REJECT;
            return node.textContent.toLowerCase().indexOf(query.toLowerCase()) >= 0
              ? NodeFilter.FILTER_ACCEPT
              : NodeFilter.FILTER_REJECT;
          }
        }
      );
      while (walker.nextNode()) textNodes.push(walker.currentNode);

      // Now safe to mutate — we have a static snapshot of nodes
      var qLen = query.length;
      var qLower = query.toLowerCase();
      for (var t = 0; t < textNodes.length; t++) {
        var node = textNodes[t];
        // Node may have been removed (e.g. previous iteration replaced parent)
        if (!node.parentNode) continue;
        var text = node.textContent;
        var lower = text.toLowerCase();
        var frag = document.createDocumentFragment();
        var lastIdx = 0;
        var idx = lower.indexOf(qLower, lastIdx);
        while (idx >= 0) {
          if (idx > lastIdx) frag.appendChild(document.createTextNode(text.substring(lastIdx, idx)));
          var mark = document.createElement('mark');
          mark.className = 'find-match';
          mark.textContent = text.substring(idx, idx + qLen);
          frag.appendChild(mark);
          window._findMatches.push(mark);
          lastIdx = idx + qLen;
          idx = lower.indexOf(qLower, lastIdx);
        }
        if (lastIdx < text.length) frag.appendChild(document.createTextNode(text.substring(lastIdx)));
        node.parentNode.replaceChild(frag, node);
      }
      countEl.textContent = window._findMatches.length > 0 ? '0/' + window._findMatches.length : 'No results';
      currentMatch = -1;
    }

    function navigateFind(dir) {
      var matches = window._findMatches || [];
      if (!matches.length) return;
      var prev = document.querySelector('#content mark.find-match.is-active');
      if (prev) prev.classList.remove('is-active');
      currentMatch += dir;
      if (currentMatch >= matches.length) currentMatch = 0;
      if (currentMatch < 0) currentMatch = matches.length - 1;
      var el = matches[currentMatch];
      el.classList.add('is-active');
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      countEl.textContent = (currentMatch + 1) + '/' + matches.length;
    }

    function showFind() {
      overlay.style.display = 'block';
      input.value = '';
      countEl.textContent = '';
      removeAllHighlights();
      input.focus();
      input.select();
    }

    function hideFind() {
      overlay.style.display = 'none';
      removeAllHighlights();
      input.value = '';
      countEl.textContent = '';
    }

    var typingTimer;
    input.addEventListener('input', function () {
      clearTimeout(typingTimer);
      typingTimer = setTimeout(function () { highlightAll(input.value); }, 150);
    });

    input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') {
        e.preventDefault();
        navigateFind(e.shiftKey ? -1 : 1);
      }
      if (e.key === 'Escape') { hideFind(); e.stopPropagation(); }
    });

    overlay.addEventListener('click', function (e) {
      var btn = e.target.closest('[data-action]');
      if (!btn) return;
      var action = btn.getAttribute('data-action');
      if (action === 'close') hideFind();
      else if (action === 'next') navigateFind(1);
      else if (action === 'prev') navigateFind(-1);
    });

    document.addEventListener('keydown', function (e) {
      if ((e.ctrlKey || e.metaKey) && e.key === 'f') {
        e.preventDefault();
        overlay.style.display === 'block' ? hideFind() : showFind();
      }
      if (e.key === 'Escape' && overlay.style.display === 'block') hideFind();
    });
  })();

  document.addEventListener('pointermove', function (event) {
    var bar = event.target.closest && event.target.closest('.histogram-bar');
    if (!bar) {
      hideHistogramTooltip();
      return;
    }

    var text = bar.getAttribute('data-tooltip');
    if (!text) return;
    if (!histogramTooltip) {
      histogramTooltip = document.createElement('div');
      histogramTooltip.className = 'histogram-tooltip';
      document.body.appendChild(histogramTooltip);
    }
    histogramTooltip.textContent = text;
    histogramTooltip.style.left = (event.clientX + 12) + 'px';
    histogramTooltip.style.top = (event.clientY + 12) + 'px';
    histogramTooltip.hidden = false;
  });

  document.addEventListener('pointerleave', hideHistogramTooltip);

  function hideHistogramTooltip() {
    if (histogramTooltip) histogramTooltip.hidden = true;
  }

  // ── HTML Helpers ─────────────────────────────────────────────
  function E(s) {
    var d = document.createElement('div');
    d.textContent = s;
    // textContent/innerHTML does NOT escape double quotes, and results land in
    // value="..."/title="..." attributes for third-party strings (CR-27).
    return d.innerHTML.replace(/"/g, '&quot;');
  }

  function buildSection(title, sourceBadge, contentHtml) {
    return '<div class="section">' +
      '<div class="section-header">' +
      '<span class="section-title">' + E(title) + '</span>' +
      '<span class="source-badge">' + E(sourceBadge) + '</span>' +
      '</div>' +
      contentHtml + '</div>';
  }

  function formatValue(v) {
    if (v === null || v === undefined) return '<span class="value-zero">-</span>';
    if (typeof v === 'boolean') {
      return v
        ? '<span class="badge badge-green">true</span>'
        : '<span class="badge badge-gray">false</span>';
    }
    if (typeof v === 'string') {
      if (v === '' || v === 'null') return '<span class="value-zero">-</span>';
      return '<span class="value-number">' + E(v) + '</span>';
    }
    var n = Number(v);
    if (isNaN(n)) return '<span class="value-zero">' + E(String(v)) + '</span>';
    if (n === 0) return '<span class="value-zero">0</span>';
    if (Number.isInteger(n)) return '<span class="value-number">' + n.toLocaleString() + '</span>';
    return '<span class="value-number">' + n.toPrecision(6).replace(/\.?0+$/, '') + '</span>';
  }

  function formatModelVal(key, val) {
    if (key === 'created' && typeof val === 'number' && val > 1e9) {
      return new Date(val * 1000).toISOString();
    }
    if (typeof val === 'object' && val !== null) return JSON.stringify(val);
    return val;
  }

  function formatProcessVal(name, val) {
    if (name.includes('memory') && typeof val === 'number')
      return (val / 1024 / 1024).toFixed(1) + ' MB';
    if (name.includes('start_time') && typeof val === 'number' && val > 1e9)
      return new Date(val * 1000).toISOString();
    return val;
  }

  function labelsHtml(labels) {
    if (!labels || Object.keys(labels).length === 0) return '<span class="value-zero">-</span>';
    var filtered = Object.entries(labels).filter(function (e) { return e[0] !== 'le'; });
    if (filtered.length === 0) return '<span class="value-zero">-</span>';
    return filtered.map(function (e) {
      return '<span style="color:var(--vscode-foreground)">' + E(e[0]) + '</span>=<span style="color:var(--vscode-textLink-foreground)">' + E(e[1]) + '</span>';
    }).join('<br>');
  }

  function buildSimpleTable(rows) {
    if (!rows || rows.length === 0)
      return '<p class="empty-state">No data</p>';
    var html = '<table><thead><tr><th>Metric</th><th>Labels</th><th>Value</th><th>Description</th></tr></thead><tbody>';
    for (var i = 0; i < rows.length; i++) {
      var r = rows[i];
      html += '<tr>' +
        '<td class="metric-name">' + E(r.name) + '</td>' +
        '<td class="labels-cell">' + labelsHtml(r.labels) + '</td>' +
        '<td class="value-cell">' + formatValue(r.value) + '</td>' +
        '<td class="desc-cell">' + E(r.description || '') + '</td>' +
        '</tr>';
    }
    html += '</tbody></table>';
    return html;
  }

  // ── Histogram rendering (CSS bar chart) ─────────────────────
  function renderHistogramChart(entries) {
    // Group by non-"le" labels, compute per-label-group distributions
    var groups = {};
    for (var i = 0; i < entries.length; i++) {
      var e = entries[i];
      var leVal = (e.labels && e.labels.le !== undefined) ? e.labels.le : null;
      if (leVal === null) continue;
      var labelEntries = Object.entries(e.labels || {}).filter(function (kv) { return kv[0] !== 'le'; });
      var groupKey = JSON.stringify(labelEntries);
      if (!groups[groupKey]) groups[groupKey] = { labels: {}, buckets: [] };
      groups[groupKey].labels = Object.fromEntries(labelEntries);
      var leNum = leVal === '+Inf' ? Infinity : parseFloat(leVal);
      groups[groupKey].buckets.push({
        le: leNum,
        count: e.value,
        description: e.description || ''
      });
    }

    var fragments = [];
    for (var gk in groups) {
      var g = groups[gk];
      var buckets = g.buckets.sort(function (a, b) { return a.le - b.le; });
      if (buckets.length < 2) continue;
      var totalSamples = buckets[buckets.length - 1].count;

      // Compute per-bucket frequencies (diff cumulative counts)
      var bars = [];
      var maxCount = 0;
      for (var i = 0; i < buckets.length; i++) {
        var prev = i === 0 ? 0 : buckets[i - 1].count;
        var freq = Math.max(0, buckets[i].count - prev);
        var le = buckets[i].le;
        var label = le === Infinity ? '+Inf' : formatLe(le);
        bars.push({ label: label, freq: freq, total: buckets[i].count });
        if (freq > maxCount) maxCount = freq;
      }

      // SVG uses explicit coordinates, so bars cannot collapse under flex layout.
      var chartWidth = 600;
      var chartHeight = 132;
      var plotTop = 8;
      var plotHeight = 92;
      var labelY = 116;
      var gap = 3;
      var barWidth = Math.max(4, (chartWidth - gap * (bars.length - 1)) / bars.length);
      var svg = '<svg class="histogram-chart" viewBox="0 0 ' + chartWidth + ' ' + chartHeight + '" preserveAspectRatio="xMinYMid meet" role="img">' +
        '<line class="histogram-axis" x1="0" y1="' + (plotTop + plotHeight) + '" x2="' + chartWidth + '" y2="' + (plotTop + plotHeight) + '"></line>';
      for (var i = 0; i < bars.length; i++) {
        var b = bars[i];
        var height = maxCount > 0 ? Math.max(Math.round(b.freq / maxCount * plotHeight), 1) : 1;
        var x = i * (barWidth + gap);
        var y = plotTop + plotHeight - height;
        var label = E(b.label);
        var percentage = totalSamples > 0 ? (b.freq / totalSamples * 100) : 0;
        var tooltip = E('≤ ' + b.label + ': ' + percentage.toFixed(2) + '% (' + b.freq.toLocaleString() + ' of ' + totalSamples.toLocaleString() + ')');
        svg += '<g class="histogram-bar-group">' +
          '<rect class="histogram-bar" data-tooltip="' + tooltip + '" x="' + x.toFixed(2) + '" y="' + y + '" width="' + barWidth.toFixed(2) + '" height="' + height + '"></rect>' +
          '<text class="histogram-label" x="' + (x + barWidth / 2).toFixed(2) + '" y="' + labelY + '">' + label + '</text>' +
          '</g>';
      }
      var chartHtml = svg + '</svg>';

      var labelSuffix = Object.entries(g.labels).map(function (kv) { return kv[0] + '=' + kv[1]; }).join(' ');
      var desc = buckets[0].description || '';
      var sub = (labelSuffix ? labelSuffix + ' - ' : '') + desc;

      fragments.push('<div class="histogram-container">' +
        '<div class="histogram-subtitle">' + E(sub) + '</div>' +
        chartHtml + '</div>');
    }
    if (fragments.length === 0) return null;
    return fragments.join('');
  }

  function formatLe(le) {
    if (le >= 1000) return le.toExponential(1);
    if (le >= 1) return le.toFixed(2).replace(/\.?0+$/, '');
    if (le >= 0.001) return le.toFixed(4).replace(/\.?0+$/, '');
    return le.toExponential(2);
  }

  // ── Metric descriptions ─────────────────────────────────────
  var metricDesc = {
    // Gauges
    'kv_cache_usage_perc': 'GPU KV cache utilization (0-1)',
    'num_requests_running': 'Number of requests currently being processed',
    'num_requests_swapped': 'Number of requests in CPU swap space',
    'num_requests_waiting': 'Number of requests queued waiting for resources',
    'num_requests_waiting_by_reason': 'Waiting requests by reason (capacity vs deferred)',
    'gpu_prefix_cache_hit_rate': 'GPU prefix cache hit rate',
    'cache_prefix_cache_hit_rate': 'Cache prefix (APC) hit rate',
    'engine_sleep_state': 'Engine state (awake, weights_offloaded, discard_all)',
    'lora_requests_info': 'Active LoRA requests info',
    'websocket_connections_active': 'Active WebSocket connections',
    // Counters
    'prompt_tokens_total': 'Total prompt tokens processed',
    'prompt_tokens_by_source_total': 'Prompt tokens by source',
    'generation_tokens_total': 'Total generation tokens produced',
    'prompt_tokens_cached_total': 'Prompt tokens served from cache',
    'num_preemptions_total': 'Total request preemptions (context eviction)',
    'request_eviction_total': 'Total requests evicted from cache',
    'request_success_total': 'Successfully finished requests (by finish reason)',
    'corrupted_requests_total': 'Requests with NaNs detected in logits',
    'prefix_cache_queries_total': 'Prefix cache queries (token-level)',
    'prefix_cache_hits_total': 'Prefix cache hits (token-level)',
    'external_prefix_cache_queries_total': 'Cross-instance KV connector queries',
    'external_prefix_cache_hits_total': 'Cross-instance KV connector hits',
    'mm_cache_queries_total': 'Multi-modal cache queries',
    'mm_cache_hits_total': 'Multi-modal cache hits',
    'spec_decode_num_draft_tokens_total': 'Total speculative draft tokens',
    'spec_decode_num_accepted_tokens_total': 'Total accepted speculative tokens',
    'spec_decode_num_drafts_total': 'Total speculative decoding rounds',
    'spec_decode_num_accepted_tokens_per_pos_total': 'Accepted tokens per draft position',
    'estimated_flops_per_gpu_total': 'Estimated FLOPs per GPU (for MFU calculation)',
    'estimated_read_bytes_per_gpu_total': 'Bytes read from memory per GPU',
    'estimated_write_bytes_per_gpu_total': 'Bytes written to memory per GPU',
    'tool_call_parser_invocations_total': 'Tool call parser invocations by outcome',
    // Histograms
    'time_to_first_token_seconds': 'Latency from request arrival to first output token',
    'inter_token_latency_seconds': 'Time between consecutive output tokens (TPOT)',
    'request_prompt_tokens': 'Number of tokens in each request prompt',
    'request_generation_tokens': 'Number of generated tokens per request',
    'request_max_num_generation_tokens': 'Max requested generation tokens per request',
    'request_prefill_kv_computed_tokens': 'New KV tokens computed during prefill (excl. cached)',
    'request_params_n': 'The n (number of completions) request parameter',
    'request_params_max_tokens': 'The max_tokens request parameter',
    'e2e_request_latency_seconds': 'End-to-end request completion latency',
    'iteration_tokens': 'Tokens processed per decoder iteration',
    'request_queue_time_seconds': 'Time a request spent waiting in queue',
    'request_prefill_time_seconds': 'Time spent in prefill phase per request',
    'request_decode_time_seconds': 'Time spent in decode phase per request',
    'request_inference_time_seconds': 'Total time in RUNNING phase per request',
    'prefill_time': 'Time spent in the prefill phase',
    'decode_time': 'Time spent in the decode phase',
    'time_per_output_token': 'Average time per output token',
    'request_time_per_output_token_seconds': 'Per-request average time per output token',
    'scheduler_time': 'Time spent in scheduler per step',
    'decode_time_per_token': 'Decode time per token per step',
    'kv_block_lifetime_seconds': 'Lifetime of KV cache blocks',
    'kv_block_idle_before_evict_seconds': 'Idle time before KV block eviction',
    'kv_block_reuse_gap_seconds': 'Gap between KV block reuses',
    // Process
    'process_cpu_seconds': 'Total CPU time in seconds',
    'process_resident_memory_bytes': 'Process RSS in bytes',
    'process_virtual_memory_bytes': 'Virtual memory usage in bytes',
    'process_start_time': 'Process start timestamp',
  };

  function getMetricDesc(name) {
    return metricDesc[name] || metricDesc[name.replace('vllm:', '')] || '';
  }

  // ── Main render ──────────────────────────────────────────────
  function render() {
    var data = lastData;
    if (!data) {
      document.getElementById('content').innerHTML = '<div class="empty-state">No data</div>';
      document.getElementById('lastUpdated').textContent = '';
      return;
    }

    // Probe failure first: the sections below are empty on a dead server, so the
    // banner is the only thing that explains the missing data.
    var html = lastError
      ? '<div class="error-msg">Error: ' + E(lastError) + '</div>'
      : '';

    // ── Version Info ───────────────────────────────────────────
    {
      var v = data.version || {};
      var keys = Object.keys(v);
      if (keys.length > 0) {
        var rows = keys.map(function (k) {
          return { name: k, value: v[k], labels: {}, description: k === 'version' ? 'vLLM server version' : '' };
        });
        html += buildSection('Version Info', '/version', buildSimpleTable(rows));
      } else {
        html += buildSection('Version Info', '/version', '<div class="empty-state">No version data (server may be offline)</div>');
      }
    }

    // ── Health Status ──────────────────────────────────────────
    {
      var hs = data.healthStatus;
      var hb = data.healthBody || '';
      var badge = '';
      var detail = '';
      if (hs !== null && hs !== undefined && hs > 0) {
        if (hs >= 200 && hs < 300) {
          badge = '<span class="badge badge-green">Healthy</span>';
        } else if (hs >= 500) {
          badge = '<span class="badge badge-red">Error</span>';
        } else {
          badge = '<span class="badge badge-yellow">Unhealthy</span>';
        }
        detail = '<span style="color:var(--vscode-descriptionForeground);font-size:12px;margin-left:8px">HTTP ' + hs + '</span>';
        if (hb && hb !== 'OK' && hb !== '"OK"') {
          detail += '<span style="color:var(--vscode-descriptionForeground);font-size:12px;margin-left:4px">- ' + E(hb) + '</span>';
        }
      } else {
        badge = '<span class="badge badge-gray">No response</span>';
      }
      html += buildSection('Health Status', '/health', '<div style="padding:8px">' + badge + detail + '</div>');
    }

    // ── Server Load ────────────────────────────────────────────
    {
      var sl = data.serverLoad;
      var loadHtml = '<div class="kv-grid">';
      if (sl !== null && sl !== undefined) {
        // server_load is a 0..1 utilization ratio from /load, not a request
        // count — render it as a percentage under the Server Load label.
        loadHtml += '<div class="kv-item">' +
          '<span class="kv-label">Server Load</span>' +
          '<span class="kv-value">' + Math.round(sl * 100) + '%</span></div>';
      } else {
        loadHtml += '<div class="kv-item">' +
          '<span class="kv-label">Server Load</span>' +
          '<span class="kv-value"><span class="value-zero">-</span></span></div>';
      }
      loadHtml += '</div>';
      html += buildSection('Server Load', '/load', loadHtml);
    }

    // ── Models ─────────────────────────────────────────────────
    {
      var models = Array.isArray(data.models) ? data.models : [];
      if (models.length > 0) {
        var mHtml = '';
        for (var mi = 0; mi < models.length; mi++) {
          var m = models[mi];
          var mRows = Object.entries(m)
            .filter(function (kv) { return kv[0] !== 'permission'; })
            .map(function (kv) {
              return { name: kv[0], value: formatModelVal(kv[0], kv[1]), labels: {}, description: '' };
            });
          mHtml += '<div style="margin-bottom:12px">' + buildSimpleTable(mRows);
          if (m.permission && Array.isArray(m.permission) && m.permission.length > 0) {
            mHtml += '<details style="margin-top:4px;font-size:11px;color:var(--vscode-descriptionForeground)">' +
              '<summary style="cursor:pointer;padding:4px 8px">Permissions (' + m.permission.length + ')</summary>' +
              '<pre style="background:var(--vscode-toolbar-hoverBackground);padding:6px;border-radius:3px;overflow:auto;font-size:10px;margin-top:4px">' +
              E(JSON.stringify(m.permission, null, 2)) + '</pre></details>';
          }
          mHtml += '</div>';
        }
        html += buildSection('Models', '/v1/models', mHtml);
      }
    }

    // ── Cache Config ───────────────────────────────────────────
    {
      var cc = (data.metrics && data.metrics.cache_config) || {};
      var ccKeys = Object.keys(cc);
      if (ccKeys.length > 0) {
        var ccHtml = '<div class="kv-grid">';
        for (var ci = 0; ci < ccKeys.length; ci++) {
          var ck = ccKeys[ci];
          ccHtml += '<div class="kv-item">' +
            '<span class="kv-label">' + E(ck) + '</span>' +
            '<span class="kv-value">' + formatValue(cc[ck]) + '</span></div>';
        }
        ccHtml += '</div>';
        html += buildSection('Cache Configuration', '/metrics → cache_config', ccHtml);
      }
    }

    // ── Gauges ─────────────────────────────────────────────────
    {
      var gauges = (data.metrics && data.metrics.gauges) || {};
      var gRows = [];
      for (var gk in gauges) {
        var entries = gauges[gk];
        if (!Array.isArray(entries)) continue;
        for (var gi = 0; gi < entries.length; gi++) {
          var e = entries[gi];
          gRows.push({
            name: gk,
            value: e.value,
            labels: e.labels,
            description: e.description || getMetricDesc(gk)
          });
        }
      }
      if (gRows.length > 0)
        html += buildSection('Gauges', '/metrics', buildSimpleTable(gRows));
    }

    // ── Counters ───────────────────────────────────────────────
    {
      var counters = (data.metrics && data.metrics.counters) || {};
      var cRows = [];
      for (var ck2 in counters) {
        var cEntries = counters[ck2];
        if (!Array.isArray(cEntries)) continue;
        for (var ci2 = 0; ci2 < cEntries.length; ci2++) {
          var ce = cEntries[ci2];
          cRows.push({
            name: ck2,
            value: ce.value,
            labels: ce.labels,
            description: ce.description || getMetricDesc(ck2)
          });
        }
      }
      if (cRows.length > 0)
        html += buildSection('Counters', '/metrics', buildSimpleTable(cRows));
    }

    // ── Process Metrics ────────────────────────────────────────
    {
      var proc = (data.metrics && data.metrics.process) || {};
      var pRows = [];
      for (var pk in proc) {
        var pEntries = proc[pk];
        if (!Array.isArray(pEntries)) continue;
        for (var pi = 0; pi < pEntries.length; pi++) {
          var pe = pEntries[pi];
          pRows.push({
            name: pk,
            value: formatProcessVal(pk, pe.value),
            labels: pe.labels,
            description: pe.description || getMetricDesc(pk)
          });
        }
      }
      if (pRows.length > 0)
        html += buildSection('Process Metrics', '/metrics → process_*', buildSimpleTable(pRows));
    }

    // ── HTTP Metrics ───────────────────────────────────────────
    {
      var http = (data.metrics && data.metrics.http) || {};
      var hRows = [];
      for (var hk in http) {
        var hEntries = http[hk];
        if (!Array.isArray(hEntries)) continue;
        for (var hi = 0; hi < hEntries.length; hi++) {
          var he = hEntries[hi];
          hRows.push({
            name: hk,
            value: he.value,
            labels: he.labels,
            description: he.description || getMetricDesc(hk)
          });
        }
      }
      if (hRows.length > 0)
        html += buildSection('HTTP Server Metrics', '/metrics → http_*', buildSimpleTable(hRows));
    }

    // ── Histograms (CSS bar charts) ────────────────────────────
    {
      var histData = (data.metrics && data.metrics.histograms) || {};
      var histKeys = Object.keys(histData);
      var histGrid = '';
      for (var hi2 = 0; hi2 < histKeys.length; hi2++) {
        var hKey = histKeys[hi2];
        var hEntries = histData[hKey];
        if (!Array.isArray(hEntries) || hEntries.length === 0) continue;

        var chartHtml = renderHistogramChart(hEntries);
        if (!chartHtml) continue; // skip empty groups (e.g. misclassified gauges)

        histGrid += '<div class="histogram-container"><div class="histogram-title">' +
          E(hKey) + '</div><div class="histogram-subtitle">' +
          E(getMetricDesc(hKey)) + '</div>' + chartHtml + '</div>';
      }
      if (histGrid)
        html += buildSection('Histograms', '/metrics', '<div class="histograms-grid">' + histGrid + '</div>');
    }

    document.getElementById('content').innerHTML = html;
    // One-shot panel: say so, since re-opening is the only way to retake it.
    // Stamp the CAPTURE time (stale cache under an offline banner must not
    // claim 'now'), falling back to render time when none was sent.
    var stampAt = lastSnapshotAt > 0 ? new Date(lastSnapshotAt) : new Date();
    document.getElementById('lastUpdated').textContent =
      'Snapshot ' + stampAt.toLocaleTimeString() + ' · re-open to refresh';
  }
})();