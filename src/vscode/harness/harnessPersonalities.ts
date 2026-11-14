/**
 * The FOUR voice presets the extension ships for the DeepSeek Harness, and the
 * whole name-vs-file resolution policy for the harness's session personality.
 *
 * Kept strictly separate from Copilot's personality store (the core store and
 * the seeded global `personalities/` folder): these files live in the
 * extension's OWN `harness-personalities/` directory, are never seeded, never
 * merged into the user's folder, and carry no includes. Each is exactly ONE
 * rule anchored on the recorded DeepSeek Harness identity sentence, and that
 * sentence is the only text any voice may touch (owner ruling 2026-11-14):
 * a RESTRAINED voice replaces it with itself plus one style sentence, a ROAST
 * voice replaces it outright with a two-to-three sentence voice block. No
 * Copilot anchors, no permission or tool changes - the rest of the upstream
 * prompt ships untouched, so a voice cannot quietly rewrite tool policy.
 *
 * The user's choice is stored as the portable preset NAME
 * (`vllm-copilot.harness.personality`), NEVER as a path into this
 * (version-stamped) extension install dir; resolution maps the NAME to this
 * install's bundled file on every load, so a selection survives upgrades and
 * other machines the same way Copilot's name references do - with its own
 * directory, its own whitelist, and zero contact with the other interface.
 */
import * as fs from 'fs'
import * as path from 'path'

/** Extension-root directory holding the bundled harness voice presets. */
export const HARNESS_BUNDLED_PERSONALITIES_DIRNAME = 'harness-personalities'

export interface HarnessVoicePreset {
  /** Portable setting value - the exact string stored in `vllm-copilot.harness.personality`. */
  name: string
  /** File name inside the bundled dir. */
  file: string
  /** Picker description: the exact sentence a restrained voice appends, or a one-line gloss of the block a roast voice substitutes. */
  style: string
}

/**
 * Curated picker order; the package.json enum must carry exactly these names.
 * The two restrained voices append their sentence under the identity sentence;
 * the two roast voices replace it (their `style` is a gloss, not prompt text).
 */
export const HARNESS_VOICE_PRESETS: readonly HarnessVoicePreset[] = [
  { name: 'Supportive Mentor', file: 'supportive-mentor.json', style: 'Be patient and encouraging; explain without patronizing.' },
  { name: 'Critical Senior Dev', file: 'critical-senior-dev.json', style: 'Replaces the identity line: blunt senior engineer, names the defect and the trade-off, no empty praise.' },
  { name: 'Sarcastic Robot', file: 'sarcastic-robot.json', style: 'Replaces the identity line: arrogant robot, dark humor, foul-mouthed about the code, never about the person.' },
  { name: 'Spartan', file: 'spartan.json', style: 'Be terse and concrete; omit filler.' },
]

/** The bundled voices dir inside a given extension install root. */
export function harnessBundledPersonalitiesDir(extensionFsPath: string): string {
  return path.join(extensionFsPath, HARNESS_BUNDLED_PERSONALITIES_DIRNAME)
}

/** Exact (trimmed) name lookup against the whitelist - nothing else can be a preset. */
export function findHarnessVoicePreset(name: string): HarnessVoicePreset | undefined {
  const want = (name || '').trim()
  return want ? HARNESS_VOICE_PRESETS.find((p) => p.name === want) : undefined
}

export interface ResolvedHarnessPersonality {
  /** Absolute path to load on THIS machine. */
  sourcePath: string
  /** Set when the resolved file is a shipped voice preset. */
  preset?: string
}

/**
 * Resolve the harness session personality - the ENTIRE name-vs-file policy in
 * one pure function, over an explicit bundled dir (never a hidden install
 * probe). The preset NAME wins when both references are set; an unknown name
 * or a broken install (bundled file missing) degrades to the FILE reference
 * with a named log; nothing set resolves to nothing = Default, the upstream
 * prompt untouched. The file reference keeps its existing semantics: relative
 * resolution and the existence check are supplied by the caller, exactly as
 * before this module existed.
 */
export function resolveHarnessPersonality(
  settings: { personality: string; personalityFile: string },
  bundledDir: string,
  options?: { resolveRelativePath?: (file: string) => string; onLog?: (message: string) => void },
): ResolvedHarnessPersonality | undefined {
  const onLog = options?.onLog
  const name = (settings.personality || '').trim()
  if (name) {
    const preset = findHarnessVoicePreset(name)
    if (preset) {
      const file = path.join(bundledDir, preset.file)
      if (fs.existsSync(file)) return { sourcePath: file, preset: preset.name }
      onLog?.(`harness voice "${preset.name}" is a shipped preset, but this install has no ${preset.file}; the file reference decides`)
    } else {
      onLog?.(`harness personality "${name}" does not name a shipped voice preset; the file reference decides`)
    }
  }
  const file = (settings.personalityFile || '').trim()
  if (!file) return undefined
  const abs = (options?.resolveRelativePath ?? ((f: string) => f))(file)
  return fs.existsSync(abs) ? { sourcePath: abs } : undefined
}