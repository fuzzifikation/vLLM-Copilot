import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  MetricsParser,
  parseRawMetrics,
  parseLabels,
  fmtPct,
  fmtMs,
  fmtN,
  fmtThroughput,
  fmtTokPerSec,
  shortUrl,
  getMetricsEngine,
  updateMetricsEngineHeaders,
  ServerMetricsEngine,
  type ModelAccumulator,
  type RawMetricEntry,
  type ServerRawData,
} from '../src/vllmMetrics.js';
import { resetOpenRouterProviderListCache } from '../src/openRouter.js';

// The provider-list cache is module-level state shared with the dashboard and
// Model Settings — reset it before every test so the stubbed fetch is the only
// source of truth.
beforeEach(() => { resetOpenRouterProviderListCache(); });

// ─── parseLabels ────────────────────────────────────────────────────

describe('parseLabels', () => {
  it('parses empty input', () => {
    expect(parseLabels(undefined)).toEqual({});
    expect(parseLabels('')).toEqual({});
  });

  it('parses simple label', () => {
    expect(parseLabels('model_name="foo"')).toEqual({ model_name: 'foo' });
  });

  it('parses multiple labels', () => {
    expect(parseLabels('le="0.1",model_name="bar",engine="0"')).toEqual({
      le: '0.1',
      model_name: 'bar',
      engine: '0',
    });
  });

  it('handles special characters in values', () => {
    expect(parseLabels('model_name="org/model-1"')).toEqual({ model_name: 'org/model-1' });
  });
});

// ─── MetricsParser (sidebar dashboard) ─────────────────────────────

describe('MetricsParser', () => {
  it('ignores comments and blank lines', () => {
    const p = new MetricsParser();
    p.parse('# HELP some gauge\ngauge_value 42\n');
    // data line with no model_name creates 'unknown' accumulator
    expect(p.models.size).toBe(1);
    expect(p.models.has('unknown')).toBe(true);
  });

  it('parses kv cache usage', () => {
    const p = new MetricsParser();
    p.parse('vllm:kv_cache_usage_perc{model_name="llama"} 0.75\n');
    const agg = p.aggregate();
    expect(agg.kvCacheUsagePercent).toBeCloseTo(75, 4);
  });

  it('parses multiple model kv cache and averages', () => {
    const p = new MetricsParser();
    p.parse(`
      vllm:kv_cache_usage_perc{model_name="m1"} 0.6
      vllm:kv_cache_usage_perc{model_name="m2"} 0.8
    `);
    const agg = p.aggregate();
    expect(agg.kvCacheUsagePercent).toBeCloseTo(70, 4);
  });

  it('parses running and waiting requests', () => {
    const p = new MetricsParser();
    p.parse(`
      vllm:num_requests_running{model_name="llama"} 3
      vllm:num_requests_waiting{model_name="llama"} 2
    `);
    const agg = p.aggregate();
    expect(agg.runningRequests).toBe(3);
    expect(agg.waitingRequests).toBe(2);
  });

  it('parses cache hit rate from prompt tokens', () => {
    const p = new MetricsParser();
    p.parse(`
      vllm:prompt_tokens_total{model_name="llama"} 1000
      vllm:prompt_tokens_cached_total{model_name="llama"} 700
    `);
    const agg = p.aggregate();
    expect(agg.cacheHitRate).toBeCloseTo(70, 4);
  });

  it('parses preemptions and evictions', () => {
    const p = new MetricsParser();
    p.parse(`
      vllm:num_preemptions_total{model_name="llama"} 5
      vllm:request_eviction_total{model_name="llama"} 3
    `);
    const agg = p.aggregate();
    expect(agg.preemptions).toBe(5);
    expect(agg.evictions).toBe(3);
  });

  it('parses speculative decoding metrics', () => {
    const p = new MetricsParser();
    p.parse(`
      vllm:spec_decode_num_draft_tokens_total{model_name="llama"} 1000
      vllm:spec_decode_num_accepted_tokens_total{model_name="llama"} 600
      vllm:spec_decode_num_drafts_total{model_name="llama"} 50
    `);
    const agg = p.aggregate();
    expect(agg.specAcceptanceRate).toBeCloseTo(60, 4);
    expect(agg.specDraftDepth).toBeCloseTo(20, 4);
    expect(agg.specDraftsTotal).toBe(50);
  });

  it('parses TTFT from sum and count', () => {
    const p = new MetricsParser();
    p.parse(`
      vllm:time_to_first_token_seconds_sum{model_name="llama"} 3.5
      vllm:time_to_first_token_seconds_count{model_name="llama"} 7
    `);
    const agg = p.aggregate();
    // avg = 3.5 / 7 = 0.5s = 500ms
    expect(agg.avgTTFTMs).toBeCloseTo(500, 4);
  });

  it('parses TPOT from sum and count', () => {
    const p = new MetricsParser();
    p.parse(`
      vllm:inter_token_latency_seconds_sum{model_name="llama"} 2.0
      vllm:inter_token_latency_seconds_count{model_name="llama"} 100
    `);
    const agg = p.aggregate();
    // avg = 2.0 / 100 = 0.02s = 20ms
    expect(agg.avgTPOTMs).toBeCloseTo(20, 4);
  });

  it('parses pooled throughput from generation tokens / decode time', () => {
    const p = new MetricsParser();
    p.parse(`
      vllm:request_generation_tokens_sum{model_name="llama"} 500
      vllm:request_generation_tokens_count{model_name="llama"} 5
      vllm:request_decode_time_seconds_sum{model_name="llama"} 10
      vllm:request_decode_time_seconds_count{model_name="llama"} 5
    `);
    const agg = p.aggregate();
    // 500 tokens / 10s = 50 tok/s
    expect(agg.avgTputTokPerSec).toBeCloseTo(50, 4);
  });

  it('aggregates pooled throughput across models', () => {
    const p = new MetricsParser();
    p.parse(`
      vllm:request_generation_tokens_sum{model_name="m1"} 300
      vllm:request_decode_time_seconds_sum{model_name="m1"} 6
      vllm:request_generation_tokens_sum{model_name="m2"} 700
      vllm:request_decode_time_seconds_sum{model_name="m2"} 14
    `);
    const agg = p.aggregate();
    // (300+700) / (6+14) = 1000 / 20 = 50 tok/s
    expect(agg.avgTputTokPerSec).toBeCloseTo(50, 4);
  });

  it('parses pooled prefill throughput from prompt tokens / prefill time', () => {
    const p = new MetricsParser();
    p.parse(`
      vllm:request_prompt_tokens_sum{model_name="llama"} 2000
      vllm:request_prompt_tokens_count{model_name="llama"} 4
      vllm:request_prefill_time_seconds_sum{model_name="llama"} 0.4
      vllm:request_prefill_time_seconds_count{model_name="llama"} 4
    `);
    const agg = p.aggregate();
    // 2000 tokens / 0.4s = 5000 tok/s
    expect(agg.avgPrefillTputTokPerSec).toBeCloseTo(5000, 4);
  });

  it('aggregates pooled prefill throughput across models', () => {
    const p = new MetricsParser();
    p.parse(`
      vllm:request_prompt_tokens_sum{model_name="m1"} 1500
      vllm:request_prefill_time_seconds_sum{model_name="m1"} 0.5
      vllm:request_prompt_tokens_sum{model_name="m2"} 3500
      vllm:request_prefill_time_seconds_sum{model_name="m2"} 0.5
    `);
    const agg = p.aggregate();
    // (1500+3500) / (0.5+0.5) = 5000 / 1 = 5000 tok/s
    expect(agg.avgPrefillTputTokPerSec).toBeCloseTo(5000, 4);
  });

  it('returns null for metrics with no data', () => {
    const p = new MetricsParser();
    p.parse('');
    const agg = p.aggregate();
    expect(agg.kvCacheUsagePercent).toBeNull();
    expect(agg.runningRequests).toBeNull();
    expect(agg.cacheHitRate).toBeNull();
    expect(agg.avgTTFTMs).toBeNull();
  });

  it('filters out unknown model name', () => {
    const p = new MetricsParser();
    p.parse('vllm:kv_cache_usage_perc{} 0.5\n');
    const agg = p.aggregate();
    expect(agg.models).not.toContain('unknown');
  });

  it('aggregates across multiple models', () => {
    const p = new MetricsParser();
    p.parse(`
      vllm:kv_cache_usage_perc{model_name="m1"} 0.6
      vllm:kv_cache_usage_perc{model_name="m2"} 0.8
      vllm:num_requests_running{model_name="m1"} 3
      vllm:num_requests_running{model_name="m2"} 5
    `);
    const agg = p.aggregate();
    expect(agg.models).toEqual(['m1', 'm2']);
    expect(agg.runningRequests).toBe(8);
    expect(agg.kvCacheUsagePercent).toBeCloseTo(70, 4);
  });
});

