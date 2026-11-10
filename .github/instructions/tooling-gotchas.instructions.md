---
name: tooling-gotchas
description: "Field-tested shell, Node, git and packaging traps where the tool fails silently and the output lies: PowerShell encoders, truncated inventories, escape-level fuzzy edits, stale AST properties, staging-dir rules. Always applies to command work."
applyTo: "**"
---

<!-- vendored from fuzzifikation/agents @ af27812, synced 2026-11-10. Do not edit here: edit upstream and re-run bin/sync.ps1 -->

# Tooling Gotchas: Silent Liars

Each rule is a scar: measured, not guessed. The shared shape is a tool that fails **silently** and produces output that reads like success. Where a rule overlaps a Working Principle, the WP number is cited and that file owns the law. Nothing here is project-specific; a project adds its own traps to its own `copilot-instructions.md`.

## 1 Shells (PowerShell first, POSIX alike)

1. **The console codepage is a liar.** `git show <ref>:<file> | Out-File` re-decodes bytes through the console codepage and silently mangles UTF-8 (`──` becomes `ΓöÇ`). Same for `Get-Content` on BOM-less files in Windows PowerShell 5.1: it decodes with the ANSI codepage, so every non-ASCII character arrives as mojibake. Read and write files with explicit UTF-8 APIs (`[System.IO.File]::ReadAllLines($p, [Text.UTF8Encoding]::new($false))`), or redirect with raw shell semantics from a script, never through a pipeline.
2. **`$(...)` in double quotes executes.** In commit messages and inline scripts, both PowerShell and POSIX shells command-substitute it and silently corrupt the text. Use single quotes. (WP12 owns the law; this is the mechanism.)
3. **`Select-String` is case-insensitive by default.** Pattern `CHANGED` also matches `unchanged`; an absent match then silently lies about what ran. Add `-CaseSensitive` when a status flag matters.
4. **`Measure-Object -Line` does not count empty lines** (an empty string counts as zero lines). It reported a 664-line file as 627, and the wrong number reached a ledger and a commit message. Count lines in a real language: `node -e` with `s.split('\n').length`.
5. **`(Get-Content f) | Set-Content f -NoNewline` crushes the file to one line.** The line array joins with no separator. Never rewrite a file by piping a line array back into itself.
6. **Inline `node -e "..."` dies on quotes, `$` and backticks under PowerShell.** Write a temp script file instead, every time. In an ESM package (`"type": "module"`), the temp script must use `import`, not `require`.
7. **Truncated inventories lie.** A sweep built from `... | Select-Object -First 60` (or `head -60`) silently under-scopes the work; a 104-item cleanup ran on 47 items. Write full inventories to a file and count them before acting.

## 2 Edits and docs

8. **Patch tools fuzzy-match escape levels.** A replace whose pattern contains `' '` has been observed matching a file line containing `'\u0000'` and applying the wrong edit while reporting success; the same failure exists for old/new text carrying regex-special characters (`(`, `)`, `$`, `|`), which can match the wrong location and shred a file. After any edit touching lines with escape literals or regex metacharacters, verify the bytes: diff the tool's effect against the file.
9. **Never hand-write JSON lines containing escaped quotes** through an editor or echo: escape-level confusion between payload and file bytes corrupts the file (`npm EJSONPARSE`). Rebuild such lines in a script with the language's JSON encoder and assert the result parses before writing.
10. **After changing a symbol's behavior, grep the symbol in its own file.** The doc comment above the changed constant described the deleted mechanism while five markdown files got updated around it. Docs rot at the speed of the code they describe; the same commit fixes both. (WP38 covers the rest.)
11. **A "drift" report on a moved or copied file is usually line endings.** Diff with endings normalized (`split(/\r?\n/)`) before believing any byte-count delta. A repo without `.gitattributes` (`* text=auto eol=lf`) gives fresh Windows checkouts CRLF, and any byte-exact anchor file then breaks matching silently; every consumer of such a file normalizes on read.

## 3 Node and TypeScript

12. **Bundlers cannot import a shebang.** Vite/Vitest die with a cryptic `SyntaxError: Invalid or unexpected token` on a `.mjs` starting with `#!`, while plain node runs it fine. Drop the shebang when all callers invoke `node <file>`.
13. **Importing a `.mjs` from TypeScript needs a sibling `.d.mts`.** Do not cast to `any` and do not enable `allowJs`.
14. **Compiler ASTs rename properties; stale reads return `undefined`.** TypeScript 6 moved `ExportDeclaration.moduleReference` to `moduleSpecifier`; a detector reading the old property found nothing and reported a clean run. Feature-detect: `s.moduleSpecifier ?? s.moduleReference`.
15. **Node on Windows refuses `spawnSync('npx.cmd')`** (`EINVAL`, .cmd shim protection). Exec tool binaries directly: `execFileSync(process.execPath, [path.join('node_modules', pkg, 'bin', 'x.mjs'), ...])`. Package `exports` maps can lock `require.resolve('pkg/bin/x')`; path-joining into `node_modules` is the reliable door.
16. **Any module-level TTL memo needs a cache clear in test teardown,** or the suite becomes order-dependent. This bit more than one project once.
17. **A config gate that rejects "unsafe regular expressions" can bail the whole tool config** (dependency-cruiser rejects quantified capture groups). Use alternation; test the config with the real tool, not by reading it. And when one config file must serve two truths (counting type-only imports helps orphan detection, poisons cycle detection), run two passes with two configs instead of picking a lying default.

## 4 Git and GitHub

18. **`git rm <file>` stages only that deletion.** Separately edited files still need `git add`, or the commit arrives half-empty and needs an amend.
19. **Unauthenticated `api.github.com` allows 60 requests/hour.** For public file contents, `raw.githubusercontent.com` is quota-free, and a blob sha is computable locally: `sha1("blob " + byteLength + "\0" + content)`.
20. **GitHub ignores `paths` filters on tag pushes:** every tag push runs the workflow file frozen at that tag's commit. Guard CI with branch filters plus a `github.ref_type` check.
21. **Deleting a workflow file does not delete its run history.** Runs of completed workflows are deletable per run via the API (`DELETE repos/{owner}/{repo}/actions/runs/{id}`).

## 5 Build and packaging

22. **A staging gate that checks only FORBIDDEN content lets new build dirs ship silently.** Packaging tests must assert expected presence (file counts, manifest entries), not just absence patterns.
23. **Never swap a tracked file in place for a build and restore it in `finally`.** `finally` covers a clean exit and a thrown error, not a hard kill, and a commit made between the swap and the restore captures the wrong bytes. Produce artifacts in a staging directory; the tracked original is never written.
24. **Linking a dependency tree into a build stage breaks tools that walk it** (npm reports `ELSPROBLEMS` and calls everything extraneous against a junctioned `node_modules`). Copy what the artifact needs; do not fake the tree.
