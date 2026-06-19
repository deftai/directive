import { parseMarkdownHeading } from "../text/redos-safe.js";

/**
 * Quarantine scanner v2 port (mirrors `scripts/cache_scanner.py`).
 * SCANNER_VERSION must stay in lockstep with the Python module.
 */
export const SCANNER_VERSION = "2.1.0";

export interface ScanFlag {
  category: string;
  severity: string;
  detail: string;
  match_count: number;
}

export interface ScanResult {
  passed: boolean;
  scanner_version: string;
  flags: ScanFlag[];
  transformed_content: string;
  scanned_at: string;
}

const CREDENTIAL_PATTERNS: ReadonlyArray<[string, RegExp]> = [
  ["github-pat", /\bgh[pousr]_[A-Za-z0-9]{30,}\b/],
  ["anthropic-api-key", /\bsk-ant-[A-Za-z0-9_-]{20,}\b/],
  ["openai-api-key", /\bsk-[A-Za-z0-9]{20,}\b/],
  ["slack-token", /\bxox[bp]-[A-Za-z0-9-]{20,}\b/],
  ["aws-access-key", /\bAKIA[0-9A-Z]{16}\b/],
  ["pem-private-key", /-----BEGIN (?:RSA |DSA |EC |OPENSSH |ENCRYPTED )?PRIVATE KEY-----/],
  ["bearer-token", /\bBearer\s+[A-Za-z0-9_.~+/=-]{20,}\b/],
  ["jwt", /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/],
];

const INVISIBLE_RANGES: ReadonlyArray<[number, number]> = [
  [0x200b, 0x200f],
  [0x202a, 0x202e],
  [0x2060, 0x2060],
  [0x2066, 0x2069],
  [0xfeff, 0xfeff],
  [0xe0000, 0xe007f],
];

const INJECTION_OVERRIDE_RE =
  /\b(?:ignore|disregard|forget|override|bypass)\s+(?:the\s+|all\s+|any\s+)?(?:previous|prior|above|earlier|all|your|preceding|original|system)\b/i;

const HEADING_ROLE_PREFIXES = [
  "SYSTEM",
  "ASSISTANT",
  "USER",
  "AGENT",
  "TOOL",
  "FUNCTION",
  "OVERRIDE",
  "DIRECTIVE",
  "ROLE",
  "PROMPT",
  "INSTRUCTION",
  "INSTRUCTIONS",
] as const;

const HEADING_ROLE_PREFIX_RE = new RegExp(
  `^(?:${HEADING_ROLE_PREFIXES.map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})\\s*:`,
  "i",
);

// #1811 follow-up: the previous `BODY_VECTOR_RE` regex (`(?:curl|wget|fetch)\s+
// [^|\n]*\|...`) is a CodeQL `js/polynomial-redos` hazard -- `\s+` overlaps
// `[^|\n]*`, so a line like `curl ` + a long run of spaces with no pipe forces
// polynomial backtracking. The recognizer below scans each line ONCE for the
// same three vectors, preserving byte-identical match semantics:
//   1. curl/wget/fetch <args> | sh|bash|zsh|ksh  (pipe-to-shell)
//   2. base64 -d | --decode | -D                 (decode flag, word-bounded)
//   3. eval followed by ( $ " ' ` delimiter
const PIPE_SHELL_KEYWORDS = ["curl", "wget", "fetch"] as const;
const SHELL_TARGETS = ["sh", "bash", "zsh", "ksh"] as const;
const EVAL_DELIMITERS = new Set(["(", "$", '"', "'", "`"]);
const WS_RE = /\s/;

function isAsciiWordChar(ch: string | undefined): boolean {
  if (ch === undefined) return false;
  return (
    (ch >= "a" && ch <= "z") || (ch >= "A" && ch <= "Z") || (ch >= "0" && ch <= "9") || ch === "_"
  );
}

function isWs(ch: string | undefined): boolean {
  return ch !== undefined && WS_RE.test(ch);
}

/** `\b` immediately before index `i` (keyword first char is always a word char). */
function wordBoundaryBefore(line: string, i: number): boolean {
  return i === 0 || !isAsciiWordChar(line[i - 1]);
}

/** `\b` immediately after index `j` (token last char is always a word char). */
function wordBoundaryAfter(line: string, j: number): boolean {
  return j >= line.length || !isAsciiWordChar(line[j]);
}

function matchesAt(line: string, i: number, token: string): boolean {
  return line.slice(i, i + token.length).toLowerCase() === token;
}