// ─── parseRawMetrics (deep-dive webview) ────────────────────────────

function emptyMetrics(): ServerRawData['metrics'] {
  return {
    gauges: {},
    counters: {},
    histograms: {},
    cache_config: {},
    process: {},
    http: {},
  };
}

describe('parseRawMetrics', () => {
  it('categorizes histogram buckets', () => {
    const m = emptyMetrics();
    parseRawMetrics(
      `# HELP vllm:time_to_first_token_seconds Latency in seconds
vllm:time_to_first_token_seconds_bucket{le="0.1",model_name="foo"} 10
vllm:time_to_first_token_seconds_bucket{le="+Inf",model_name="foo"} 4054`,
      m,
    );
    // Key retains _bucket suffix (vllm: prefix stripped)
    const hist = m.histograms['time_to_first_token_seconds_bucket'];
    expect(hist).toBeDefined();
    expect(hist!.length).toBe(2);
    expect(hist![0].labels.le).toBe('0.1');
    expect(hist![0].value).toBe(10);
    expect(hist![1].labels.le).toBe('+Inf');
    expect(hist![1].value).toBe(4054);
    // Description attached via base name (strips _bucket suffix)
    expect(hist![0].description).toBe('Latency in seconds');
  });

  it('categorizes gauges', () => {
    const m = emptyMetrics();
    parseRawMetrics(
      `# HELP vllm:kv_cache_usage_perc GPU KV cache utilization
vllm:kv_cache_usage_perc{model_name="llama"} 0.75`,
      m,
    );
    expect(m.gauges['kv_cache_usage_perc']?.length).toBe(1);
    expect(m.gauges['kv_cache_usage_perc']![0].value).toBe(0.75);
    expect(m.gauges['kv_cache_usage_perc']![0].description).toBe('GPU KV cache utilization');
  });

  it('categorizes counters', () => {
    const m = emptyMetrics();
    parseRawMetrics(
      `# HELP vllm:prompt_tokens_total Total prompt tokens
vllm:prompt_tokens_total{model_name="llama"} 1000`,
      m,
    );
    expect(m.counters['prompt_tokens_total']?.length).toBe(1);
    expect(m.counters['prompt_tokens_total']![0].value).toBe(1000);
  });

  it('categorizes process metrics', () => {
    const m = emptyMetrics();
    parseRawMetrics('process_cpu_seconds 123.45\n', m);
    expect(Object.keys(m.process)).toContain('process_cpu_seconds');
  });

  it('categorizes HTTP metrics', () => {
    const m = emptyMetrics();
    parseRawMetrics('http_request_duration_seconds_sum 5.0\n', m);
    expect(Object.keys(m.http)).toContain('http_request_duration_seconds_sum');
  });

  it('parses cache config', () => {
    const m = emptyMetrics();
    parseRawMetrics(
      'vllm:cache_config_block_size 16\nvllm:cache_config_num_gpu_blocks 1000',
      m,
    );
    // Metric name after vllm:cache_config_ becomes the key
    expect(m.cache_config['block_size']).toBe(16);
    expect(m.cache_config['num_gpu_blocks']).toBe(1000);
  });

  it('strips vllm: prefix from bucket names', () => {
    const m = emptyMetrics();
    parseRawMetrics(
      'vllm:kv_cache_usage_perc{model_name="x"} 0.5',
      m,
    );
    expect('kv_cache_usage_perc' in m.gauges).toBe(true);
    expect('vllm:kv_cache_usage_perc' in m.gauges).toBe(false);
  });

  it('classifies histogram _sum and _count with the histogram family (not gauge/counter)', () => {
    const m = emptyMetrics();
    parseRawMetrics(
      `# HELP vllm:time_to_first_token_seconds Latency in seconds
# TYPE vllm:time_to_first_token_seconds histogram
vllm:time_to_first_token_seconds_sum{model_name="foo"} 3.5
vllm:time_to_first_token_seconds_count{model_name="foo"} 7
vllm:time_to_first_token_seconds_bucket{le="0.1",model_name="foo"} 1`,
      m,
    );
    // _sum and _count belong to the histogram family, not gauges/counters.
    // Each is stored under its own vllm:-stripped, suffix-retained key.
    expect(m.gauges['time_to_first_token_seconds_sum']).toBeUndefined();
    expect(m.counters['time_to_first_token_seconds_count']).toBeUndefined();
    const sumHist = m.histograms['time_to_first_token_seconds_sum'];
    expect(sumHist).toBeDefined();
    expect(sumHist!.length).toBe(1);
    expect(sumHist![0].value).toBe(3.5);
    const countHist = m.histograms['time_to_first_token_seconds_count'];
    expect(countHist).toBeDefined();
    expect(countHist!.length).toBe(1);
    expect(countHist![0].value).toBe(7);
    const bucketHist = m.histograms['time_to_first_token_seconds_bucket'];
    expect(bucketHist).toBeDefined();
    expect(bucketHist!.length).toBe(1);
    // Description still attaches via the base name.
    expect(sumHist![0].description).toBe('Latency in seconds');
    expect(countHist![0].description).toBe('Latency in seconds');
  });

  it('classifies _sum/_count via TYPE line even when HELP is absent', () => {
    const m = emptyMetrics();
    parseRawMetrics(
      `# TYPE vllm:inter_token_latency_seconds histogram
vllm:inter_token_latency_seconds_sum{model_name="foo"} 2.0
vllm:inter_token_latency_seconds_count{model_name="foo"} 100`,
      m,
    );
    expect(m.gauges['inter_token_latency_seconds_sum']).toBeUndefined();
    expect(m.counters['inter_token_latency_seconds_count']).toBeUndefined();
    const sumHist = m.histograms['inter_token_latency_seconds_sum'];
    expect(sumHist).toBeDefined();
    expect(sumHist![0].value).toBe(2.0);
    const countHist = m.histograms['inter_token_latency_seconds_count'];
    expect(countHist).toBeDefined();
    expect(countHist![0].value).toBe(100);
  });

  it('keeps string-heuristic fallback when no TYPE line is present', () => {
    const m = emptyMetrics();
    parseRawMetrics(
      'vllm:prompt_tokens_total{model_name="x"} 5\nvllm:kv_cache_usage_perc{model_name="x"} 0.5',
      m,
    );
    // No TYPE lines → falls back to suffix heuristics (_total → counter, else gauge).
    expect(m.counters['prompt_tokens_total']?.length).toBe(1);
    expect(m.gauges['kv_cache_usage_perc']?.length).toBe(1);
  });

  it('handles empty input', () => {
    const m = emptyMetrics();
    parseRawMetrics('', m);
    expect(Object.keys(m.gauges)).toHaveLength(0);
    expect(Object.keys(m.counters)).toHaveLength(0);
    expect(Object.keys(m.histograms)).toHaveLength(0);
  });
});

