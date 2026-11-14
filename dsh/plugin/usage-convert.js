import { randomUUID } from 'node:crypto'
import { mkdirSync, renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'

/**
 * Core `WireUsage` uses aggregate prompt semantics (`cached_tokens` is a SUBSET
 * of `prompt_tokens`). dsh `TokenUsage` counts are DISJOINT: `inputTokens`
 * excludes cache reads/writes. Convert explicitly and keep the authoritative
 * total, or the harness context ring silently under-reports every cached turn.
 */
export function toDshUsage(wire) {
  const cacheRead = wire.prompt_tokens_details?.cached_tokens ?? 0
  // The core's own consumer (request/execute.ts, LastRequestData build) reads
  // `created_cache_tokens` from this very wire object; the ledger's numbers are
  // computed from that name, so reading a different one here split one object
  // across two spellings and silently dropped every cache write. The core's
  // name is authoritative; the alternative stays as a relay-compat fallback.
  const cacheWrite = wire.prompt_tokens_details?.created_cache_tokens ?? wire.prompt_tokens_details?.cache_write_tokens ?? 0
  const usage = {
    inputTokens: Math.max(0, wire.prompt_tokens - cacheRead - cacheWrite),
    outputTokens: wire.completion_tokens,
    totalTokens: wire.total_tokens || wire.prompt_tokens + wire.completion_tokens,
  }
  if (cacheRead > 0) usage.cacheReadTokens = cacheRead
  if (cacheWrite > 0) usage.cacheWriteTokens = cacheWrite
  const reasoning = wire.completion_tokens_details?.reasoning_tokens
  if (reasoning > 0) usage.reasoningTokens = reasoning
  return usage
}

/**
 * Sum converted dsh usages across a retried turn's attempts. dsh counters are
 * disjoint (see above), so per-field addition is exact; the optional cache and
 * reasoning fields survive iff any attempt had them.
 */
export function sumDshUsages(usages) {
  const out = { inputTokens: 0, outputTokens: 0, totalTokens: 0 }
  for (const u of usages) {
    out.inputTokens += u.inputTokens
    out.outputTokens += u.outputTokens
    out.totalTokens += u.totalTokens
    for (const key of ['cacheReadTokens', 'cacheWriteTokens', 'reasoningTokens']) {
      if (u[key] > 0) out[key] = (out[key] ?? 0) + u[key]
    }
  }
  return out
}

/**
 * One JSON file per completed attempt in the outbox; the bridge ingests and
 * deletes them into the main extension's canonical ledger. Write is tmp+rename
 * so a crash never leaves a half-written record that double-counts on retry.
 */
export function writeUsageRecord(outboxDir, { sessionId, purpose, model, wireModelId, lastRequest, elapsedMs }) {
  mkdirSync(outboxDir, { recursive: true })
  const record = {
    schema: 1,
    recordId: `${Date.now()}-${randomUUID().slice(0, 8)}`,
    recordedAt: new Date().toISOString(),
    sessionId: sessionId ?? null,
    purpose: purpose ?? null,
    model,
    wireModelId,
    elapsedMs,
    lastRequest,
  }
  const target = path.join(outboxDir, `${record.recordId}.json`)
  writeFileSync(`${target}.tmp`, JSON.stringify(record))
  renameSync(`${target}.tmp`, target)
  return target
}
