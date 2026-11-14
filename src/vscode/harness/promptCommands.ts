/**
 * Harness prompt commands: the session-wide personality choice and the
 * prompt recording, kept strictly separate from Copilot's per-model
 * personality machinery. Copilot reads model.personality /
 * model.systemMessageReplacementsFile and writes
 * `<workspace>/.vllm/system-messages.json`; the harness reads
 * `vllm-copilot.harness.personalityFile` and records to its OWN file in the
 * same folder, `<workspace>/.vllm/dsh-system-messages.json` - consented by
 * the capture marker in harness storage, and NAMED INTO THE SNAPSHOT by this
 * window (the plugin never guesses a location from cwd or a home; no
 * workspace, no recording). Neither interface falls back to the other's
 * choice or the other's file - that leak is exactly what this file makes
 * impossible.
 *
 * Three commands, no more:
 * - Set Harness Personality...  (Default / bundled voices / detected files / Load / Create / Edit current)
 * - Toggle Harness Prompt Recording (setting + live consent marker; refuses
 *   to turn ON with no workspace folder, because an opt-in with no legal
 *   destination would be a lie waiting for a victim)
 * - Open Harness Recording    (this window's workspace recording; when the
 *   shared harness was prepared by another window's workspace, says exactly
 *   where the running recording lives instead of inventing an empty success)
 *
 * Binding truth: the recording target lives in the snapshot, and a snapshot
 * is (re)written only by PREPARE - which a plain start SKIPS when it adopts
 * a survivor. Re-pointing a running harness at THIS window therefore requires
 * Restart (drained stop + fresh prepare + spawn). Every message says exactly
 * that; none of them may claim Start reroutes anything.
 *
 * Each handler runs under one outer guard: anything that escapes is logged
 * with harness context and named to the user with the log one click away -
 * never a silent default, never a raw stack toast. Directory trouble is an
 * error, not an empty shelf: only ENOENT reads as ordinary absence.
 */
import * as fs from 'fs/promises';
import * as path from 'path';
import * as vscode from 'vscode';
import { existsSync, readFileSync } from 'fs';
import { loadPromptReplacements, readCaptureConsent, writeCaptureConsent } from '../../core/index.js';
import { loadPersonalityMeta } from '../../core/personality/promptReplacer.js';
import { resolveWorkspaceRelativePath } from '../state/config.js';
import { HARNESS_RECORDING_FILENAME, harnessRecordingFileFor } from './snapshot.js';
import type { BridgePaths } from './paths.js';
import { readBridgeSettings } from './settings.js';
import { HARNESS_VOICE_PRESETS } from './harnessPersonalities.js';
import { readPidRecord } from './supervisor.js';

/** Subdirectory of global storage holding the user's harness personality files. */
export const HARNESS_PERSONALITIES_DIR = 'harness-personalities';

const isEnoent = (err: unknown) => (err as NodeJS.ErrnoException)?.code === 'ENOENT';

export interface HarnessPromptCommandDeps {
  context: vscode.ExtensionContext;
  paths: BridgePaths;
  log: { info(message: string): void; warn(message: string): void; error(message: string): void };
  /** Whether the harness runtime is installed (wording only; commands work either way). */
  isInstalled: () => boolean;
}

export function harnessPersonalitiesDir(context: vscode.ExtensionContext): string {
  return path.join(context.globalStorageUri.fsPath, HARNESS_PERSONALITIES_DIR);
}

/**
 * How a picked harness personality file is stored in the setting: workspace-
 * relative (forward slashes) under the first workspace folder, absolute as
 * picked otherwise - the same rule Copilot's own file reference uses, applied
 * to the harness's OWN setting.
 */
export function harnessFileStoragePath(picked: string): string {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (root) {
    const rel = path.relative(root, picked);
    if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) {
      return rel.split(path.sep).join('/');
    }
  }
  return picked;
}

/**
 * Same-file check for the picker's current-file mark: normalize separators,
 * then case-fold ONLY where the filesystem is case-insensitive (Windows).
 * A blind toLowerCase conflated two distinct files on case-sensitive systems.
 */
export function equivalentHarnessPath(a: string, b: string): boolean {
  const norm = (p: string) => {
    const slashes = p.replace(/[\\/]+$/, '').split(/[\\/]/).join(path.sep);
    return process.platform === 'win32' ? slashes.toLowerCase() : slashes;
  };
  return norm(a) === norm(b);
}

