/**
 * ONE definition of "what is an Agents-window (harness) system prompt, and which
 * wording does it carry". Used by `extract-copilot-reference.mjs` (which entries to
 * anchor regions from) and `check-copilot-rules.mjs` (which rules to expect from them).
 *
 * This used to be a literal — `'using Copilot CLI runtime'` — copy-pasted into
 * both scripts. Microsoft renamed that text to "Copilot SDK" in the 2026-11
 * harness, and both scripts kept reporting success: the auditor announced "no harness
 * messages" in a capture full of them and exited 0 without checking a single
 * rule. Anchor on wording that survived that rename instead.
 *
 * Chosen anchors, present in the old ("Copilot CLI runtime") and the new
 * ("Copilot SDK") opener and absent from every other system message that reaches
 * a capture: classic chat opens "You are an expert AI programming assistant, …",
 * the action-approval judge opens "You judge one proposed developer-tool action.",
 * the progress-message generator opens "You are an expert in writing short, …".
 */

const OPENER = /^You are an AI assistant using [^\n]* in VS Code\./;
const INTENT = 'You help users with software engineering tasks.';

/**
 * The harness-prompt wording generation of `text`, or `null` when `text` is not a
 * harness prompt. Microsoft renames this prompt's boilerplate without notice and the
 * presets target the CURRENT wording only (`"wording": "sdk"` in the replacement
 * files; untagged Copilot rules anchor boilerplate every wording shares — support for
 * a superseded wording is deleted, not accumulated). A live audit still needs the
 * capture's generation: rules written for a different generation are dormant there,
 * not drifted — the prompt moved, the rules did not.
 */
export function copilotPromptWording(text) {
  if (typeof text !== 'string' || !OPENER.test(text) || !text.includes(INTENT)) return null;
  return /\busing Copilot SDK\b/.test(text) ? 'sdk' : 'cli';
}

/** What was looked for — printed on a miss so "nothing matched" cannot read as "nothing to do". */
export const MARKER_HINT =
  'harness prompt opener "You are an AI assistant using … in VS Code." + ' +
  `"${INTENT}"`;