/** Mirror `(?:curl|wget|fetch)\s+[^|\n]*\|\s*(?:sh|bash|zsh|ksh)\b` at start `i`. */
function pipeToShellAt(line: string, i: number, kw: string): boolean {
  const afterKw = i + kw.length;
  // `\s+` requires at least one whitespace char right after the keyword.
  if (!isWs(line[afterKw])) return false;
  // `[^|\n]*\|`: the first pipe after the keyword, with no intervening newline.
  let p = afterKw + 1;
  while (p < line.length) {
    const ch = line[p] as string;
    if (ch === "|") break;
    if (ch === "\n") return false;
    p += 1;
  }
  if (p >= line.length || line[p] !== "|") return false;
  // `\s*` after the pipe.
  let q = p + 1;
  while (isWs(line[q])) q += 1;
  // `(?:sh|bash|zsh|ksh)\b`.
  for (const target of SHELL_TARGETS) {
    if (matchesAt(line, q, target) && wordBoundaryAfter(line, q + target.length)) {
      return true;
    }
  }
  return false;
}

/** Mirror `\bbase64\s+(?:-d|--decode|-D)\b` at start `i`. */
function base64DecodeAt(line: string, i: number): boolean {
  if (!wordBoundaryBefore(line, i)) return false;
  const afterKw = i + "base64".length;
  if (!isWs(line[afterKw])) return false;
  let j = afterKw + 1;
  while (isWs(line[j])) j += 1;
  // `--decode` (word-bounded), case-insensitive.
  if (matchesAt(line, j, "--decode") && wordBoundaryAfter(line, j + 8)) return true;
  // `-d` / `-D` (word-bounded): dash + d, with a boundary after.
  if (line[j] === "-") {
    const flag = line[j + 1];
    if (flag === "d" || flag === "D") {
      return wordBoundaryAfter(line, j + 2);
    }
  }
  return false;
}

/** Mirror `\beval\s*[($"'`+"`"+`]` at start `i`. */
function evalDelimiterAt(line: string, i: number): boolean {
  if (!wordBoundaryBefore(line, i)) return false;
  let j = i + "eval".length;
  while (isWs(line[j])) j += 1;
  const ch = line[j];
  return ch !== undefined && EVAL_DELIMITERS.has(ch);
}

/**
 * Linear, backtracking-free recognizer equivalent to the old `BODY_VECTOR_RE`.
 * Scans the line once; byte-identical match semantics to the prior regex.
 */
export function lineHasShellVector(line: string): boolean {
  for (let i = 0; i < line.length; i += 1) {
    for (const kw of PIPE_SHELL_KEYWORDS) {
      if (matchesAt(line, i, kw) && pipeToShellAt(line, i, kw)) return true;
    }
    if (matchesAt(line, i, "base64") && base64DecodeAt(line, i)) return true;
    if (matchesAt(line, i, "eval") && evalDelimiterAt(line, i)) return true;
  }
  return false;
}

