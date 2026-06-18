import { readFileSync } from "node:fs";
import {
  MOJIBAKE_PATTERNS,
  NO_BOM_EXTENSIONS,
  REPLACEMENT_CHAR,
  UTF8_BOM,
  VBRIEF_CONTROL_CHAR_LABELS,
} from "./patterns.js";
import { pythonSplitlines, stripMarkdownQuotes } from "./text.js";

/** One mojibake / U+FFFD / BOM detection record. */
export interface Finding {
  readonly path: string;
  readonly line: number;
  readonly label: string;
  readonly context: string;
}

/** Render a finding as the Python oracle does: `  path:line [label] context`. */
export function renderFinding(f: Finding): string {
  const ctx = f.context.length <= 120 ? f.context : `${f.context.slice(0, 117)}...`;
  return `  ${f.path}:${f.line} [${f.label}] ${ctx}`;
}

/** Lowercased final extension of a path, including the dot (e.g. ".md"). */
export function suffixOf(path: string): string {
  const base = path.replace(/\\/g, "/").split("/").pop() ?? "";
  const dot = base.lastIndexOf(".");
  if (dot <= 0) {
    return "";
  }
  return base.slice(dot).toLowerCase();
}

/** Scan one line; return findings for U+FFFD + each mojibake pattern hit. */
export function scanLine(
  relPath: string,
  lineno: number,
  line: string,
  context?: string,
): Finding[] {
  const findings: Finding[] = [];
  const ctx = context !== undefined ? context : line;
  if (line.includes(REPLACEMENT_CHAR)) {
    findings.push({ path: relPath, line: lineno, label: "U+FFFD replacement char", context: ctx });
  }
  for (const [pattern, label] of MOJIBAKE_PATTERNS) {
    if (line.includes(pattern)) {
      findings.push({ path: relPath, line: lineno, label, context: ctx });
    }
  }
  return findings;
}

function startsWithBom(raw: Buffer): boolean {
  if (raw.length < UTF8_BOM.length) {
    return false;
  }
  return UTF8_BOM.every((byte, i) => raw[i] === byte);
}

/**
 * Scan one file for U+FFFD / mojibake / unexpected BOM. An unreadable or
 * binary file returns an empty list rather than throwing (the gate is
 * intentionally permissive on read failures). Mirrors Python `scan_file`.
 */
export function scanFile(relPath: string, fullPath: string): Finding[] {
  const findings: Finding[] = [];
  const suffix = suffixOf(fullPath);

  let raw: Buffer;
  try {
    raw = readFileSync(fullPath);
  } catch {
    return findings;
  }

  if (NO_BOM_EXTENSIONS.has(suffix) && startsWithBom(raw)) {
    findings.push({
      path: relPath,
      line: 1,
      label: "unexpected UTF-8 BOM",
      context: "leading bytes EF BB BF on a format where BOM is non-canonical",
    });
  }

  // Node Buffer.toString('utf8') performs lossy U+FFFD replacement, matching
  // Python bytes.decode('utf-8', errors='replace').
  const text = raw.toString("utf8");

  if (text.slice(0, 1024).includes("\u0000")) {
    // Likely binary file — skip mojibake scan.
    return findings;
  }

  let scanText = text;
  if (suffix === ".md") {
    scanText = stripMarkdownQuotes(text);
  }

  if (scanText === text) {
    const lines = pythonSplitlines(text);
    lines.forEach((line, idx) => {
      findings.push(...scanLine(relPath, idx + 1, line));
    });
  } else {
    const originalLines = pythonSplitlines(text);
    const strippedLines = pythonSplitlines(scanText);
    if (strippedLines.length < originalLines.length) {
      while (strippedLines.length < originalLines.length) {
        strippedLines.push("");
      }
    }
    originalLines.forEach((orig, idx) => {
      const stripped = strippedLines[idx] ?? "";
      findings.push(...scanLine(relPath, idx + 1, stripped, orig));
    });
  }

  if (isVbriefNarrativeControlScope(relPath)) {
    findings.push(...scanVbriefNarrativeControls(relPath, text));
  }

  return findings;
}

/** Return true for in-flight vBRIEF files that may receive issue ingest. */
export function isVbriefNarrativeControlScope(relPath: string): boolean {
  if (!relPath.endsWith(".vbrief.json")) {
    return false;
  }
  const normalized = `/${relPath.replace(/\\/g, "/")}`;
  return normalized.includes("/vbrief/proposed/") || normalized.includes("/vbrief/active/");
}

function tabIsNonIndentation(value: string, index: number): boolean {
  const lineStart = value.lastIndexOf("\n", index - 1) + 1;
  for (const ch of value.slice(lineStart, index)) {
    if (ch !== " " && ch !== "\t") {
      return true;
    }
  }
  return false;
}

function decodedControlLabels(value: string): string[] {
  const labels: string[] = [];
  const seen = new Set<string>();
  // Iterate by UTF-16 code unit index so lastIndexOf offsets line up; control
  // chars of interest are all BMP single-unit characters.
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index] as string;
    if (char === "\t" && !tabIsNonIndentation(value, index)) {
      continue;
    }
    let label = VBRIEF_CONTROL_CHAR_LABELS.get(char);
    const code = char.charCodeAt(0);
    if (label === undefined && code < 32 && char !== "\n" && char !== "\r") {
      label = `U+${code.toString(16).toUpperCase().padStart(4, "0")} control character in vBRIEF narrative`;
    }
    if (label !== undefined && !seen.has(label)) {
      seen.add(label);
      labels.push(label);
    }
  }
  return labels;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function jsonKeyLine(text: string, key: string): number {
  const match = new RegExp(`"${escapeRegExp(key)}"\\s*:`).exec(text);
  if (match === null) {
    return 1;
  }
  return (text.slice(0, match.index).match(/\n/g) ?? []).length + 1;
}

/** Scan decoded `plan.narratives` strings for hidden control chars. */
export function scanVbriefNarrativeControls(relPath: string, text: string): Finding[] {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return [];
  }
  if (typeof data !== "object" || data === null) {
    return [];
  }
  const plan = (data as Record<string, unknown>).plan;
  if (typeof plan !== "object" || plan === null) {
    return [];
  }
  const narratives = (plan as Record<string, unknown>).narratives;
  if (typeof narratives !== "object" || narratives === null) {
    return [];
  }

  const findings: Finding[] = [];
  for (const [key, value] of Object.entries(narratives as Record<string, unknown>)) {
    if (typeof value !== "string") {
      continue;
    }
    const keyLine = jsonKeyLine(text, key);
    for (const label of decodedControlLabels(value)) {
      findings.push({
        path: relPath,
        line: keyLine,
        label,
        context: `plan.narratives.${key} contains ${label}`,
      });
    }
  }
  return findings;
}
