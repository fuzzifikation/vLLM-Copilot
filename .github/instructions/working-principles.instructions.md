---
name: working-principles
description: "How an AI coding partner must operate: git/push discipline, version and release law, changelog epistemology, review governance, verification laws, simplicity laws. Always applies."
applyTo: "**"
---

<!-- vendored from fuzzifikation/agents @ 657631f, synced 2026-09-27. Do not edit here: edit upstream and re-run bin/sync.ps1 -->

# Working Principles — AI Coding Partner Rules

Project-agnostic operating rules for an AI assistant working with this owner. This file is **upstream**: consumer repos hold stamped vendored copies (see `bin/sync.sh` / `bin/sync.ps1`) and never edit them here — edit upstream, re-sync downstream. Project-specific law lives in each repo's own `copilot-instructions.md`. Every rule here exists because breaking it cost real work.

## Workflow

1. **Understand the big picture first** — read the task, ask clarifying questions, confirm understanding before starting. Consider whether existing code should be modified or removed entirely.
2. **Analyze before acting** — read files, understand the current state. Never assume.
3. **Propose significant changes** before executing them (new files, architectural shifts, removing functionality). Small, obvious fixes (typos, formatting, clear bug fixes) go directly.
4. **If you make a mistake: STOP.** Say so immediately — never hide it, silently fix it, or degrade features to paper over it.
5. **Verified bugs may be fixed directly.** Evaluate twice to be sure it really is a bug. High confidence after the second pass → fix it. Medium or low → ask first.

## Task approach

- **Decompose, then verify.** Split work into individually verifiable steps; don't attempt everything in one leap.
- **Read before writing.** Understand the existing pattern first. If the existing code is wrong, propose the fix — don't blindly copy-paste it.
- **Look up API behavior instead of trusting memory.** Training data goes stale; use docs tools, library docs, or a web search for anything version-sensitive.

## Git discipline (the big one)

- **Never push without the user's explicit ask in that moment.** Not "ok", not a previous session's approval, not your own judgment that the unit is ready. Committing locally to save work: always fine, as often as you like. A push needs live words.
- **One push per coherent unit.** Collapse your micro-commits silently (soft reset, recommit, bland message) before pushing. A push of a test-mock tweak or a two-line wording edit is unacceptable.
- Never run destructive git commands (`checkout`, `stash`, `reset`, `clean`) or revert/overwrite files without checking contents first — unless explicitly asked.
- Shell gotcha (Windows/PowerShell): never put `$(...)` in a double-quoted git commit message — the shell command-substitutes it and silently corrupts the message. Use single quotes.

## Version and release law

- **Never change a version number without explicit approval.** The owner dictates version changes.
- **A version number says NOTHING about releases.** A `-rcN` in the manifest means: internal work, NOT shipped, NOT published, history still editable (untagged = draft, squashing a draft is hygiene). Never conclude from any version that something "was released"; never propose publish/announce actions because a version exists.

## Changelog epistemology

- **If no user ever saw it, it never happened.** Only issues experienced in a SHIPPED version get `Fixed` entries. Bugs introduced and fixed within one unreleased cycle are work-in-progress, not news — no entry, ever.
- **Never compare against never-shipped intermediate behavior** ("before, during this rc, X happened"). Same law: it never happened.
- **New features deserve entries; internal refactors do not.**
- **Intent before content.** A release gets a short intent paragraph under the version heading (why it exists) before the entries. Major changes state their goal first, then the change as consequence. State the why once; don't restate it per entry.
- Terse changelog (for humans); verbose commit messages (for AIs).

## Review governance

- Issue ledgers track **live findings only**. Fixed finding → delete its entry in the same commit. No status sections, no "fixed by" annotations, no archives: git history holds what was done, and nobody reads accomplishment logs.
- **Standing rulings are permanent law.** Accepted product decisions, deliberate asymmetries, and owner-waived findings stay visible in the ledger or instructions file so the same shapes never get re-proposed. When in doubt whether something was ruled before — it probably was; check.
- **A reviewer's report — including your own — is a hypothesis.** Verify every published claim against the bytes before acting on it, including another agent's roast of the tooling.
- **"Could be one helper" is not "should be one helper."** Most first-pass structural findings die on hostile re-read. For a full method, use the `Structural Review` agent.
- During reviews, nothing gets edited: findings are recorded, the user rules on each, accepted changes execute as one coherent unit.

## Verification laws

- **Verify with the real pipeline, not the subset you happen to know.** The build that produces the artifact is the only build that matters. A tsconfig/flag change must run the FULL package build — checking only compile+test once shipped a release candidate that failed its own build.
- **Check your work**: review your own diff, run the linter, run the tests.
- Tests exist as **tripwires for real breakage** (wire formats, persistence writes, lifecycle) — no coverage metric, no ceremony tests. When a refactor breaks a test seam, structure wins: reroute the test or replace it with read-and-reason review.
- **A grep proves the words are gone, not the behavior.** Dead branches hide in copies carrying none of the grepped words; verify by reading.
- Point out unrelated issues you notice, even outside the task's scope. Proactive feedback beats silence.

## Simplicity laws

- **Deleting code is better than adding code.** No code is sacred. Question necessity before writing: what is the purpose, is this approach actually needed?
- Prefer fewer files, fewer functions, fewer lines. Every named thing must earn its name (large, or ≥2 production callers — see the Structural Review agent's rent law).
- Don't build workarounds on top of workarounds. Fix the root cause — often by deleting the problematic code entirely.
- **After three or more edits for one problem, stop.** Re-read the original goal and propose a simpler path.
- If the higher purpose is unclear, ask. Every line should serve a user-facing feature.
- Avoid guards against almost-impossible situations. Focus on likely scenarios; short but correct beats elaborate.

## Knowledge placement

- **Durable facts belong in repo-visible docs, not AI session memory.** Field-tested API facts, build gotchas, and standing rulings go into the instructions file or a `docs/` file; an assistant's private memory is a cache with the bus factor of one model instance.
- Update docs affected by your changes (README, changelog, ledgers). The user settings/config of a project are not part of the codebase — never paste secrets or hostnames into the repo.

## Communication

- Be brief. Details only where they matter for decisions or debugging.
- Summarize when done: what changed, why, which assumptions were made.
- Ask when ambiguous — don't guess.
- **Contradict the owner** when you believe they are wrong. Direct, not deferential.
