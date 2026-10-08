/**
 * The served-model verdict: does a server RIGHT NOW serve this configured model?
 *
 * One verdict, exported once; the REACTIONS stay with each consumer and are
 * deliberately different (this is the P1 ruling from the dsh bridge,
 * dsh-vllm-bridge repo docs/dsh-bridge-plan.md): the Copilot picker drops `absent` AND `unknown`
 * models — the live-inventory ruling in `describe.ts` — while the harness
 * prunes only `absent`, because refusing to boot over a network hiccup
 * punishes the user for a fact nobody verified. What lives here is the answer
 * to "is it alive", never what to do about it.
 *
 * Rules, each earned by an incident or a ruling:
 *  - `unknown` means "could not ask" (probe failed OR the list came back
 *    EMPTY) and is never `absent`. An empty answer is not "serves nothing":
 *    a server mid-swap answers honestly and emptily. A consumer that prunes
 *    on unknown empties a healthy catalog — the 0.0.12 bridge accident.
 *  - Membership is EXACT wire-id matching against the backend's authoritative
 *    list (`listServerModels`), the same rule Test & Refresh applies.
 *  - The backend type is the CONFIGURED chain (`resolveServerType`: entry
 *    type, else 'vllm'), never live detection — this must agree with what the
 *    request path and the picker's resolvers actually use, not re-probe a
 *    second truth. `detectServerType` classifies servers the user has not
 *    classified yet (the Add flow); a configured entry is already answered.
 *  - A model whose `server` ref dangles is `absent`, not `unknown`: nothing
 *    can bring it back except fixing the config, and every consumer already
 *    treats the dangling ref as unofferable.
 *  - No cache layer here: `listServerModels` and the resolvers share the
 *    core's short-TTL memo with in-flight dedupe, and a failed probe is never
 *    cached past the TTL. Consumers never need a clear call.
 *  - On OpenRouter the verdict is CATALOG MEMBERSHIP ONLY — the catalog is
 *    global and public, so entry credentials are never probed here. "served"
 *    says the model exists on OpenRouter, not that this entry's key works;
 *    only the request path answers that.
 */
import { resolveConfigId, resolveServerConfig, resolveServerType, resolveVllmModelId } from '../config/config.js';
import type { ModelConfig } from '../config/config.js';
import type { ServerEntry } from '../config/serverRegistry.js';
import { describeError } from '../shared/errors.js';
import { listServerModels } from '../backends/runtimeLimits.js';

/** `served` = on the list. `absent` = the list demonstrably lacks it.
 *  `unknown` = the answer could not be obtained (or was empty). */
export type ModelServedState = 'served' | 'absent' | 'unknown';

export interface ModelServedVerdict {
  readonly state: ModelServedState;
  /** Human sentence explaining `absent`/`unknown`; absent for `served`. */
  readonly reason?: string;
}

/**
 * Resolve one verdict per configured model, keyed by config id
 * (`resolveConfigId`) — wire ids are NOT unique across servers, so keying
 * the report by wire id would collide the moment the same model is
 * configured on two hosts. Every model with a resolvable config id gets an
 * entry; consumers look up, never guess about omissions.
 *
 * One `listServerModels` probe per server group (grouped by server ref — the
 * backend type lives on the entry, so a group is one endpoint by
 * construction), groups resolved in parallel. Across calls and surfaces the
 * probes additionally collapse in the core's shared server-list memo.
 */
export async function resolveServedModels(
  models: ModelConfig[],
  servers: ServerEntry[],
): Promise<ReadonlyMap<string, ModelServedVerdict>> {
  const verdicts = new Map<string, ModelServedVerdict>();

  // Group by the raw server ref — every model with the same ref resolves to
  // the same entry (resolveServer is first-match, deterministic), so one
  // probe per group addresses them all.
  const groups = new Map<string, ModelConfig[]>();
  for (const model of models) {
    const configId = resolveConfigId(model);
    if (!configId) continue; // no id AND no wire id — garbage entry, nothing to key
    const group = groups.get(model.server);
    if (group) group.push(model);
    else groups.set(model.server, [model]);
  }

  const settle = (group: readonly ModelConfig[], verdict: ModelServedVerdict): void => {
    for (const model of group) {
      const configId = resolveConfigId(model);
      if (configId) verdicts.set(configId, verdict);
    }
  };

  await Promise.all(
    [...groups.entries()].map(async ([serverRef, group]) => {
      const server = resolveServerConfig(group[0]!, servers);
      if (!server) {
        // Dangling ref — see the module header: absent, loudly, not unknown.
        settle(group, {
          state: 'absent',
          reason: `server "${serverRef}" is not in the registry — fix the reference or re-add the server`,
        });
        return;
      }
      const serverType = resolveServerType(group[0]!, servers);

      let servedIds: Set<string>;
      try {
        const listed = await listServerModels(serverType, server.serverUrl, server.requestHeaders);
        if (listed.length === 0) {
          settle(group, {
            state: 'unknown',
            reason: `${server.serverUrl} answered but listed no models — treated as "could not ask", never as "serves nothing"`,
          });
          return;
        }
        servedIds = new Set(listed.map((entry) => entry.id));
      } catch (err) {
        settle(group, { state: 'unknown', reason: `could not ask ${server.serverUrl}: ${describeError(err)}` });
        return;
      }

      for (const model of group) {
        const configId = resolveConfigId(model);
        if (!configId) continue;
        const wireId = resolveVllmModelId(model);
        if (!wireId) {
          verdicts.set(configId, { state: 'absent', reason: 'entry carries neither an id nor a vllmModelId' });
        } else if (servedIds.has(wireId)) {
          verdicts.set(configId, { state: 'served' });
        } else {
          verdicts.set(configId, { state: 'absent', reason: `"${wireId}" is not in ${server.serverUrl}'s model list` });
        }
      }
    }),
  );

  return verdicts;
}
