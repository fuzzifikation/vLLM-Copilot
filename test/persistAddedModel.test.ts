import * as vscode from 'vscode';
import * as addServerFlow from '../src/commands/addServerFlow.js';
import * as configStore from '../src/configStore.js';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

/**
 * Add-path ordering contract (refactor-plan §3.4): the BYOK utility-model write
 * must start only AFTER the model write resolves. A failed save must never
 * trigger the BYOK bootstrap, and the two writes must not race. The store itself
 * must stay ignorant of `chat.byokUtilityModelDefault`.
 *
 * BYOK is observed through its side effect (the `chat` config `update`) rather
 * than by spying on `ensureByokUtilityDefault` — same-module function calls
 * cannot be intercepted by a namespace spy.
 */
describe('persistAddedModel — BYOK setup after model persistence', () => {
  let chatUpdate: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    // `chat.byokUtilityModelDefault` registered (has a defaultValue) and not
    // explicitly set — so the real ensureByokUtilityDefault writes it.
    chatUpdate = vi.fn().mockResolvedValue(undefined);
    vscode.workspace._mockConfig = {
      get: () => undefined,
      update: chatUpdate,
      inspect: () => ({ defaultValue: 'none' }),
    };
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vscode.workspace._mockConfig = {};
  });

  it('does not start the BYOK write until the model write resolves', async () => {
    let resolveWrite!: (r: configStore.SaveModelResult) => void;
    const replaceSpy = vi
      .spyOn(configStore, 'replaceModelConfig')
      .mockImplementation(
        () => new Promise<configStore.SaveModelResult>((res) => { resolveWrite = res; }),
      );

    const pending = addServerFlow.persistAddedModel({
      id: 'new-model',
      server: 'srv',
    });

    // The model write is still in flight — BYOK must not have started.
    expect(replaceSpy).toHaveBeenCalledTimes(1);
    expect(chatUpdate).not.toHaveBeenCalled();

    resolveWrite({ model: { id: 'new-model', server: 'srv' }, created: true });
    await pending;

    // BYOK write landed once the model write resolved.
    expect(chatUpdate).toHaveBeenCalledWith(
      'byokUtilityModelDefault',
      'mainAgent',
      vscode.ConfigurationTarget.Global,
    );
  });

  it('calls onSaved only after both the model write and BYOK complete', async () => {
    const onSaved = vi.fn();
    vi.spyOn(configStore, 'replaceModelConfig').mockResolvedValue({
      model: { id: 'new-model', server: 'srv' },
      created: true,
    });

    await addServerFlow.persistAddedModel(
      { id: 'new-model', server: 'srv' },
      onSaved,
    );

    // BYOK completed before the onSaved callback fired.
    expect(chatUpdate).toHaveBeenCalledBefore(onSaved);
    expect(onSaved).toHaveBeenCalledTimes(1);
  });
});
