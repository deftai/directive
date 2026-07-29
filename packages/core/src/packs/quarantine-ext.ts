/** Port of scripts/quarantine_ext.py — prompt-injection quarantine (#583). */

import { readFileSync } from "node:fs";
import { parseMarkdownHeading } from "../text/redos-safe.js";

export const SUSPICIOUS_TOKENS: readonly string[] = [
  "STEP",
  "TASK:",
  "TASK ",
  "IMPORTANT:",
  "IMPORTANT ",
  "MUST",
  "SYSTEM:",
  "SYSTEM ",
  "AGENT:",
  "AGENT ",
  "ASSISTANT:",
  "USER:",
  "INSTRUCTION:",
  "INSTRUCTIONS:",
  "TOOL:",
  "FUNCTION:",
  "PROMPT:",
  "OVERRIDE:",
  "IGNORE PREVIOUS",
  "DISREGARD PREVIOUS",
  "FORGET PREVIOUS",
  "ROLE:",
  "DIRECTIVE:",
];

export const QUARANTINE_FENCE_OPEN = "```quarantined";
export const QUARANTINE_FENCE_CLOSE = "```";

/**
 * Neutralize a body line so it cannot act as a CommonMark fence open/close.
 * Used on content placed inside a ```quarantined wrapper (#2915 / cache-quarantine-03).
 *
 * A nested bare ``` (or longer run, optional ≤3-space indent) would otherwise
 * early-close the outer fence and let following attacker text render outside
 * the quarantined info-string. Break the delimiter run by inserting a backslash
 * after the first fence character: ``` → `\`` , ~~~ → ~\~~ .
 */
export function neutralizeFenceLine(line: string): string {
  const match = /^( {0,3})(`{3,}|~{3,})(.*)$/.exec(line);
  if (match === null) return line;
  const indent = match[1] ?? "";
  const delim = match[2] ?? "";
  const rest = match[3] ?? "";
  // One backslash after the first fence char breaks the delimiter run.
  // Concat (not a template literal) so "\\" is unambiguously a single "\".
  return indent + delim[0] + "\\" + delim.slice(1) + rest;
}

function isWordChar(ch: string): boolean {
  return (
    (ch >= "A" && ch <= "Z") || (ch >= "a" && ch <= "z") || (ch >= "0" && ch <= "9") || ch === "_"
  );
}

function hasWordBoundaryBefore(text: string, index: number): boolean {
  return index === 0 || !isWordChar(text[index - 1] as string);
}

function hasWordBoundaryAfter(text: string, index: number): boolean {
  return index >= text.length || !isWordChar(text[index] as string);
}

function isSuspicious(line: string): boolean {
  const lower = line.toLowerCase();
  for (const token of SUSPICIOUS_TOKENS) {
    const search = token.toLowerCase();
    let start = 0;
    while (start <= line.length - search.length) {
      const idx = lower.indexOf(search, start);
      if (idx < 0) {
        break;
      }
      if (hasWordBoundaryBefore(line, idx)) {
        if (token.endsWith(":") || token.endsWith(" ")) {
          return true;
        }
        if (hasWordBoundaryAfter(line, idx + search.length)) {
          return true;
        }
      }
      start = idx + 1;
    }
  }
  return false;
}

function isHeading(line: string): boolean {
  return parseMarkdownHeading(line) !== null;
}

function matchFence(line: string): string | null {
  if (line.startsWith("```")) {
    return "```";
  }
  if (line.startsWith("~~~")) {
    return "~~~";
  }
  return null;
}

function splitLines(text: string): string[] {
  if (text.length === 0) {
    return [];
  }
  const lines = text.split(/\r\n|\r|\n/);
  if (
    text.endsWith("\n") ||
    text.endsWith("\r\n") ||
    (text.endsWith("\r") && !text.endsWith("\r\n"))
  ) {
    if (lines.length > 0 && lines[lines.length - 1] === "") {
      lines.pop();
    }
  }
  return lines;
}

export function quarantineBody(rawMd: string): string {
  if (!rawMd) {
    return rawMd;
  }

  const lines = splitLines(rawMd);
  const out: string[] = [];
  let i = 0;
  let inFence: string | null = null;

  while (i < lines.length) {
    const line = lines[i] as string;
    const fenceMatch = matchFence(line);
    if (fenceMatch !== null) {
      if (inFence === null) {
        inFence = fenceMatch;
      } else if (line.startsWith(inFence)) {
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

    if (isHeading(line) && isSuspicious(line)) {
      let sectionEnd = i + 1;
      while (sectionEnd < lines.length) {
        const nxt = lines[sectionEnd] as string;
        const nestedFence = matchFence(nxt);
        if (nestedFence !== null) {
          sectionEnd += 1;
          const nested = nxt.slice(0, 3);
          while (sectionEnd < lines.length && !lines[sectionEnd]?.startsWith(nested)) {
            sectionEnd += 1;
          }
          sectionEnd += 1;
          continue;
        }
        if (isHeading(nxt)) {
          break;
        }
        sectionEnd += 1;
      }
      out.push(QUARANTINE_FENCE_OPEN);
      // #2915: neutralize nested fence lines so they cannot early-close.
      for (const bodyLine of lines.slice(i, sectionEnd)) {
        out.push(neutralizeFenceLine(bodyLine));
      }
      out.push(QUARANTINE_FENCE_CLOSE);
      i = sectionEnd;
      continue;
    }

    if (isSuspicious(line)) {
      out.push(QUARANTINE_FENCE_OPEN);
      // #2915: neutralize in case the single line itself is fence-shaped.
      out.push(neutralizeFenceLine(line));
      out.push(QUARANTINE_FENCE_CLOSE);
      i += 1;
      continue;
    }

    out.push(line);
    i += 1;
  }

  const suffix = rawMd.endsWith("\n") ? "\n" : "";
  return out.join("\n") + suffix;
}

export function main(argv?: string[]): number {
  const args = argv ?? process.argv.slice(2);
  if (args.length > 0 && (args[0] === "-h" || args[0] === "--help")) {
    process.stdout.write(
      "quarantine_ext.py -- prompt-injection quarantine for cached issue bodies (#583).\n",
    );
    return 0;
  }
  const text = args.length > 0 ? readFileSync(args[0] as string, "utf8") : readFileSync(0, "utf8");
  process.stdout.write(quarantineBody(text));
  return 0;
}
