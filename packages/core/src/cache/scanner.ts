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

const BODY_VECTOR_RE =
  /(?:curl|wget|fetch)\s+[^|\n]*\|\s*(?:sh|bash|zsh|ksh)\b|\bbase64\s+(?:-d|--decode|-D)\b|\beval\s*[($"'`]/i;

const HEADING_RE = /^(#{1,6})\s+(.*\S.*)$/;
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
  const match = HEADING_RE.exec(line);
  if (!match) return null;
  return match[2]?.trim() ?? null;
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
    if (BODY_VECTOR_RE.test(ln)) return true;
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
        if (HEADING_RE.test(nxt)) break;
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

    if (headingSignal(line) || BODY_VECTOR_RE.test(line)) {
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
