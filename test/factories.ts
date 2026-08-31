import type { ModelConfig } from '../src/config.js';

/** Server URL every factory-built model points at unless overridden. */
export const DEFAULT_TEST_SERVER_URL = 'http://localhost:8000';

/**
 * A ModelConfig with the required fields filled in.
 *
 * Keep this as the only place that knows which fields ModelConfig demands: tests
 * that do not care about the server should not spell it out, and a settings-format
 * change should only have to touch this function plus the tests that assert on the
 * server fields on purpose.
 */
export function makeModelConfig(overrides: Partial<ModelConfig> = {}): ModelConfig {
  const { id = 'test-model', vllmModelId = id, serverUrl = DEFAULT_TEST_SERVER_URL, ...rest } = overrides;
  return { id, vllmModelId, serverUrl, ...rest };
}