/**
 * Scan the harness personality folder for files with valid `meta` blocks.
 * An absent folder is ordinary (nothing created yet); a folder the OS refuses
 * to read is a failure the caller must hear about, not a success-shaped "no
 * personalities". A single unreadable file is already surfaced by the picker
 * row (loadPersonalityMeta answers null, the row says so) - one rotten file
 * must not blank the whole shelf.
 */
export async function scanHarnessPersonalities(dir: string): Promise<{ name: string; description: string; filePath: string }[]> {
  const out: { name: string; description: string; filePath: string }[] = [];
  let names: string[];
  try {
    names = await fs.readdir(dir);
  } catch (err) {
    if (isEnoent(err)) return out;
    throw err;
  }
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const filePath = path.join(dir, name);
    const meta = await loadPersonalityMeta(filePath);
    if (meta) out.push({ name: meta.name, description: meta.description, filePath });
    else out.push({ name: `${name} (no meta.name - rules may still load)`, description: `Stored at ${filePath}`, filePath });
  }
  return out;
}

/**
 * Template for "+ Create": empty rules, harness-honest wording, no Copilot
 * include. `dir` goes into the meta.howTo line (the loader ignores extra meta
 * fields) because "the suggested folder" is only a suggestion the user can
 * actually reach - name it or don't say it.
 */
export function harnessPersonalityTemplate(dir: string): string {
  return JSON.stringify(
    {
      meta: {
        name: 'My Harness Personality',
        description:
          'Find/replace rules for the DeepSeek Harness system prompt (session-wide, applied to every harness request). ' +
          'Rules here must anchor the HARNESS prompt, not Copilot\'s - run "DeepSeek Harness: Toggle Harness Prompt Recording", ' +
          'send one message, then "DeepSeek Harness: Open Harness Recording" and copy the exact text from receivedContent. ' +
          'Each rule: { "ruleName": "...", "find": "exact substring", "replace": "replacement text" }. Empty replace removes the match.',
        howTo:
          `Save this file under your own file name into ${dir} and it appears in "Set Harness Personality..." automatically - ` +
          'or save it anywhere and attach it with "Load a file...". Nothing is attached or written until you do.',
      },
      rules: [],
    },
    null,
    2,
  );
}

async function setHarnessPersonalityFile(stored: string): Promise<void> {
  await vscode.workspace.getConfiguration('vllm-copilot.harness').update('personalityFile', stored, vscode.ConfigurationTarget.Global);
}

/** The bundled voice reference: a portable NAME ('' = none). A separate setting
 *  from the file reference; the harness resolves name-over-file. */
async function setHarnessPersonalityName(name: string): Promise<void> {
  await vscode.workspace.getConfiguration('vllm-copilot.harness').update('personality', name, vscode.ConfigurationTarget.Global);
}

/**
 * Push the recording setting to the on-disk consent marker the dsh process
 * re-reads at every capture. A harness home that does not exist is left
 * untouched: dormant means no folders (prepare seeds the marker from the
 * setting at first start, and refuses to launch when the write fails).
 * Returns what happened so callers can be honest.
 */
