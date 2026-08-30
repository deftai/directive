/** Recognized in-repo Shell file-write dests (#3983 / #3987). */
import { isAbsolute, normalize, relative, resolve, sep } from "node:path";
export const SHELL_WRITE_KINDS = [
  "set-content",
  "out-file",
  "add-content",
  "python-pathlib",
  "io-writealltext",
] as const;
export type ShellWriteKind = (typeof SHELL_WRITE_KINDS)[number];
export interface ShellWriteTarget {
  readonly kind: ShellWriteKind;
  readonly path: string;
  readonly unprovable?: boolean;
}
const DQ = String.fromCharCode(34);
const AQ = String.fromCharCode(39);
function stripQuotes(token: string): string {
  const t = token.trim();
  if (t.length < 2) return t;
  const a = t[0];
  const b = t[t.length - 1];
  if ((a === DQ && b === DQ) || (a === AQ && b === AQ)) return t.slice(1, -1);
  return t;
}
function pushUnique(out: ShellWriteTarget[], kind: ShellWriteKind, raw: string): void {
  const path = stripQuotes(raw).trim();
  if (path.length === 0) return;
  if (out.some((d) => d.kind === kind && d.path === path)) return;
  out.push({ kind, path });
}

function extractQuoted(command: string, start: number): { value: string; next: number } {
  if (start >= command.length) return { value: "", next: start };
  const q = command[start];
  if (q !== DQ && q !== AQ) {
    let i = start;
    while (i < command.length) {
      const c = command[i];
      if (c === undefined) break;
      if (c === " " || c === "	" || c === "," || c === ")") break;
      i += 1;
    }
    return { value: command.slice(start, i), next: i };
  }
  let i = start + 1;
  while (i < command.length && command[i] !== q) i += 1;
  return { value: command.slice(start + 1, i), next: i + 1 };
}
function skipWs(command: string, start: number): number {
  let i = start;
  while (i < command.length) {
    const code = command.charCodeAt(i);
    if (code !== 32 && code !== 9 && code !== 10 && code !== 13) break;
    i += 1;
  }
  return i;
}

function startsWithVerb(segment: string, verb: string): boolean {
  const i = skipWs(segment, 0);
  if (segment.slice(i, i + verb.length).toLowerCase() !== verb.toLowerCase()) return false;
  const next = segment[i + verb.length];
  return next === undefined || next === " " || next === "	" || next === "-";
}
function splitWriteSegments(command: string): string[] {
  const segs: string[] = [];
  let cur = "";
  let quote: string | null = null;
  for (let i = 0; i < command.length; i++) {
    const c = command[i];
    if (c === undefined) break;
    if (quote !== null) {
      if (c === quote) quote = null;
      cur += c;
      continue;
    }
    if (c === DQ || c === AQ) {
      quote = c;
      cur += c;
      continue;
    }
    const code = command.charCodeAt(i);
    const next = command.charCodeAt(i + 1);
    if ((code === 38 && next === 38) || (code === 124 && next === 124)) {
      segs.push(cur);
      cur = "";
      i += 1;
      continue;
    }
    if (code === 124 || code === 38 || code === 59 || code === 10 || code === 13) {
      segs.push(cur);
      cur = "";
      continue;
    }
    cur += c;
  }
  segs.push(cur);
  return segs.map((seg) => seg.trim()).filter((seg) => seg.length > 0);
}

function extractAfterVerb(
  command: string,
  verb: string,
  kind: ShellWriteKind,
  out: ShellWriteTarget[],
): void {
  if (!startsWithVerb(command, verb)) return;
  const i = skipWs(command, 0);
  let j = skipWs(command, i + verb.length);
  const head = command.slice(j, j + 12).toLowerCase();
  if (head.startsWith("-path")) j = skipWs(command, j + 5);
  else if (head.startsWith("-literalpath")) j = skipWs(command, j + 12);
  else if (head.startsWith("-filepath")) j = skipWs(command, j + 9);
  const extracted = extractQuoted(command, j);
  pushUnique(out, kind, extracted.value);
}
function extractPythonPathlib(command: string, out: ShellWriteTarget[]): void {
  const i = skipWs(command, 0);
  const head = command.slice(i, i + 10).toLowerCase();
  if (!head.startsWith("python") && !head.startsWith("py ") && !head.startsWith("py.exe")) return;
  const needle = "Path(";
  const at = command.indexOf(needle, i);
  if (at < 0) return;
  let j = skipWs(command, at + needle.length);
  const ch = command[j];
  if (ch === "r" || ch === "R") j = skipWs(command, j + 1);
  const extracted = extractQuoted(command, j);
  const window = command.slice(extracted.next, extracted.next + 48);
  if (window.includes("write_text(") || window.includes("write_bytes(")) {
    pushUnique(out, "python-pathlib", extracted.value);
  }
}
function extractIoWrite(command: string, out: ShellWriteTarget[]): void {
  const i = skipWs(command, 0);
  if (command[i] !== "[") return;
  const needles = ["WriteAllText(", "WriteAllBytes("];
  for (const needle of needles) {
    const at = command.indexOf(needle, i);
    if (at < 0) continue;
    const j = skipWs(command, at + needle.length);
    const extracted = extractQuoted(command, j);
    pushUnique(out, "io-writealltext", extracted.value);
  }
}
function classifySimpleWrite(command: string): ShellWriteTarget[] {
  const out: ShellWriteTarget[] = [];
  extractAfterVerb(command, "Set-Content", "set-content", out);
  extractAfterVerb(command, "Add-Content", "add-content", out);
  extractAfterVerb(command, "Out-File", "out-file", out);
  extractPythonPathlib(command, out);
  extractIoWrite(command, out);
  return out;
}
export function classifyShellWriteTargets(command: string): ShellWriteTarget[] {
  const cmd = command.trim();
  if (cmd.length === 0) return [];
  const segments = splitWriteSegments(cmd);
  if (segments.length === 1) return classifySimpleWrite(segments[0] ?? cmd);
  const found: ShellWriteTarget[] = [];
  for (const seg of segments) found.push(...classifySimpleWrite(seg));
  if (found.length === 0) return [];
  return found.map((d) => ({ ...d, unprovable: true as const }));
}

export function isInRepoShellWritePath(projectRoot: string, dest: string): boolean {
  const path = dest.trim();
  if (path.length === 0) return false;
  if (path.includes("*") || path.includes("?") || path.includes("$")) return false;
  const root = resolve(projectRoot);
  if (isAbsolute(path)) {
    const abs = resolve(path);
    const rel = relative(root, abs);
    if (rel.length === 0) return false;
    if (rel.startsWith("..") || isAbsolute(rel)) return false;
    return true;
  }
  const normalized = normalize(path);
  if (normalized.split(sep).includes("..") || normalized.split("/").includes("..")) return false;
  return true;
}