// ─── Format helpers ─────────────────────────────────────────────────

describe('fmtPct', () => {
  it('formats null as dash', () => {
    expect(fmtPct(null)).toBe('—');
  });
  it('rounds percentage', () => {
    expect(fmtPct(67.3)).toBe('67%');
  });
});

describe('fmtMs', () => {
  it('formats null as dash', () => {
    expect(fmtMs(null)).toBe('—');
  });
  it('formats milliseconds', () => {
    expect(fmtMs(150)).toBe('150ms');
  });
  it('formats seconds for large values', () => {
    expect(fmtMs(1500)).toBe('1.50s');
  });
});

describe('fmtN', () => {
  it('formats null as dash', () => {
    expect(fmtN(null)).toBe('—');
  });
  it('formats numbers', () => {
    expect(fmtN(42)).toBe('42');
  });
});

describe('fmtThroughput', () => {
  it('formats null as dash', () => {
    expect(fmtThroughput(null)).toBe('—');
  });
  it('formats tokens per second', () => {
    expect(fmtThroughput(20)).toBe('50.0 tok/s');  // < 100 tok/s → 1 decimal
    expect(fmtThroughput(3.333)).toBe('300 tok/s'); // >= 100 tok/s → rounded
  });
});

describe('fmtTokPerSec', () => {
  it('formats null/non-positive as dash', () => {
    expect(fmtTokPerSec(null)).toBe('—');
    expect(fmtTokPerSec(0)).toBe('—');
  });
  it('formats tokens per second', () => {
    expect(fmtTokPerSec(50)).toBe('50.0 tok/s');   // < 100 tok/s → 1 decimal
    expect(fmtTokPerSec(300)).toBe('300 tok/s');   // >= 100 tok/s → rounded
  });
});

