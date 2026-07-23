# Contributing to vLLM-Copilot

Thanks for looking at the code. Here's how to contribute without wasting everyone's time.

## Development Setup

```bash
npm install        # Install dependencies
npm run compile    # TypeScript compile
npm test           # Run test suite
npm run test:coverage  # Run with coverage
code .             # Launch VS Code, F5 to debug
```

## Project Structure

See the architecture section in [`.github/copilot-instructions.md`](.github/copilot-instructions.md) — it's there for a reason.

## Key Rules

- **ESM throughout.** All imports use `.js` extensions.
- **No global server settings.** Everything is per-model. If your change introduces a global config field, it's wrong.
- **Config ownership.** `VllmClient` owns the config cache. Don't add a second cache.
- **Types live in `types.ts`.** Wire-format types and SSE events only. No business logic there.
- **Tests match source files.** `test/*.test.ts` mirrors `src/*.ts`.
- **Webview JS is NOT checked by TypeScript.** Validate with `npm run validate-webview-js`.

## Pull Requests

- One feature or fix per PR. No drive-by refactors.
- Compile and tests must pass: `npm run compile && npm test`
- Describe **what changed** and **why** — not what you were thinking about while doing it.

## Reporting Issues

- Include the extension version and VS Code version.
- Include relevant logs (`Ctrl+Shift+P` → Open Log File).
- Use `Diagnose Connection` for network/TLS issues — include the output.
- Check `known-bugs.md` first — it might already be documented.