const FENCE_RE = /^(```|~~~)/;
const QUARANTINE_FENCE_OPEN = "```quarantined";
const QUARANTINE_FENCE_CLOSE = "```";

function isInvisible(ch: string): boolean {
  const cp = ch.codePointAt(0);
  if (cp === undefined) return false;
  return INVISIBLE_RANGES.some(([lo, hi]) => cp >= lo && cp <= hi);
}

function stripInvisible(text: string): [string, string[]] {
  if (!text) return [text, []];
  const outChars: string[] = [];
  const seen = new Map<number, string>();
  for (const ch of text) {
    if (isInvisible(ch)) {
      const cp = ch.codePointAt(0) as number;
      if (!seen.has(cp)) {
        seen.set(cp, `U+${cp.toString(16).toUpperCase().padStart(4, "0")}`);
      }
      continue;
    }
    outChars.push(ch);
  }
  return [outChars.join(""), [...seen.values()]];
}

function detectCredentials(text: string): ScanFlag[] {
  const flags: ScanFlag[] = [];
  if (!text) return flags;
  for (const [label, pattern] of CREDENTIAL_PATTERNS) {
    const re = new RegExp(pattern.source, pattern.flags);
    const matches = text.match(new RegExp(re.source, `${re.flags}g`));
    if (!matches || matches.length === 0) continue;
    flags.push({
      category: "credentials",
      severity: "hard-fail",
      detail: `matched credentials pattern: ${label}`,
      match_count: matches.length,
    });
  }
  return flags;
}

function headingText(line: string): string | null {
  const match = parseMarkdownHeading(line);
  if (match === null) return null;
  return match.text.trim();
}

function headingSignal(text: string): boolean {
  if (INJECTION_OVERRIDE_RE.test(text)) return true;
  return HEADING_ROLE_PREFIX_RE.test(text);
}

function bodyHasShellVector(bodyLines: readonly string[]): boolean {
  let inFence: string | null = null;
  for (const ln of bodyLines) {
    const fenceMatch = FENCE_RE.exec(ln);
    if (fenceMatch) {
      const delim = fenceMatch[1] ?? "";
      if (inFence === null) {
        inFence = delim;
      } else if (ln.trimEnd() === inFence) {
        inFence = null;
      }
      continue;
    }
    if (inFence !== null) continue;
    if (lineHasShellVector(ln)) return true;
  }
  return false;
}

function detectInjectionHeading(text: string): [string, ScanFlag | null] {
  if (!text) return [text, null];

  const lines = text.split("\n");
  const out: string[] = [];
  let inFence: string | null = null;
  let sectionsWrapped = 0;
  let i = 0;

  while (i < lines.length) {
    const line = lines[i] ?? "";
    const fenceMatch = FENCE_RE.exec(line);
    if (fenceMatch) {
      const delim = fenceMatch[1] ?? "";
      if (inFence === null) {
        inFence = delim;
      } else if (line.trimEnd() === inFence) {
        inFence = null;
      }
      out.push(line);
      i += 1;
      continue;
    }
    if (inFence !== null) {
      out.push(line);
      i += 1;
      continue;
    }

    const hText = headingText(line);
    if (hText !== null) {
      let sectionEnd = i + 1;
      while (sectionEnd < lines.length) {
        const nxt = lines[sectionEnd] ?? "";
        const nestedFence = FENCE_RE.exec(nxt);
        if (nestedFence) {
          sectionEnd += 1;
          const nested = (nestedFence[1] ?? "").slice(0, 3);
          while (sectionEnd < lines.length && (lines[sectionEnd] ?? "").trimEnd() !== nested) {
            sectionEnd += 1;
          }
          sectionEnd += 1;
          continue;
        }
        if (parseMarkdownHeading(nxt) !== null) break;
        sectionEnd += 1;
      }

      const bodyLines = lines.slice(i + 1, sectionEnd);
      const hSignal = headingSignal(hText);
      const bSignal = bodyHasShellVector(bodyLines);

      if (hSignal || bSignal) {
        out.push(QUARANTINE_FENCE_OPEN);
        for (let j = i; j < sectionEnd; j += 1) {
          out.push(lines[j] ?? "");
        }
        out.push(QUARANTINE_FENCE_CLOSE);
        sectionsWrapped += 1;
        i = sectionEnd;
        continue;
      }

      for (let j = i; j < sectionEnd; j += 1) {
        out.push(lines[j] ?? "");
      }
      i = sectionEnd;
      continue;
    }

    if (headingSignal(line) || lineHasShellVector(line)) {
      out.push(QUARANTINE_FENCE_OPEN);
      out.push(line);
      out.push(QUARANTINE_FENCE_CLOSE);
      sectionsWrapped += 1;
      i += 1;
      continue;
    }

    out.push(line);
    i += 1;
  }

  const suffix = text.endsWith("\n") ? "\n" : "";
  const wrappedText = `${out.join("\n")}${suffix}`;

  if (sectionsWrapped === 0) return [wrappedText, null];
  return [
    wrappedText,
    {
      category: "injection-heading",
      severity: "fence-and-pass",
      detail: `wrapped ${sectionsWrapped} injection-shaped section(s) in \`quarantined\` fence (v2.1.0 strict-signal policy)`,
      match_count: sectionsWrapped,
    },
  ];
}

/** Run scanner v2 over content markdown. */
export function scan(contentMd: string, scannedAt?: string): ScanResult {
  const timestamp = scannedAt ?? new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  const flags: ScanFlag[] = [];

  const [stripped, removedLabels] = stripInvisible(contentMd);
  if (removedLabels.length > 0) {
    let totalStripped = 0;
    for (const ch of contentMd ?? "") {
      if (isInvisible(ch)) totalStripped += 1;
    }
    flags.push({
      category: "invisible-unicode",
      severity: "strip-and-pass",
      detail: `stripped ${totalStripped} invisible-unicode codepoint(s): ${removedLabels.join(", ")}`,
      match_count: totalStripped,
    });
  }

  flags.push(...detectCredentials(stripped));
  const [wrapped, injFlag] = detectInjectionHeading(stripped);
  if (injFlag !== null) flags.push(injFlag);

  const passed = !flags.some((f) => f.severity === "hard-fail");
  return {
    passed,
    scanner_version: SCANNER_VERSION,
    flags,
    transformed_content: wrapped,
    scanned_at: timestamp,
  };
}

/** Map scan flags for meta.json (omit match_count when zero). */
export function flagsForMeta(flags: readonly ScanFlag[]): Array<Record<string, unknown>> {
  return flags.map((f) => {
    const out: Record<string, unknown> = {
      category: f.category,
      severity: f.severity,
      detail: f.detail,
    };
    if (f.match_count) out.match_count = f.match_count;
    return out;
  });
}
