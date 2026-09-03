import { describe, it, expect } from 'vitest';
import { extractFamilyWithSource } from '../src/modelInfo.js';

describe('extractFamilyWithSource', () => {

  it('reports fromFallback=true for org-name fallback (GLM/ChatGLM not in list)', () => {
    // GLM — exactly the case the known-bugs doc flagged. Intentionally not in
    // KNOWN_FAMILIES; the authoritative family must come from a preset or HF.
    expect(extractFamilyWithSource('zai-org/GLM-5.2')).toEqual({
      family: 'zai-org',
      fromFallback: true,
    });
  });

  it('matches codellama before llama (longer family wins via iteration order)', () => {
    // codellama is checked first; the substring "llama" appears inside it but
    // the loop returns the codellama match, not llama.
    expect(extractFamilyWithSource('codellama/CodeLlama-34b')).toEqual({
      family: 'codellama',
      fromFallback: false,
    });
  });
});
