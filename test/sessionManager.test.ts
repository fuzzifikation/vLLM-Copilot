import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { userDataRootFromGlobalStorage } from '../src/sessionManager.js';

describe('userDataRootFromGlobalStorage', () => {
  it('derives the active user-data root without assuming a VS Code product name', () => {
    const userRoot = path.join('custom-data', 'Code - Insiders', 'User');
    const extensionStorage = path.join(
      userRoot,
      'globalStorage',
      'System-Sciences.vllm-copilot',
    );

    expect(userDataRootFromGlobalStorage(extensionStorage)).toBe(path.resolve(userRoot));
  });
});