/**
 * Text helpers ported to match Python semantics exactly so the encoding gate
 * golden-diffs clean against the Python oracle (#798 / #1718): line splitting
 * (`str.splitlines`), markdown code-span stripping, and `fnmatch.fnmatchcase`
 * glob matching for the allow-list.
 */

// Python str.splitlines() boundaries: \n \r \r\n \v \f \x1c \x1d \x1e \x85 \u2028 \u2029.
// The control chars are the intentional boundary set ported from CPython for
// golden-diff parity (#1718), not accidental input.
// biome-ignore lint/suspicious/noControlCharactersInRegex: intentional Python splitlines() boundary set (#1718)
const SPLITLINES_BOUNDARY = /\r\n|[\n\r\v\f\u001c\u001d\u001e\u0085\u2028\u2029]/g;

/**
 * Split `text` into lines using Python `str.splitlines()` semantics: splits on
 * the full Unicode line-boundary set and does NOT emit a trailing empty string
 * for a final line break. Empty input yields an empty array.
 */
export function pythonSplitlines(text: string): string[] {
  if (text === "") {
    return [];
  }
  const lines: string[] = [];
  let last = 0;
  SPLITLINES_BOUNDARY.lastIndex = 0;
  let match: RegExpExecArray | null = SPLITLINES_BOUNDARY.exec(text);
  while (match !== null) {
    lines.push(text.slice(last, match.index));
    last = match.index + match[0].length;
    match = SPLITLINES_BOUNDARY.exec(text);
  }
  if (last < text.length) {
    lines.push(text.slice(last));
  }
  return lines;
}

// Markdown inline-code span: single backtick to single backtick on one line.
const MD_INLINE_CODE = /`[^`\r\n]*`/g;

// Markdown fenced code block: ``` (or ~~~) ... matching close fence.
// Flags: g (replace all), m (^/$ per line), s (dotall so .*? spans lines).
const MD_FENCED_BLOCK = /^[ \t]*(```|~~~)[^\n]*\n.*?^[ \t]*\1[ \t\r]*$/gms;

/** Replace a fenced block with the same number of newlines (line alignment). */
function blankBlock(match: string): string {
  const count = (match.match(/\n/g) ?? []).length;
  return "\n".repeat(count);
}

/**
 * Strip fenced code blocks and inline-code spans from markdown content.
 * Fenced blocks are blanked newline-for-newline first (preserving line numbers),
 * then inline spans are removed. Mirrors the Python `_strip_markdown_quotes`.
 */
export function stripMarkdownQuotes(text: string): string {
  const withoutFences = text.replace(MD_FENCED_BLOCK, (m) => blankBlock(m));
  return withoutFences.replace(MD_INLINE_CODE, "");
}

/**
 * Translate a single `fnmatch`-style glob to an anchored regex source.
 * Mirrors CPython `fnmatch.translate` for the subset used by the allow-list:
 * `*` matches any run of characters (including `/`), `?` matches one character,
 * `[...]` is a character class (`!` negates), everything else is literal.
 */
function fnmatchTranslate(pattern: string): string {
  let out = "";
  let i = 0;
  const n = pattern.length;
  while (i < n) {
    const c = pattern.charAt(i);
    i += 1;
    if (c === "*") {
      out += ".*";
    } else if (c === "?") {
      out += ".";
    } else if (c === "[") {
      let j = i;
      if (j < n && pattern.charAt(j) === "!") {
        j += 1;
      }
      if (j < n && pattern.charAt(j) === "]") {
        j += 1;
      }
      while (j < n && pattern.charAt(j) !== "]") {
        j += 1;
      }
      if (j >= n) {
        out += "\\[";
      } else {
        let stuff = pattern.slice(i, j).replace(/\\/g, "\\\\");
        i = j + 1;
        if (stuff.startsWith("!")) {
          stuff = `^${stuff.slice(1)}`;
        } else if (stuff.startsWith("^")) {
          stuff = `\\${stuff}`;
        }
        out += `[${stuff}]`;
      }
    } else {
      out += c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    }
  }
  return out;
}

/** Return true when `relPath` (POSIX form) matches the fnmatch `pattern`. */
export function fnmatchCase(relPath: string, pattern: string): boolean {
  // `s` flag so `.` (from `*`) spans any character, matching fnmatch's dotall.
  const re = new RegExp(`^(?:${fnmatchTranslate(pattern)})$`, "s");
  return re.test(relPath);
}
