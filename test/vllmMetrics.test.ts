import { describe, it, expect } from 'vitest';
import {
  MetricsParser,
  parseRawMetrics,
  parseLabels,
  fmtPct,
  fmtMs,
  fmtN,
  fmtTokens,
  fmtThroughput,
  shortUrl,
  type ModelAccumulator,
  type RawMetricEntry,
  type ServerRawData,
} from '../src/vllmMetrics.js';

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

  it('attaches description from HELP to histogram suffixes', () => {
    const m = emptyMetrics();
    parseRawMetrics(
      `# HELP vllm:time_to_first_token_seconds Latency in seconds
vllm:time_to_first_token_seconds_sum{model_name="foo"} 3.5
vllm:time_to_first_token_seconds_count{model_name="foo"} 7`,
      m,
    );
    // _count → counter (includes 'count'), _sum → gauge
    const countEntry = m.counters['time_to_first_token_seconds_count']![0];
    expect(countEntry.description).toBe('Latency in seconds');
    const sumEntry = m.gauges['time_to_first_token_seconds_sum']![0];
    expect(sumEntry.description).toBe('Latency in seconds');
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

describe('fmtTokens', () => {
  it('formats null as dash', () => {
    expect(fmtTokens(null)).toBe('—');
  });
  it('formats large numbers in K', () => {
    expect(fmtTokens(4000)).toBe('4K');      // exact multiple → 0 decimals
    expect(fmtTokens(4096)).toBe('4.1K');    // remainder → 1 decimal
    expect(fmtTokens(13312)).toBe('13.3K');  // remainder → 1 decimal
  });
  it('formats small numbers as-is', () => {
    expect(fmtTokens(512)).toBe('512');
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

describe('shortUrl', () => {
  it('extracts hostname:port', () => {
    expect(shortUrl('http://localhost:8000')).toBe('localhost:8000');
    // URL constructor strips default ports (443 for https)
    expect(shortUrl('https://example.com:443/v1')).toBe('example.com:');
    expect(shortUrl('https://example.com:8443/v1')).toBe('example.com:8443');
  });
  it('falls back to stripped URL on invalid input', () => {
    expect(shortUrl('not-a-url')).toBe('not-a-url');
  });
});