describe('shortUrl', () => {
  it('extracts hostname:port, omitting an empty port', () => {
    expect(shortUrl('http://localhost:8000')).toBe('localhost:8000');
    // URL constructor strips default ports (443 for https) → no trailing colon.
    expect(shortUrl('https://example.com:443/v1')).toBe('example.com');
    expect(shortUrl('https://example.com:8443/v1')).toBe('example.com:8443');
  });
  it('falls back to stripped URL on invalid input', () => {
    expect(shortUrl('not-a-url')).toBe('not-a-url');
  });
});

// ─── Engine Registry lifecycle ──────────────────────────────────────

describe('ServerMetricsEngine registry lifecycle', () => {
  afterEach(() => {
    vi.useRealTimers(); // undo any fake timers from the retry tests (fail-safe)
    vi.unstubAllGlobals();
  });

  it('resolves the context window per-backend for non-vLLM servers', async () => {
    // Non-vLLM backends don't report max_model_len on /v1/models. The engine must
    // fall back to the OpenRouter catalog resolver (exact id match) so the
    // dashboard shows the real window.
    const urls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: unknown) => {
      const u = String(url);
      urls.push(u);
      if (u.endsWith('/v1/models')) {
        // The catalog is the OpenRouter metadata source — the configured model
        // id appears as its own full entry (with context_length).
        return new Response(JSON.stringify({ data: [{ id: 'nvidia/nemotron-3.5-lightning:free', context_length: 1000000 }] }), { status: 200 });
      }
      return new Response(null, { status: 404 });
    }));

    const url = 'http://or-test:8000';
    const engine = getMetricsEngine(url, {}, 'openrouter', ['nvidia/nemotron-3.5-lightning:free']);
    const aggregated = await new Promise<ReturnType<ServerMetricsEngine['getCachedAggregated']>>((resolve, reject) => {
      const sub = engine.subscribe((agg) => { resolve(agg); sub.dispose(); });
      setTimeout(() => { sub.dispose(); reject(new Error('tick timeout')); }, 2000);
    });

    // Only /v1/models was probed (no vLLM-only endpoints), and the context
    // window came from the per-backend resolver.
    expect(aggregated?.online).toBe(true);
    expect(aggregated?.maxModelLen).toBe(1000000);
    expect(urls.some(u => u.endsWith('/v1/models'))).toBe(true);
    expect(urls.some(u => u.endsWith('/metrics') || u.endsWith('/version') || u.endsWith('/load'))).toBe(false);
  });

  it('resolves a context window PER MODEL for an OpenRouter relay collection', async () => {
    // OpenRouter is a relay: each configured model has its OWN context window.
    // The engine must resolve one per model id and expose them via contextByModel.
    vi.stubGlobal('fetch', vi.fn(async (url: unknown) => {
      const u = String(url);
      if (u.endsWith('/v1/models')) {
        // Catalog with both configured models as distinct full entries.
        return new Response(JSON.stringify({ data: [
          { id: 'nvidia/nemotron-3.5-lightning:free', context_length: 1000000 },
          { id: 'deepseek/deepseek-chat', context_length: 163840 },
        ] }), { status: 200 });
      }
      return new Response(null, { status: 404 });
    }));

    const url = 'http://or-relay:8000';
    const engine = getMetricsEngine(url, {}, 'openrouter', ['nvidia/nemotron-3.5-lightning:free', 'deepseek/deepseek-chat']);
    const aggregated = await new Promise<ReturnType<ServerMetricsEngine['getCachedAggregated']>>((resolve, reject) => {
      const sub = engine.subscribe((agg) => { resolve(agg); sub.dispose(); });
      setTimeout(() => { sub.dispose(); reject(new Error('tick timeout')); }, 2000);
    });

    // Both configured models resolve their own windows; the server-level
    // maxModelLen reflects the first model.
    expect(aggregated?.contextByModel).toEqual({
      'nvidia/nemotron-3.5-lightning:free': 1000000,
      'deepseek/deepseek-chat': 163840,
    });
    // The effective output ceiling is resolved alongside context (10%-of-window
    // fallback: Nemotron 1M → 81920 cap; DeepSeek 163840 → 16384). This feeds
    // the dashboard's Attention icon when the configured budget exceeds it.
    expect(aggregated?.outputByModel).toEqual({
      'nvidia/nemotron-3.5-lightning:free': 81920,
      'deepseek/deepseek-chat': 16384,
    });
    expect(aggregated?.maxModelLen).toBe(1000000);
  });

  it('captures OpenRouter account health from /api/v1/key', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: unknown) => {
      const u = String(url);
      if (u.endsWith('/v1/models')) {
        return new Response(JSON.stringify({ data: [{ id: 'm1' }] }), { status: 200 });
      }
      if (u.endsWith('/v1/key')) {
        return new Response(JSON.stringify({
          data: { label: 'my-key', limit: 10, limit_remaining: 3.5, usage: 100, is_free_tier: false },
        }), { status: 200 });
      }
      return new Response(null, { status: 404 });
    }));

    const url = 'http://or-account:8000';
    const engine = getMetricsEngine(url, { Authorization: 'Bearer sk-test' }, 'openrouter', ['m1']);
    const aggregated = await new Promise<ReturnType<ServerMetricsEngine['getCachedAggregated']>>((resolve, reject) => {
      const sub = engine.subscribe((agg) => { resolve(agg); sub.dispose(); });
      setTimeout(() => { sub.dispose(); reject(new Error('tick timeout')); }, 2000);
    });

    expect(aggregated?.account).toEqual({ label: 'my-key', limit: 10, limit_remaining: 3.5, usage: 100, is_free_tier: false });
  });

  it('captures the OpenRouter account budget (total credits + usage) from /api/v1/credits', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: unknown) => {
      const u = String(url);
      if (u.endsWith('/v1/models')) {
        return new Response(JSON.stringify({ data: [{ id: 'm1' }] }), { status: 200 });
      }
      if (u.endsWith('/v1/credits')) {
        return new Response(JSON.stringify({ data: { total_credits: 10, total_usage: 3.5 } }), { status: 200 });
      }
      return new Response(null, { status: 404 });
    }));

    const url = 'http://or-credits:8000';
    const engine = getMetricsEngine(url, { Authorization: 'Bearer sk-test' }, 'openrouter', ['m1']);
    const aggregated = await new Promise<ReturnType<ServerMetricsEngine['getCachedAggregated']>>((resolve, reject) => {
      const sub = engine.subscribe((agg) => { resolve(agg); sub.dispose(); });
      setTimeout(() => { sub.dispose(); reject(new Error('tick timeout')); }, 2000);
    });

    expect(aggregated?.credits).toEqual({ total_credits: 10, total_usage: 3.5 });
  });

  it('degrades account health to undefined on a bad key (no fabricated credits)', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: unknown) => {
      const u = String(url);
      if (u.endsWith('/v1/models')) {
        return new Response(JSON.stringify({ data: [{ id: 'm1' }] }), { status: 200 });
      }
      if (u.endsWith('/v1/key')) {
        return new Response(null, { status: 401 });
      }
      return new Response(null, { status: 404 });
    }));

    const url = 'http://or-badkey:8000';
    const engine = getMetricsEngine(url, { Authorization: 'Bearer bad' }, 'openrouter', ['m1']);
    const aggregated = await new Promise<ReturnType<ServerMetricsEngine['getCachedAggregated']>>((resolve, reject) => {
      const sub = engine.subscribe((agg) => { resolve(agg); sub.dispose(); });
      setTimeout(() => { sub.dispose(); reject(new Error('tick timeout')); }, 2000);
    });

    expect(aggregated?.online).toBe(true); // chat works even with a bad key path
    expect(aggregated?.account).toBeUndefined(); // no credits invented
  });

  it('captures per-model provider pricing from /endpoints for an OpenRouter relay', async () => {
    // Each configured model fetches its provider list (tag/provider_name +
    // per-1M pricing) from the public /endpoints endpoint, keyed by model id.
    vi.stubGlobal('fetch', vi.fn(async (url: unknown) => {
      const u = String(url);
      if (u.endsWith('/v1/models')) {
        return new Response(JSON.stringify({ data: [{ id: 'deepseek/deepseek-chat', context_length: 163840 }] }), { status: 200 });
      }
      if (u.includes('/endpoints')) {
        return new Response(JSON.stringify({
          data: {
            id: 'deepseek/deepseek-chat',
            endpoints: [
              { tag: 'deepseek', provider_name: 'DeepSeek', quantization: 'unknown', status: 0, pricing: { prompt: '0.00000066', completion: '0.00000198', input_cache_read: '0.000000022' } },
              { tag: 'alibaba', provider_name: 'Alibaba', quantization: 'unknown', status: 0, pricing: { prompt: '0.000000726', completion: '0.000002178' } },
            ],
          },
        }), { status: 200 });
      }
      return new Response(null, { status: 404 });
    }));

    const url = 'http://or-pricing:8000';
    const engine = getMetricsEngine(url, {}, 'openrouter', ['deepseek/deepseek-chat']);
    const aggregated = await new Promise<ReturnType<ServerMetricsEngine['getCachedAggregated']>>((resolve, reject) => {
      const sub = engine.subscribe((agg) => { resolve(agg); sub.dispose(); });
      setTimeout(() => { sub.dispose(); reject(new Error('tick timeout')); }, 2000);
    });

    expect(aggregated?.online).toBe(true);
    expect(aggregated?.providersByModel?.['deepseek/deepseek-chat']).toEqual([
      expect.objectContaining({ tag: 'deepseek', providerName: 'DeepSeek', pricing: { prompt: '0.00000066', completion: '0.00000198', input_cache_read: '0.000000022' } }),
      expect.objectContaining({ tag: 'alibaba', providerName: 'Alibaba' }),
    ]);
  });

  it('leaves the context window null when the per-backend resolver fails', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: unknown) => {
      const u = String(url);
      if (u.endsWith('/v1/models')) {
        return new Response(JSON.stringify({ data: [{ id: 'm1' }] }), { status: 200 });
      }
      return new Response(null, { status: 404 }); // resolver endpoint missing
    }));

    const url = 'http://or-fail:8000';
    const engine = getMetricsEngine(url, {}, 'openrouter', ['nvidia/nemotron-3.5-lightning:free']);
    const aggregated = await new Promise<ReturnType<ServerMetricsEngine['getCachedAggregated']>>((resolve, reject) => {
      const sub = engine.subscribe((agg) => { resolve(agg); sub.dispose(); });
      setTimeout(() => { sub.dispose(); reject(new Error('tick timeout')); }, 2000);
    });

    expect(aggregated?.online).toBe(true); // still reachable via /v1/models
    expect(aggregated?.maxModelLen).toBeNull(); // context resolve failed → row hidden
  });

  it('retries a TRANSIENT context-resolve failure after the backoff and recovers', async () => {
    // The per-model transient/backoff path still exists for backends that make a
    // per-model HTTP call (Ollama /api/ps here). A transient failure must be
    // retried after the bounded backoff and recover — a one-off blip must not
    // disable context for the session. (OpenRouter resolution is in-memory from
    // the shared catalog, so it has no per-model transient path.)
    vi.useFakeTimers();
    let resolverHits = 0;
    vi.stubGlobal('fetch', vi.fn(async (url: unknown) => {
      const u = String(url);
      if (u.endsWith('/v1/models')) {
        return new Response(JSON.stringify({ data: [{ id: 'm1' }] }), { status: 200 });
      }
      if (u.endsWith('/api/ps')) {
        resolverHits++;
        // Exhaust fetchWithRetry's initial attempt + one pre-stream retry so
        // the first metrics tick still observes a transient failure. A later
        // engine poll succeeds after the context backoff.
        return resolverHits <= 2
          ? new Response(null, { status: 429 })
          : new Response(JSON.stringify({ models: [{ model: 'qwen', name: 'qwen:latest', context_length: 32768 }] }), { status: 200 });
      }
      return new Response(null, { status: 404 });
    }));

    const url = 'http://or-transient:8000';
    const engine = getMetricsEngine(url, {}, 'ollama', ['qwen']);
    // One subscription stays alive across both polls so the engine isn't
    // disposed between them.
    const polls: Array<ReturnType<ServerMetricsEngine['getCachedAggregated']>> = [];
    const sub = engine.subscribe((agg) => { polls.push(agg); });

    // First poll: transient failure → no window yet.
    await vi.advanceTimersByTimeAsync(1500); // initial attempt + 429 retry
    expect(polls[0]?.maxModelLen).toBeNull();

    // Advance past the 60s retry backoff + a poll interval so the next poll
    // re-attempts the resolve and succeeds.
    await vi.advanceTimersByTimeAsync(60_000 + 16_000);
    expect(polls.some(p => p?.maxModelLen === 32768)).toBe(true);
    sub.dispose();
    vi.useRealTimers();
  });

  it('does NOT retry a PERMANENT context-resolve failure (catalog entry present but no window)', async () => {
    // OpenRouter resolves in-memory from the shared catalog. A model that IS
    // listed but reports no usable window is genuinely unresolvable
    // (PermanentContextError) — retrying forever would hammer for a value that
    // can never appear. It is cached as null and never re-attempted, so even a
    // LATER catalog that gains a window does NOT self-heal (it's permanent).
    vi.useFakeTimers();
    let catalogFetches = 0;
    vi.stubGlobal('fetch', vi.fn(async (url: unknown) => {
      const u = String(url);
      if (u.endsWith('/v1/models')) {
        catalogFetches++;
        if (catalogFetches <= 2) {
          // Entry exists but reports NO context bound → permanent miss.
          return new Response(JSON.stringify({ data: [{ id: 'nvidia/nemotron-3.5-lightning:free' }] }), { status: 200 });
        }
        // Later polls: the entry NOW reports a window. A permanent miss must NOT
        // be re-resolved — the cache holds `null` and never retries.
        return new Response(JSON.stringify({ data: [{ id: 'nvidia/nemotron-3.5-lightning:free', context_length: 1000000 }] }), { status: 200 });
      }
      return new Response(null, { status: 404 });
    }));

    const url = 'http://or-permanent:8000';
    const engine = getMetricsEngine(url, {}, 'openrouter', ['nvidia/nemotron-3.5-lightning:free']);
    const polls: Array<ReturnType<ServerMetricsEngine['getCachedAggregated']>> = [];
    const sub = engine.subscribe((agg) => { polls.push(agg); });
    await vi.advanceTimersByTimeAsync(0);
    expect(polls[0]?.maxModelLen).toBeNull(); // permanent miss

    // Even after the catalog starts reporting a window, the permanent-null cache
    // is never re-attempted — the model stays unresolvable.
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(polls.every(p => p?.maxModelLen === null)).toBe(true); // never resolves
    sub.dispose();
    vi.useRealTimers();
  });

  it('rechecks an id ABSENT from the OpenRouter catalog on every poll and resolves once it appears', async () => {
    // Regression: an id absent from a snapshot used to be cached as permanent.
    // The catalog is re-fetched every poll, so an absent id is rechecked at no
    // extra HTTP cost — a transiently incomplete catalog or propagation delay
    // must not permanently disable context. It is never guessed/derived.
    vi.useFakeTimers();
    let catalogFetches = 0;
    vi.stubGlobal('fetch', vi.fn(async (url: unknown) => {
      const u = String(url);
      if (u.endsWith('/v1/models')) {
        catalogFetches++;
        if (catalogFetches <= 2) {
          // Early polls: the catalog does NOT contain the configured model yet.
          return new Response(JSON.stringify({ data: [{ id: 'some/other-model' }] }), { status: 200 });
        }
        // A later poll: the model appears in the catalog → it must resolve.
        return new Response(JSON.stringify({ data: [{ id: 'nvidia/nemotron-3.5-lightning:free', context_length: 1000000 }] }), { status: 200 });
      }
      return new Response(null, { status: 404 });
    }));

    const url = 'http://or-404:8000';
    const engine = getMetricsEngine(url, {}, 'openrouter', ['nvidia/nemotron-3.5-lightning:free']);
    const polls: Array<ReturnType<ServerMetricsEngine['getCachedAggregated']>> = [];
    const sub = engine.subscribe((agg) => { polls.push(agg); });
    await vi.advanceTimersByTimeAsync(0);
    expect(polls[0]?.maxModelLen).toBeNull(); // absent this poll

    // Advance past several polls; the engine rechecks the now-present model and
    // resolves it (no per-model API call — it uses the shared catalog).
    await vi.advanceTimersByTimeAsync(3 * 16_000);
    expect(polls.some(p => p?.maxModelLen === 1000000)).toBe(true);
    sub.dispose();
    vi.useRealTimers();
  });

  it('reports a malformed OpenRouter catalog as an error, not an online empty server', async () => {
    // Regression: a 200 whose body is not { data: [...] } used to read as an
    // online relay with no models. It is a protocol failure — the engine must
    // surface it as an error (not online) and recover once the catalog is valid.
    vi.useFakeTimers();
    let catalogFetches = 0;
    vi.stubGlobal('fetch', vi.fn(async (url: unknown) => {
      const u = String(url);
      if (u.endsWith('/v1/models')) {
        catalogFetches++;
        if (catalogFetches === 1) {
          // Malformed body — a 200 that is not { data: [...] }.
          return new Response(JSON.stringify({ something: 'else' }), { status: 200 });
        }
        return new Response(JSON.stringify({ data: [{ id: 'nvidia/nemotron-3.5-lightning:free', context_length: 1000000 }] }), { status: 200 });
      }
      return new Response(null, { status: 404 });
    }));

    const url = 'http://or-malformed:8000';
    const engine = getMetricsEngine(url, {}, 'openrouter', ['nvidia/nemotron-3.5-lightning:free']);
    const polls: Array<ReturnType<ServerMetricsEngine['getCachedAggregated']>> = [];
    const sub = engine.subscribe((agg) => { polls.push(agg); });
    await vi.advanceTimersByTimeAsync(0);
    // First poll: malformed catalog → not online, with an error message.
    expect(polls[0]?.online).toBe(false);
    expect(polls[0]?.error).toContain('malformed');

    // Next poll: valid catalog → online and the model resolves.
    await vi.advanceTimersByTimeAsync(16_000);
    expect(polls.some(p => p?.online === true)).toBe(true);
    expect(polls.some(p => p?.maxModelLen === 1000000)).toBe(true);
    sub.dispose();
    vi.useRealTimers();
  });

  it('reports an EMPTY successful OpenRouter catalog as malformed, not online', async () => {
    // Regression: a 200 with an empty body used to bypass the catalog validator
    // (the shape check was inside `if (modelsText)`) and read as an online empty
    // server. Every successful OpenRouter response must be shape-validated.
    vi.useFakeTimers();
    let catalogFetches = 0;
    vi.stubGlobal('fetch', vi.fn(async (url: unknown) => {
      const u = String(url);
      if (u.endsWith('/v1/models')) {
        catalogFetches++;
        if (catalogFetches === 1) {
          return new Response('', { status: 200 }); // 200 with an empty body
        }
        return new Response(JSON.stringify({ data: [{ id: 'nvidia/nemotron-3.5-lightning:free', context_length: 1000000 }] }), { status: 200 });
      }
      return new Response(null, { status: 404 });
    }));

    const url = 'http://or-empty:8000';
    const engine = getMetricsEngine(url, {}, 'openrouter', ['nvidia/nemotron-3.5-lightning:free']);
    const polls: Array<ReturnType<ServerMetricsEngine['getCachedAggregated']>> = [];
    const sub = engine.subscribe((agg) => { polls.push(agg); });
    await vi.advanceTimersByTimeAsync(0);
    // First poll: empty 200 → malformed → not online, with an error message.
    expect(polls[0]?.online).toBe(false);
    expect(polls[0]?.error).toContain('malformed');

    // Next poll: valid catalog → online and the model resolves.
    await vi.advanceTimersByTimeAsync(16_000);
    expect(polls.some(p => p?.online === true)).toBe(true);
    expect(polls.some(p => p?.maxModelLen === 1000000)).toBe(true);
    sub.dispose();
    vi.useRealTimers();
  });

  it('resolves OpenRouter windows from the shared catalog, never a per-model API', async () => {
    // Option B: OpenRouter context windows come from the relay's /v1/models
    // probe (the catalog), reused in one pass. No per-model /v1/model/ calls.
    vi.useFakeTimers();
    let modelEndpointHits = 0;
    vi.stubGlobal('fetch', vi.fn(async (url: unknown) => {
      const u = String(url);
      if (u.endsWith('/v1/models')) {
        return new Response(JSON.stringify({ data: [
          { id: 'nvidia/nemotron-3.5-lightning:free', context_length: 1000000 },
        ] }), { status: 200 });
      }
      if (u.includes('/v1/model/')) {
        modelEndpointHits++;
      }
      return new Response(null, { status: 404 });
    }));

    const url = 'http://or-cache:8000';
    const engine = getMetricsEngine(url, {}, 'openrouter', ['nvidia/nemotron-3.5-lightning:free']);
    const polls: Array<ReturnType<ServerMetricsEngine['getCachedAggregated']>> = [];
    const sub = engine.subscribe((agg) => { polls.push(agg); });

    await vi.advanceTimersByTimeAsync(0); // initial tick resolves from catalog
    expect(polls[0]?.maxModelLen).toBe(1000000);

    // Several poll intervals later the window is cached and no per-model API is
    // ever called — the shared catalog serves all models.
    await vi.advanceTimersByTimeAsync(3 * 16_000);
    expect(modelEndpointHits).toBe(0);
    expect(polls[0]?.maxModelLen).toBe(1000000);
    sub.dispose();
    vi.useRealTimers();
  });

  it('prunes per-model caches when the model set changes (setModelIds)', async () => {
    vi.useFakeTimers();
    const resolved: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: unknown) => {
      const u = String(url);
      if (u.endsWith('/v1/models')) {
        // Catalog with every configured model as its own full entry.
        return new Response(JSON.stringify({ data: [
          { id: 'a/model-a', context_length: 1000000 },
          { id: 'b/model-b', context_length: 1000000 },
        ] }), { status: 200 });
      }
      return new Response(null, { status: 404 });
    }));

    const url = 'http://or-set:8000';
    const engine = getMetricsEngine(url, {}, 'openrouter', ['a/model-a']);
    const sub = engine.subscribe(() => {});
    await vi.advanceTimersByTimeAsync(0);
    expect(engine.getCachedAggregated()?.contextByModel).toHaveProperty('a/model-a');

    // Add a model — it resolves on the next tick.
    engine.setModelIds(['a/model-a', 'b/model-b']);
    await vi.advanceTimersByTimeAsync(16_000);
    expect(engine.getCachedAggregated()?.contextByModel).toHaveProperty('b/model-b');

    // Remove a model — it stops being resolved and its cache is pruned.
    engine.setModelIds(['a/model-a']);
    await vi.advanceTimersByTimeAsync(3 * 16_000);
    expect(engine.getCachedAggregated()?.contextByModel).not.toHaveProperty('b/model-b');

    // Re-adding the removed model re-resolves (its cache was pruned, not stale).
    engine.setModelIds(['a/model-a', 'b/model-b']);
    await vi.advanceTimersByTimeAsync(16_000);
    expect(engine.getCachedAggregated()?.contextByModel).toHaveProperty('b/model-b');
    expect(resolved).toHaveLength(0); // resolution is in-memory — no per-model calls
    sub.dispose();
    vi.useRealTimers();
  });

  it('releases the engine from the registry when the last subscriber unsubscribes', () => {
    // fetch resolves offline (status 0) so tick() completes quickly without
    // hanging on a real server.
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 0 })));

    const url = 'http://registry-test:8000';
    const first = getMetricsEngine(url);
    const sub = first.subscribe(() => {});
    const shared = getMetricsEngine(url);
    // While subscribed, the registry returns the SAME engine (shared cache).
    expect(shared).toBe(first);

    sub.dispose();
    const after = getMetricsEngine(url);
    // Last subscriber left: the engine was disposed AND removed from the
    // registry. A fresh engine (no stale cache, no orphaned poller) is created.
    expect(after).not.toBe(first);
    expect(after.getCachedRaw()).toBeNull();
    expect(after.getCachedAggregated()).toBeNull();
  });

  it('updateMetricsEngineHeaders updates an existing engine but never creates one', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(async (url: unknown, init?: RequestInit) => {
      const u = String(url);
      if (u.endsWith('/v1/models')) {
        return new Response(JSON.stringify({ data: [{ id: 'm1' }] }), { status: 200 });
      }
      return new Response(null, { status: 404 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const url = 'http://header-update:8000';
    // No engine exists yet — update-if-present is a strict no-op.
    updateMetricsEngineHeaders(url, { Authorization: 'Bearer new' });
    expect(fetchMock).not.toHaveBeenCalled();

    // Create an engine, subscribe (starts polling), then update headers.
    const engine = getMetricsEngine(url, { Authorization: 'Bearer old' });
    const sub = engine.subscribe(() => {});
    await vi.advanceTimersByTimeAsync(16_000);

    updateMetricsEngineHeaders(url, { Authorization: 'Bearer new' });
    // The registry still holds the SAME engine, re-keyed under the NEW identity
    // (looked up with the new headers, not a fresh one)…
    expect(getMetricsEngine(url, { Authorization: 'Bearer new' })).toBe(engine);
    // …and the next poll uses the updated header.
    fetchMock.mockClear();
    await vi.advanceTimersByTimeAsync(16_000);
    const authHeaders = fetchMock.mock.calls.map(([, init]) =>
      (init?.headers as Record<string, string> | undefined)?.Authorization
    );
    expect(authHeaders).toContain('Bearer new');

    sub.dispose();
    vi.useRealTimers();
  });

  it('keys engines by identity so different credentials on one URL stay separate', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(async (url: unknown, init?: RequestInit) => {
      const u = String(url);
      if (u.endsWith('/v1/models')) {
        return new Response(JSON.stringify({ data: [{ id: 'm1' }] }), { status: 200 });
      }
      return new Response(null, { status: 404 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const url = 'http://identity-isolation:8000';
    const engineA = getMetricsEngine(url, { Authorization: 'Bearer secret-a' }, 'openrouter', ['m1']);
    const engineB = getMetricsEngine(url, { Authorization: 'Bearer secret-b' }, 'openrouter', ['m2']);

    // Distinct credentials on one URL → DISTINCT engines (never one engine
    // polling with the wrong model's headers).
    expect(engineA).not.toBe(engineB);

    const subA = engineA.subscribe(() => {});
    const subB = engineB.subscribe(() => {});
    await vi.advanceTimersByTimeAsync(16_000);

    const authHeaders = fetchMock.mock.calls.map(([, init]) =>
      (init?.headers as Record<string, string> | undefined)?.Authorization
    );
    expect(authHeaders).toContain('Bearer secret-a');
    expect(authHeaders).toContain('Bearer secret-b');

    // Same URL + same headers re-uses ONE engine (no duplicate pollers).
    expect(getMetricsEngine(url, { Authorization: 'Bearer secret-a' }, 'openrouter')).toBe(engineA);

    subA.dispose();
    subB.dispose();
    vi.useRealTimers();
  });
});