import { describe, it, expect, afterEach, vi } from 'vitest';
import * as vscode from 'vscode';
import { VllmChatModelProvider } from '../src/provider.js';

function makeProvider(): VllmChatModelProvider {
  return new VllmChatModelProvider(
    { extension: { extensionKind: vscode.ExtensionKind.UI } } as any,
    { appendLine: vi.fn() } as any,
  );
}

describe('system message processing', () => {
  afterEach(() => {
    vscode.workspace._mockConfig = {};
    (vscode.workspace as any).workspaceFolders = undefined;
  });

  it('captures system messages when no replacements are configured', async () => {
    vscode.workspace._mockConfig = {
      get: (key: string) => key === 'systemMessageCapture' ? true : undefined,
    };

    const provider = makeProvider();
    const captureToDisk = vi.spyOn(provider as any, 'captureToDisk').mockResolvedValue(undefined);
    const systemMessage = {
      role: vscode.LanguageModelChatMessageRole.System,
      content: [new vscode.LanguageModelTextPart('original system prompt')],
    };

    const result = await (provider as any).processSystemMessages(
      { id: 'model' },
      [systemMessage],
      { models: [{ id: 'model' }], enableFileLogging: false },
    );

    expect(result).toEqual([systemMessage]);
    expect(captureToDisk).toHaveBeenCalledWith([
      {
        receivedContent: 'original system prompt',
        deliveredContent: 'original system prompt',
        rulesApplied: [],
      },
    ]);
  });
});