/**
 * JSONC tolerance: make a comment-bearing (or trailing-comma-bearing) JSON
 * document parseable by `JSON.parse`.
 *
 * Two production callers, which is why this is a shared module and not a helper
 * living inside one of them:
 *
 * - `src/commands/presets.ts`, for shipped `model-configs/*.json`, which carry
 *   `//` comments above and beside the envelope.
 * - `src/shared/sessionManager.ts`, for `.code-workspace` files, which VS Code
 *   writes as plain JSON but which a user may hand-edit into any shape its own
 *   JSONC editor accepts. A workspace file that fails to parse yields no
 *   folders, so its conversations become invisible to the janitor: a silent
 *   under-deletion of user data, which is why the tolerance here is not
 *   optional and why the parse failure is reported rather than swallowed.
 *
 * A string-aware state machine, not a regex: both file kinds legitimately
 * contain `//` inside a string value (a provenance URL, a match pattern), and
 * a regex-based stripper cuts such a value in half and produces a preset that
 * parses into the wrong data. Trailing commas are removed inside the same
 * scan, for the same reason: a comma inside a string must survive it.
 */

/**
 * Strip `//` and `/* *\/` comments and trailing commas, preserving everything
 * inside string literals verbatim. Throws nothing; returns text that
 * `JSON.parse` can handle, or throws on genuinely invalid JSON.
 */
export function stripJsonc(text: string): string {
  let out = '';
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      out += ch;
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
    } else if (ch === '"') {
      inString = true;
      out += ch;
    } else if (ch === '/' && text[i + 1] === '/') {
      // A line comment ends at the newline, which is kept so error messages
      // from JSON.parse still point at the right line.
      while (i < text.length && text[i] !== '\n') i++;
      out += '\n';
    } else if (ch === '/' && text[i + 1] === '*') {
      i += 2;
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++;
      i++;
    } else if (ch === '}' || ch === ']') {
      // Trailing comma: drop the comma, keep the whitespace, so a comma that
      // belongs to a string (already consumed above) is never touched.
      let end = out.length - 1;
      while (end >= 0 && /\s/.test(out[end])) end--;
      if (out[end] === ',') out = out.slice(0, end);
      out += ch;
    } else {
      out += ch;
    }
  }
  return out;
}
