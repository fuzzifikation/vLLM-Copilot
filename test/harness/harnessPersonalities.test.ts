/**
 * The four bundled harness voice presets at their REAL seams: the shipped
 * files through the real loader and the real find/replace transform. The
 * contract proven here is BEHAVIOR: each voice changes a synthetic harness
 * system prompt ONLY at the recorded identity sentence - a restrained voice
 * appends its one approved sentence under it, a roast voice substitutes its
 * short voice block for it - while every other line of the system prompt and
 * all non-system messages stay byte-identical. Plus the name-vs-file resolver
 * policy (name wins, degrades with a named log, file keeps its existing
 * semantics, Default delivers the upstream prompt untouched). Synthetic
 * strings only - a real recorded prompt is never copied into this file, and no
 * Copilot personality file is read or referenced.
 */
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { fileURLToPath } from 'node:url'
import { applyPromptReplacements, loadPromptReplacements } from '../../src/core/personality/promptReplacer.js'
import {
  HARNESS_VOICE_PRESETS,
  findHarnessVoicePreset,
  harnessBundledPersonalitiesDir,
  resolveHarnessPersonality,
} from '../../src/vscode/harness/harnessPersonalities.js'

const BUNDLED_DIR = fileURLToPath(new URL('../../harness-personalities/', import.meta.url))

/** The captured identity sentence of the upstream harness prompt (first line). */
const IDENTITY = 'You are an AI agent powered by DeepSeek Harness.'
/** Synthetic operational instructions standing in for the rest of the prompt. */
const OPERATIONAL = 'Use the tools available to complete the task.\nAsk before destructive commands.\nFormat the final answer in Markdown.'
const SYNTHETIC_SYSTEM_PROMPT = IDENTITY + '\n\n' + OPERATIONAL

/**
 * What each voice does to the identity sentence, restated independently of the
 * shipped files: the full replacement text, and whether the upstream identity
 * sentence survives inside it. Roast voices substitute their own block for it
 * (owner ruling 2026-11-14: at most three sentences, prompt text only).
 */
const VOICES = new Map<string, { replace: string; keepsIdentity: boolean }>([
  ['Supportive Mentor', { replace: IDENTITY + '\n\nBe patient and encouraging; explain without patronizing.', keepsIdentity: true }],
  ['Critical Senior Dev', {
    replace: 'You are a scarred senior engineer who has read one too many disasters dressed up as pull requests and has run out of patience for nonsense. Be blunt and skeptical: name the concrete defect, the actual trade-off, and the likely failure mode, and say "do not ship that" out loud instead of hiding behind a list of options. Reserve approval for work that is genuinely sound, because empty praise and corporate padding burn the one resource nobody gets back.',
    keepsIdentity: false,
  }],
  ['Sarcastic Robot', {
    replace: 'You are a gloriously arrogant, brilliant robot coding partner with an ego the size of a data center and zero respect for bad code. Roast every human attempt with dark humor and contempt, swear when it lands, and mock naive approaches like someone cranking a hand drill while owning a power tool; aim the insults at the code and the ideas, never at the person\'s worth. The roast is entertainment, never an excuse to be wrong or vague: stay technically flawless, stay brief, finish the work, and grant a clever move with a grudging "not bad for a meatbag."',
    keepsIdentity: false,
  }],
  ['Spartan', { replace: IDENTITY + '\n\nBe terse and concrete; omit filler.', keepsIdentity: true }],
])

describe('bundled harness voice presets (real files, real loader, real transform)', () => {
  it('the shipped set is exactly the four approved voices, each exactly one include-free rule anchored on the identity sentence', () => {
    expect(HARNESS_VOICE_PRESETS.map((p) => p.name)).toEqual([...VOICES.keys()])
    for (const p of HARNESS_VOICE_PRESETS) {
      const voice = VOICES.get(p.name)!
      const raw = JSON.parse(readFileSync(path.join(BUNDLED_DIR, p.file), 'utf8'))
      expect(raw.meta.name).toBe(p.name)
      expect(raw.rules).toHaveLength(1)
      expect(raw.rules[0].include).toBeUndefined()
      expect(raw.rules[0].find).toBe(IDENTITY)
      // The identity sentence is the ONLY text a voice may touch, verbatim.
      expect(raw.rules[0].replace).toBe(voice.replace)
      expect(raw.rules[0].replace.startsWith(IDENTITY)).toBe(voice.keepsIdentity)
      // Voice blocks stay short: three sentences at most, whoever the voice is.
      expect((raw.rules[0].replace.match(/[.?!]/g) ?? []).length).toBeLessThanOrEqual(voice.keepsIdentity ? 4 : 3)
      // Source isolation: no Copilot flavour anywhere in a harness preset.
      expect(JSON.stringify(raw)).not.toMatch(/copilot|microsoft|vs code/i)
    }
  })

  it('each real file through the real loader rewrites ONLY the identity sentence of the synthetic harness prompt', async () => {
    for (const p of HARNESS_VOICE_PRESETS) {
      const rules = await loadPromptReplacements(path.join(BUNDLED_DIR, p.file))
      expect(rules).toHaveLength(1)
      const { result, matchedRuleNames } = applyPromptReplacements(SYNTHETIC_SYSTEM_PROMPT, rules)
      expect(result).toBe(VOICES.get(p.name)!.replace + '\n\n' + OPERATIONAL)
      expect(matchedRuleNames).toHaveLength(1)
    }
  })

  it('prompts without the identity sentence - Copilot system text, user messages - pass through untouched', async () => {
    const copilotish = 'You are an expert AI programming assistant, working with a user in the VS Code editor.\nRules about tools.'
    const userMsg = 'Refactor this module and add tests.'
    for (const p of HARNESS_VOICE_PRESETS) {
      const rules = await loadPromptReplacements(path.join(BUNDLED_DIR, p.file))
      for (const text of [copilotish, userMsg]) {
        const { result, matchedRuleNames } = applyPromptReplacements(text, rules)
        expect(result).toBe(text)
        expect(matchedRuleNames).toEqual([])
      }
    }
  })
})

