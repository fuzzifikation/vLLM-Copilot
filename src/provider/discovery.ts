/**
 * Copilot discovery adapter: run the core catalog discovery
 * (`describeModels`) and project each neutral descriptor into a
 * `LanguageModelChatInformation` picker entry.
 *
 * The model facts and the live-inventory skip policy are core policy
 * (`core/catalog/describe.ts`); the picker cache generations, tracked
 * selections and refresh events stay with `provider.ts` (its lifecycle
 * ownership). This function is pure w.r.t. its collaborators: it takes the
 * overrides + a limits probe and returns the picker entries.
 */
import type * as vscode from 'vscode';
import {
  describeModels,
  type ModelConfig,
  type RequestLog,
  type ServerEntry,
} from '../core/index.js';
import { buildModelInfo } from './modelInfo.js';
import type { ProviderClient } from './contracts.js';

export async function discoverModels(
  modelOverrides: ModelConfig[],
  servers: ServerEntry[],
  client: Pick<ProviderClient, 'getModelContextWindow'>,
  output: RequestLog,
  onModelDiscovered?: (modelId: string, contextWindow: number) => void,
  /** Currently selected model mode per picker id (provider-tracked). */
  selectedModeByModel?: ReadonlyMap<string, string>,
  /** Currently selected OUTPUT LENGTH per picker id (provider-tracked). */
  selectedLengthByModel?: ReadonlyMap<string, number>,
): Promise<vscode.LanguageModelChatInformation[]> {
  const descriptors = await describeModels(
    modelOverrides,
    servers,
    client,
    output,
    onModelDiscovered,
    selectedModeByModel,
    selectedLengthByModel,
  );
  return descriptors.map(buildModelInfo);
}
