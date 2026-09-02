import type { ModelConfig } from '../src/config.js';
import type { ServerEntry } from '../src/serverRegistry.js';
import type { LegacyModelConfig } from '../src/registryMigration.js';

/** The registry entry id every factory-built model points at unless overridden. */
export const DEFAULT_TEST_SERVER_ID = 'test-server';

/** URL of the default factory server entry. */
export const DEFAULT_TEST_SERVER_URL = 'http://localhost:8000';

/**
 * A ServerEntry (vllm-copilot.servers item) with the required fields filled in.
 * Pair with makeModelConfig(): models reference entries by `server` id.
 */
export function makeServerEntry(overrides: Partial<ServerEntry> = {}): ServerEntry {
  const { id = DEFAULT_TEST_SERVER_ID, serverUrl = DEFAULT_TEST_SERVER_URL, ...rest } = overrides;
  return { id, serverUrl, ...rest };
}

/** Registry containing just the default entry — the servers[] most resolvers read in tests. */
export function makeServers(...entries: ServerEntry[]): ServerEntry[] {
  return entries.length > 0 ? entries : [makeServerEntry()];
}

/**
 * A ModelConfig with the required fields filled in.
 *
 * Keep this as the only place that knows which fields ModelConfig demands: tests
 * that do not care about the server should not spell it out, and a settings-format
 * change should only have to touch this function plus the tests that assert on the
 * server fields on purpose.
 */
export function makeModelConfig(overrides: Partial<ModelConfig> = {}): ModelConfig {
  const { id = 'test-model', vllmModelId = id, server = DEFAULT_TEST_SERVER_ID, ...rest } = overrides;
  return { id, vllmModelId, server, ...rest };
}

/**
 * Pre-migration (legacy) model settings: per-model serverUrl/requestHeaders/
 * serverType/serverDisplayName. Only migration tests feed these to
 * planRegistryMigration — nothing at runtime reads this shape.
 */
export function makeLegacyModelConfig(overrides: Partial<LegacyModelConfig> = {}): LegacyModelConfig {
  const { id = 'test-model', vllmModelId = id, serverUrl = DEFAULT_TEST_SERVER_URL, ...rest } = overrides;
  return { id, vllmModelId, serverUrl, ...rest };
}
