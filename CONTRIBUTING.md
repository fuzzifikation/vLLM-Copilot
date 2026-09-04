# Contributing to vLLM-Copilot

Thanks for looking at the code. Here's how to contribute without wasting everyone's time.

## Development Setup

```bash
npm install        # Install dependencies
npm run compile    # TypeScript compile
npm test           # Run test suite
code .             # Launch VS Code, F5 to debug
```

## Project Structure

See the architecture section in [`.github/copilot-instructions.md`](.github/copilot-instructions.md) — it's there for a reason.

## Key Rules

- **ESM throughout.** All imports use `.js` extensions.
- **No global server settings.** Server connection data lives in the `vllm-copilot.servers` registry; models reference an entry by `server` id. Nothing may resolve a server unless a model references its entry, and no global connection field may be introduced.
- **Config ownership.** `VllmClient` owns the **config** cache (the parsed settings). Don't add a second config cache. Runtime probe caches (resolver memos, OpenRouter catalog/provider lists, engine metrics) each have one owner and a documented flush hook; the full inventory lives in `docs/complexity-audit.md` (Path 16 cache inventory).
- **Types live in `types.ts`.** Wire-format types and SSE events only. No business logic there.
- **Tests match source files.** `test/*.test.ts` mirrors `src/*.ts`.
- **Webview JS is NOT checked by TypeScript.** Validate with `npm run validate-webview-js`.

## License compliance

All production (shipped) dependencies must carry permissive open-source licenses
(MIT, ISC, BSD-2/3-Clause, Apache-2.0). Compliance is enforced in the build:

- `npm run license:check`: fails the build if any *runtime* dependency has a
  license outside the approved allowlist (copyleft like GPL/AGPL/LGPL and
  unknown licenses are rejected). Runs automatically as part of `npm run build`.
- `npm run license:notices`: regenerates `THIRD-PARTY-NOTICES.txt` (required by
  the VS Code Marketplace for redistributed OSS). Run it whenever dependencies
  change and commit the result.
- `THIRD-PARTY-NOTICES.txt` is included in the packaged VSIX.

## Pull Requests

- One feature or fix per PR. No drive-by refactors.
- Compile and tests must pass: `npm run compile && npm test`
- Describe **what changed** and **why** — not what you were thinking about while doing it.

## Reporting Issues

- Include the extension version and VS Code version.
- Include relevant logs (`Ctrl+Shift+P` → Open Log File).
- Use `Diagnose Connection` for network/TLS issues — include the output.
- Check `docs/code-review.md` first — it might already be documented.