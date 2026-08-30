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

function extractAfterVerb(
  command: string,
  verb: string,
  kind: ShellWriteKind,
  out: ShellWriteTarget[],
): void {
  const lower = command.toLowerCase();
  const needle = verb.toLowerCase();
  let from = 0;
  while (from < lower.length) {
    const i = lower.indexOf(needle, from);
    if (i < 0) break;
    let j = skipWs(command, i + verb.length);
    const head = command.slice(j, j + 12).toLowerCase();
    if (head.startsWith("-path")) j = skipWs(command, j + 5);
    else if (head.startsWith("-literalpath")) j = skipWs(command, j + 12);
    else if (head.startsWith("-filepath")) j = skipWs(command, j + 9);
    const extracted = extractQuoted(command, j);
    pushUnique(out, kind, extracted.value);
    from = i + needle.length;
  }
}
function extractPythonPathlib(command: string, out: ShellWriteTarget[]): void {
  const needle = "Path(";
  let from = 0;
  while (from < command.length) {
    const i = command.indexOf(needle, from);
    if (i < 0) break;
    let j = skipWs(command, i + needle.length);
    const ch = command[j];
    if (ch === "r" || ch === "R") j = skipWs(command, j + 1);
    const extracted = extractQuoted(command, j);
    const window = command.slice(extracted.next, extracted.next + 48);
    if (window.includes("write_text") || window.includes("write_bytes")) {
      pushUnique(out, "python-pathlib", extracted.value);
    }
    from = i + needle.length;
  }
}

function extractIoWrite(command: string, out: ShellWriteTarget[]): void {
  const needles = ["WriteAllText(", "WriteAllBytes("];
  for (const needle of needles) {
    let from = 0;
    while (from < command.length) {
      const i = command.indexOf(needle, from);
      if (i < 0) break;
      const j = skipWs(command, i + needle.length);
      const extracted = extractQuoted(command, j);
      pushUnique(out, "io-writealltext", extracted.value);
      from = i + needle.length;
    }
  }
}
export function classifyShellWriteTargets(command: string): ShellWriteTarget[] {
  const cmd = command.trim();
  if (cmd.length === 0) return [];
  const out: ShellWriteTarget[] = [];
  extractAfterVerb(cmd, "Set-Content", "set-content", out);
  extractAfterVerb(cmd, "Add-Content", "add-content", out);
  extractAfterVerb(cmd, "Out-File", "out-file", out);
  extractPythonPathlib(cmd, out);
  extractIoWrite(cmd, out);
  return out;
}

function looksLikeTempPath(path: string): boolean {
  const lower = path.toLowerCase().replace(/\\/g, "/");
  if (lower.includes("/temp/")) return true;
  if (lower.includes("/tmp/")) return true;
  if (lower.includes("/tmpdir/")) return true;
  return false;
}

export function isInRepoShellWritePath(projectRoot: string, dest: string): boolean {
  const path = dest.trim();
  if (path.length === 0) return false;
  if (path.includes("*") || path.includes("?") || path.includes("$")) return false;
  if (looksLikeTempPath(path)) return false;
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