export function syncCaptureMarker(
  paths: BridgePaths,
  enabled: boolean,
  log: { error(message: string): void; info(message: string): void },
): { folderExists: boolean; error?: string } {
  if (!existsSync(paths.vllmc)) return { folderExists: false };
  try {
    writeCaptureConsent(paths.captureFlag, enabled);
    log.info(`capture consent marker set to "${enabled ? 'on' : 'off'}"`);
    return { folderExists: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error(`capture consent marker write failed: ${message}`);
    return { folderExists: true, error: message };
  }
}

/**
 * The recording target for THIS window: the first workspace folder's
 * `.vllm\dsh-system-messages.json` - the same first-folder rule the Copilot
 * capture uses, a deliberately different file. undefined = no folder open.
 */
export function workspaceRecordingFile(): string | undefined {
  const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
  return folder ? harnessRecordingFileFor(folder) : undefined
}

/**
 * The target the RUNNING harness actually writes: whatever the shared
 * snapshot names right now. That is the recording's owner - the workspace of
 * the window that last prepared - and an adopting window must name that
 * truth instead of pretending its own file is filling up. Config bytes only;
 * the snapshot never carries prompt text. Absent/unreadable/relative all
 * answer undefined: nothing has named a destination.
 */
export function snapshotRecordingFile(snapshotFile: string): string | undefined {
  let raw: string
  try {
    raw = readFileSync(snapshotFile, 'utf8')
  } catch {
    return undefined
  }
  try {
    const candidate = (JSON.parse(raw) as { captureFile?: unknown }).captureFile
    if (typeof candidate !== 'string' || !candidate.trim()) return undefined
    const trimmed = candidate.trim()
    return path.isAbsolute(trimmed) ? trimmed : undefined
  } catch {
    return undefined
  }
}

export function registerHarnessPromptCommands(deps: HarnessPromptCommandDeps): vscode.Disposable[] {
  const { context, paths, log } = deps;

  /** One outer net per command: log the real cause, tell the user what
   *  failed and where the log is. Handlers keep their small, specific
   *  catches (a bad file pick gets a named rejection, not this net). */
  function guarded(what: string, body: () => Promise<void>): Promise<void> {
    return body().catch((err) => {
      const message = err instanceof Error ? err.message : String(err);
      log.error(`${what} failed: ${message}`);
      void vscode.window
        .showErrorMessage(`DeepSeek Harness: ${what} failed: ${message}`, 'Show Log')
        .then((choice) => {
          if (choice === 'Show Log') void vscode.commands.executeCommand('vllm-copilot.harness.showLogs');
        });
    });
  }

  async function runSetPersonality(): Promise<void> {
    const harnessSettings = readBridgeSettings();
    const currentName = harnessSettings.personality;
    const currentStored = harnessSettings.personalityFile;
    const currentAbs = currentStored ? resolveWorkspaceRelativePath(currentStored) : '';
    const dir = harnessPersonalitiesDir(context);
    const found = await scanHarnessPersonalities(dir);

    type Pick = vscode.QuickPickItem & { action?: 'default' | 'create' | 'load' | 'edit'; filePath?: string; presetName?: string };
    const items: Pick[] = [
      {
        label: currentStored || currentName ? 'Default (upstream DeepSeek Harness prompt)' : '$(check) Default (upstream DeepSeek Harness prompt)',
        description: 'No replacements - dsh sends its own prompt untouched',
        action: 'default',
      },
      { label: 'Bundled harness voices (one rule on the prompt identity line)', kind: vscode.QuickPickItemKind.Separator },
    ];
    for (const voice of HARNESS_VOICE_PRESETS) {
      const isCurrent = !!currentName && voice.name === currentName;
      items.push({
        label: isCurrent ? `$(check) ${voice.name}` : voice.name,
        description: [voice.style, isCurrent ? 'current' : undefined].filter(Boolean).join(' \u00b7 '),
        presetName: voice.name,
      });
    }
    if (found.length > 0) {
      items.push({ label: 'Harness personality files', kind: vscode.QuickPickItemKind.Separator });
      for (const f of found) {
        const isCurrent = !!currentAbs && equivalentHarnessPath(f.filePath, currentAbs);
        items.push({
          label: isCurrent ? `$(check) ${f.name}` : f.name,
          description: [f.description, isCurrent ? 'current' : undefined].filter(Boolean).join(' \u00b7 '),
          filePath: f.filePath,
        });
      }
    }
    items.push({ label: '', kind: vscode.QuickPickItemKind.Separator });
    if (currentAbs) {
      items.push({ label: '$(edit) Edit current file\u2026', description: currentStored, action: 'edit' });
    }
    items.push({ label: '$(folder-opened) Load a file\u2026', description: 'Attach any replacements JSON', action: 'load' });
    items.push({
      label: '$(plus) Create a new harness personality\u2026',
      description: `Opens an empty template - save it into ${dir} (or anywhere) and attach it with "Load a file\u2026"`,
      action: 'create',
    });

    const pick = await vscode.window.showQuickPick(items, {
      title: 'DeepSeek Harness: Set Personality',
      placeHolder: 'Current: ' + (currentName || (currentStored ? path.basename(currentStored) : 'Default (upstream prompt)')),
      ignoreFocusOut: true,
    });
    if (!pick || pick.kind === vscode.QuickPickItemKind.Separator) return;

    if (pick.action === 'default') {
      await setHarnessPersonalityName('');
      await setHarnessPersonalityFile('');
      await answerPersonality('The harness runs the upstream DeepSeek Harness prompt, untouched.');
      return;
    }
    if (pick.presetName) {
      // Bundled voice: store the PORTABLE NAME and clear the file reference.
      // The name resolves into THIS install's bundled dir at every load, so
      // the choice survives upgrades and never bakes an install path into settings.
      await setHarnessPersonalityFile('');
      await setHarnessPersonalityName(pick.presetName);
      await answerPersonality(`Harness voice: ${pick.presetName}`);
      return;
    }
    if (pick.action === 'create') {
      const doc = await vscode.workspace.openTextDocument({ language: 'json', content: harnessPersonalityTemplate(dir) });
      await vscode.window.showTextDocument(doc);
      void vscode.window.showInformationMessage(
        `Harness personality template opened in a new editor - nothing is written or attached yet. Save it under your own file name into ${dir} and it appears in this picker automatically, or save it anywhere and attach it with \u201cLoad a file\u2026\u201d.`,
      );
      return;
    }
    if (pick.action === 'edit') {
      await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(currentAbs));
      return;
    }
    let filePath: string | undefined;
    if (pick.action === 'load') {
      const picked = await vscode.window.showOpenDialog({
        canSelectFiles: true,
        canSelectFolders: false,
        canSelectMany: false,
        filters: { 'Harness personality JSON': ['json'] },
        title: 'Attach a harness personality replacements file',
      });
      filePath = picked?.[0]?.fsPath;
      if (!filePath) return;
    } else {
      filePath = pick.filePath;
    }
    if (!filePath) return;
    // Same doctrine as Copilot's Load: a file the loader had to degrade over
    // (missing/broken include) is NOT attached - fixable at pick time, a
    // half-applying lie at request time. Parse/rule garbage throws outright.
    const degradations: string[] = [];
    try {
      await loadPromptReplacements(filePath, (warning, kind) => {
        if (kind === 'include-failed') degradations.push(warning);
      });
    } catch (err) {
      void vscode.window.showErrorMessage(`Not a usable harness personality file: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    if (degradations.length > 0) {
      void vscode.window.showErrorMessage(`Not a usable harness personality file: ${degradations[0]}`);
      return;
    }
    const stored = harnessFileStoragePath(filePath);
    // A custom file and a bundled voice are mutually exclusive: attaching one clears the other.
    await setHarnessPersonalityName('');
    await setHarnessPersonalityFile(stored);
    await answerPersonality(`Harness personality: ${path.basename(filePath)}`);
  }

  /** Shared honest closer: the choice persists; a running harness swaps it at
   *  the drained restart the settings listener already schedules. */
  async function answerPersonality(headline: string): Promise<void> {
    const running = readPidRecord(paths.pid) !== undefined && deps.isInstalled();
    void vscode.window.showInformationMessage(
      running
        ? `${headline}. A running harness applies it at the next drained restart; a stopped one on its next start.`
        : `${headline}. It applies when the harness next starts.`,
    );
    log.info(headline);
  }

  async function runToggleRecording(): Promise<void> {
    const cfg = vscode.workspace.getConfiguration('vllm-copilot.harness');
    const was = readBridgeSettings().captureSystemMessages;
    const next = !was;
    const dest = workspaceRecordingFile();
    if (next && !dest) {
      // An opt-in with no destination would only manufacture a confident lie.
      // The recording has exactly one legal home - the workspace file - and
      // this window is not inside one. Refuse with the fix, write no flag.
      log.warn(`harness prompt recording not enabled: no workspace folder to hold .vllm\\${HARNESS_RECORDING_FILENAME}`);
      void vscode.window.showWarningMessage(
        `DeepSeek Harness: prompt recordings live in the workspace at .vllm\\${HARNESS_RECORDING_FILENAME}, and this window has no folder open. Recording was NOT turned on - open a folder and toggle again.`,
      );
      return;
    }
    await cfg.update('captureSystemMessages', next, vscode.ConfigurationTarget.Global);
    // The settings write also fires the listener (which writes the marker), so
    // every change path converges; writing here too makes the command's answer
    // truthful even before events land.
    const sync = syncCaptureMarker(paths, next, log);
    if (sync.error) {
      void vscode.window.showWarningMessage(
        `Recording is ${next ? 'ON' : 'OFF'} in settings, but the live consent marker could not be updated (${sync.error}). ` +
          'A running harness keeps its previous recording state until a marker write succeeds.',
      );
      return;
    }
    const where = dest
      ? `stored in this window's workspace at ${dest} - nothing leaves this machine, and it is YOUR workspace file: uninstalling the harness does not touch it`
      : `stored in the workspace file .vllm\\${HARNESS_RECORDING_FILENAME} - uninstalling the harness does not touch workspace recordings`;
    if (next) {
      // Binding honesty: the running harness writes whatever the SNAPSHOT
      // names, and only a prepare rewrites the snapshot - which Start skips
      // when it adopts a survivor. So the message must reflect what the
      // running harness will ACTUALLY do, not what this window wishes.
      const running = readPidRecord(paths.pid) !== undefined && deps.isInstalled();
      const owner = snapshotRecordingFile(paths.snapshot);
      if (running && !owner) {
        // Prepared by a folder-less window: the snapshot names no
        // destination, the plugin records nothing, and promising "ON" would
        // be theater. Say what fixes it.
        log.warn('harness prompt recording ON but the running harness snapshot names no recording file; recording cannot happen until Restart in a workspace window');
        void vscode.window.showWarningMessage(
          `DeepSeek Harness prompt recording: ON in settings and consent, but the RUNNING harness was prepared with no workspace and its snapshot names no recording file - it records NOTHING until you run **DeepSeek Harness: Restart** here (a plain Start just adopts the survivor and rebinds nothing). ${where}.`,
        );
      } else if (running && owner && !equivalentHarnessPath(owner, dest ?? '')) {
        log.warn(`harness prompt recording ON here, but the running harness records to ${owner} until a Restart here rebinds it`);
        void vscode.window.showWarningMessage(
          `DeepSeek Harness prompt recording: ON in settings and consent. Heads-up: the running harness records to ANOTHER window's workspace (${owner}) - toggling here does not move the pen. Run **DeepSeek Harness: Restart** in this window to rebind recording to ${dest} (Start adopts the survivor and rebinds nothing).`,
        );
      } else {
        void vscode.window.showInformationMessage(
          `DeepSeek Harness prompt recording: ON. ${running ? 'The running harness records from its next request' : `Recording starts when the harness next starts${sync.folderExists ? '' : ' (its consent marker seeds at prepare)'}`}. ${where}.`,
        );
      }
    } else {
      const flag = readCaptureConsent(paths.captureFlag);
      void vscode.window.showInformationMessage(
        `DeepSeek Harness prompt recording: OFF. ${sync.folderExists && flag.reason === 'off' ? 'Queued, not-yet-committed captures are dropped on the spot - no waiting for a restart.' : 'Nothing was recording anyway.'} Entries already in the recording file stay. ${where}.`,
      );
    }
  }

  async function runOpenRecording(): Promise<void> {
    const own = workspaceRecordingFile();
    if (!own) {
      void vscode.window.showWarningMessage(
        `DeepSeek Harness: prompt recordings live in the workspace at .vllm\\${HARNESS_RECORDING_FILENAME}, and this window has no folder open - open a folder to reach recordings. No recording was invented elsewhere.`,
      );
      return;
    }
    // The snapshot names where the RUNNING harness actually records. It
    // never gets auto-opened from here - this command opens THIS window's
    // file and says out loud when the pen is elsewhere.
    const running = readPidRecord(paths.pid) !== undefined && deps.isInstalled();
    const owner = snapshotRecordingFile(paths.snapshot);
    const foreign = running && owner && !equivalentHarnessPath(owner, own);
    if (existsSync(own)) {
      await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(own));
      if (foreign) {
        void vscode.window.showWarningMessage(
          `Opened this workspace's recording, but the running harness records to ANOTHER window's workspace (${owner}) - run **DeepSeek Harness: Restart** here before this file grows.`,
        );
      }
      return;
    }
    if (foreign) {
      // This window's file does not exist yet and the running harness is
      // honestly recording THERE (or will, consent permitting) - naming the
      // owner beats an invented empty success.
      void vscode.window.showInformationMessage(
        `No harness recording in this workspace yet. The running harness is bound to another window's workspace and records to ${owner}. This window's file (${own}) fills only once a harness run is bound HERE - run **DeepSeek Harness: Restart** in this window (Start adopts the survivor and rebinds nothing).`,
      );
      return;
    }
    if (running && !owner) {
      void vscode.window.showWarningMessage(
        `No harness recording in this workspace, and the running harness was prepared with no workspace - its snapshot names no recording file, so it records nothing anywhere. Run **DeepSeek Harness: Restart** here to bind recording to ${own}.`,
      );
      return;
    }
    void vscode.window.showInformationMessage(
      `No harness prompt recording exists yet - turn recording ON, send the harness a message, then open ${own}.`,
    );
  }

  return [
    vscode.commands.registerCommand('vllm-copilot.harness.setPersonality', () => guarded('Set Harness Personality', runSetPersonality)),
    vscode.commands.registerCommand('vllm-copilot.harness.toggleRecording', () => guarded('Toggle Harness Prompt Recording', runToggleRecording)),
    vscode.commands.registerCommand('vllm-copilot.harness.openRecording', () => guarded('Open Harness Recording', runOpenRecording)),
  ];
}