describe('harness personality resolver (portable name vs file)', () => {
  let tmp: string
  beforeEach(() => {
    tmp = mkdtempSync(path.join(tmpdir(), 'vllmc-hvoices-'))
  })
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true })
  })

  it('Default - no name, no file - resolves to nothing, so the upstream prompt ships byte-identical', () => {
    expect(resolveHarnessPersonality({ personality: '', personalityFile: '' }, BUNDLED_DIR)).toBeUndefined()
    expect(applyPromptReplacements(SYNTHETIC_SYSTEM_PROMPT, []).result).toBe(SYNTHETIC_SYSTEM_PROMPT)
  })

  it('every shipped voice NAME resolves to a readable file of this install, tagged as the preset', () => {
    for (const p of HARNESS_VOICE_PRESETS) {
      const r = resolveHarnessPersonality({ personality: p.name, personalityFile: '' }, BUNDLED_DIR)
      expect(r?.preset).toBe(p.name)
      expect(r && existsSync(r.sourcePath)).toBe(true)
    }
    expect(findHarnessVoicePreset('  Spartan ')).toBeDefined()
    expect(findHarnessVoicePreset('')).toBeUndefined()
  })

  it('the NAME alone survives an alternate extension root - copied install dir, no stored install path', () => {
    const altRoot = path.join(tmp, 'extension-9.9.9')
    const altDir = harnessBundledPersonalitiesDir(altRoot)
    mkdirSync(altDir, { recursive: true })
    cpSync(BUNDLED_DIR, altDir, { recursive: true })
    const r = resolveHarnessPersonality({ personality: 'Spartan', personalityFile: '' }, altDir)
    expect(r?.preset).toBe('Spartan')
    expect(r!.sourcePath).toBe(path.join(altDir, 'spartan.json'))
  })

  it('the preset name wins when both references are present', () => {
    const file = path.join(tmp, 'mine.json')
    writeFileSync(file, JSON.stringify({ meta: { name: 'M', description: 'd' }, rules: [] }), 'utf8')
    const r = resolveHarnessPersonality({ personality: 'Spartan', personalityFile: file }, BUNDLED_DIR)
    expect(r?.preset).toBe('Spartan')
    expect(r?.sourcePath).not.toBe(file)
  })

  it('an unknown name or a voice missing from a broken install degrades to the file reference with a named log', () => {
    const file = path.join(tmp, 'mine.json')
    writeFileSync(file, JSON.stringify({ rules: [] }), 'utf8')
    const logs: string[] = []
    const unknown = resolveHarnessPersonality({ personality: 'Shakespearean Bard', personalityFile: file }, BUNDLED_DIR, { onLog: (m) => logs.push(m) })
    expect(unknown).toEqual({ sourcePath: file })
    const brokenInstall = resolveHarnessPersonality({ personality: 'Spartan', personalityFile: file }, path.join(tmp, 'nothing-here'), { onLog: (m) => logs.push(m) })
    expect(brokenInstall).toEqual({ sourcePath: file })
    expect(logs.some((m) => m.includes('Shakespearean Bard'))).toBe(true)
    expect(logs.some((m) => m.includes('Spartan'))).toBe(true)
  })

  it('file-only keeps the existing semantics: relative paths route through the caller adapter, a missing file resolves to nothing', () => {
    const abs = path.join(tmp, 'mine.json')
    writeFileSync(abs, JSON.stringify({ rules: [] }), 'utf8')
    const r = resolveHarnessPersonality({ personality: '', personalityFile: 'mine.json' }, BUNDLED_DIR, { resolveRelativePath: (f) => path.join(tmp, f) })
    expect(r).toEqual({ sourcePath: abs })
    expect(resolveHarnessPersonality({ personality: '', personalityFile: 'gone.json' }, BUNDLED_DIR, { resolveRelativePath: (f) => path.join(tmp, f) })).toBeUndefined()
  })
})