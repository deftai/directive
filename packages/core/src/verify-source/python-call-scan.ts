/**
 * Linear Python call-site scanner for subprocess / os.system shapes used by
 * verify_scm_boundary. Matches CPython ast.walk visit order for the
 * call patterns the gate cares about (sequential statement-level calls).
 */

export interface CallSite {
  readonly line: number;
  readonly col: number;
  readonly helper: string;
  readonly context: string;
}

const GH_BINARIES = new Set(["gh", "ghx"]);

function lineColAt(source: string, index: number): { line: number; col: number } {
  let line = 1;
  let col = 1;
  for (let i = 0; i < index; i += 1) {
    if (source.charAt(i) === "\n") {
      line += 1;
      col = 1;
    } else {
      col += 1;
    }
  }
  return { line, col };
}

function sliceSourceLine(sourceLines: string[], lineno: number): string {
  if (lineno >= 1 && lineno <= sourceLines.length) {
    return sourceLines[lineno - 1]?.replace(/\r$/, "") ?? "";
  }
  return "";
}

function skipWs(source: string, i: number): number {
  while (i < source.length && /\s/.test(source.charAt(i))) {
    i += 1;
  }
  return i;
}

function readStringLiteral(source: string, start: number): { value: string; end: number } | null {
  const quote = source.charAt(start);
  if (quote !== '"' && quote !== "'") {
    return null;
  }
  let i = start + 1;
  const triple = source.slice(start, start + 3) === `${quote}${quote}${quote}`;
  if (triple) {
    i = start + 3;
    const close = `${quote}${quote}${quote}`;
    const end = source.indexOf(close, i);
    if (end < 0) {
      return null;
    }
    return { value: source.slice(i, end), end: end + 3 };
  }
  let value = "";
  while (i < source.length) {
    const ch = source.charAt(i);
    if (ch === "\\") {
      if (i + 1 < source.length) {
        value += source.charAt(i + 1);
        i += 2;
        continue;
      }
      return null;
    }
    if (ch === quote) {
      return { value, end: i + 1 };
    }
    value += ch;
    i += 1;
  }
  return null;
}

function firstArgvFromList(source: string, start: number): string | null {
  const i = skipWs(source, start + 1);
  if (source.charAt(i) === "]") {
    return null;
  }
  const lit = readStringLiteral(source, i);
  if (lit !== null) {
    return lit.value;
  }
  return null;
}

function firstTokenFromShellString(value: string): string | null {
  const tokens = value.trim().split(/\s+/);
  return tokens.length > 0 ? (tokens[0] ?? null) : null;
}

function extractFirstArgv(source: string, openParen: number, helper: string): string | null {
  const i = skipWs(source, openParen + 1);
  if (i >= source.length || source.charAt(i) === ")") {
    return null;
  }

  if (helper === "os.system") {
    const lit = readStringLiteral(source, i);
    if (lit === null) {
      return null;
    }
    return firstTokenFromShellString(lit.value);
  }

  if (source.charAt(i) === "[" || source.charAt(i) === "(") {
    return firstArgvFromList(source, i);
  }

  const lit = readStringLiteral(source, i);
  if (lit !== null) {
    return firstTokenFromShellString(lit.value);
  }
  return null;
}

const CALL_PATTERNS: Array<{ helper: string; needle: string }> = [
  { helper: "subprocess.run", needle: "subprocess.run(" },
  { helper: "subprocess.check_output", needle: "subprocess.check_output(" },
  { helper: "subprocess.check_call", needle: "subprocess.check_call(" },
  { helper: "subprocess.call", needle: "subprocess.call(" },
  { helper: "subprocess.Popen", needle: "subprocess.Popen(" },
  { helper: "os.system", needle: "os.system(" },
  { helper: "Popen", needle: "Popen(" },
];

/** Scan Python source for raw gh/ghx subprocess call sites. */
export function scanPythonGhCalls(source: string): CallSite[] {
  const sourceLines = source.split("\n");
  const sites: CallSite[] = [];

  for (const { helper, needle } of CALL_PATTERNS) {
    let from = 0;
    while (from < source.length) {
      const idx = source.indexOf(needle, from);
      if (idx < 0) {
        break;
      }
      const openParen = idx + needle.length - 1;
      const firstArgv = extractFirstArgv(source, openParen, helper);
      if (firstArgv !== null && GH_BINARIES.has(firstArgv)) {
        const { line, col } = lineColAt(source, idx);
        const ctx = sliceSourceLine(sourceLines, line).trim() || `${helper}(...)`;
        sites.push({ line, col, helper, context: ctx });
      }
      from = idx + needle.length;
    }
  }

  sites.sort((a, b) => (a.line !== b.line ? a.line - b.line : a.col - b.col));
  return sites;
}
