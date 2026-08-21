/**
 * Product dest-form classifier for in-repo Shell mutations (#3438).
 *
 * NEW harvest — do not reuse `classifyShellAuthzOps` / `listShellOps` as-is.
 * Those return [] for `git checkout --` / `rm` of ordinary product paths.
 * Residual known-open: `python -c`, `cmd /c copy`, obfuscated `bash -c`.
 * Commit-time active-scope is out of this slice (#3438).
 */

import { record, toolInputRecord } from "./classify/payload.js";

export type ProductDestFormKind = "git-checkout" | "git-restore" | "rm" | "rmdir";

export interface ProductDestForm {
  readonly kind: ProductDestFormKind;
  readonly path: string;
  /** True when the dest token is a glob/variable, not a concrete path. */
  readonly expansion?: boolean;
}

/** Injected write target for expansion dests so the fence cannot match a literal glob. */
export const SHELL_DEST_EXPANSION_SENTINEL = "__shell_dest_expansion__";

const EXPANSION_DEST = /[*?[\]$`{}]/;

const WRAP_BINS = new Set(["sudo", "env", "command"]);

const GIT_GLOBAL_VALUE_OPTS = new Set([
  "-C",
  "-c",
  "--git-dir",
  "--work-tree",
  "--namespace",
  "--config-env",
  "--super-prefix",
  "--list-cmds",
]);

const RESTORE_VALUE_OPTS = new Set(["--source", "-s", "--conflict"]);

/**
 * Inject a dest path so `inspectMutationGates` sees the same write target as Edit/Write.
 * Preserves original payload fields (command, posture markers).
 */
export function payloadWithInjectedWriteTarget(
  payload: unknown,
  destPath: string,
): Record<string, unknown> {
  const rec = record(payload) ?? {};
  const toolInput = toolInputRecord(rec);
  return {
    ...rec,
    tool_input: {
      ...(toolInput ?? {}),
      file_path: destPath,
    },
  };
}

/**
 * Classify recognized product dest-forms in a shell command (#3438 v1 list).
 * Empty when the command is not `git checkout -- <paths>`, `git restore`, or `rm`/`rmdir`.
 */
export function destFormHasExpansion(path: string): boolean {
  return EXPANSION_DEST.test(path);
}

export function classifyProductDestForms(command: string): ProductDestForm[] {
  const cmd = command.trim();
  if (cmd.length === 0) return [];
  const found: ProductDestForm[] = [];
  const seen = new Set<string>();
  let cwd: string | null = null;
  for (const raw of splitDestFormSegments(cmd)) {
    const cd = parseCdDir(raw);
    if (cd !== null) {
      cwd = joinDestPrefix(cwd, cd);
      continue;
    }
    for (const dest of classifyDestFormSegment(raw)) {
      const path = joinDestPrefix(cwd, dest.path);
      const expansion = destFormHasExpansion(path);
      const key = `${dest.kind}\0${path}`;
      if (seen.has(key)) continue;
      seen.add(key);
      found.push(
        expansion ? { kind: dest.kind, path, expansion: true } : { kind: dest.kind, path },
      );
    }
  }
  return found;
}

function splitDestFormSegments(command: string): string[] {
  const segments: string[] = [];
  let cur = "";
  let quote: "'" | '"' | null = null;
  for (let i = 0; i < command.length; i++) {
    const c = command[i];
    if (c === undefined) break;
    if (quote !== null) {
      if (c === quote) quote = null;
      cur += c;
      continue;
    }
    if (c === "\\" && i + 1 < command.length) {
      cur += c;
      cur += command[i + 1] ?? "";
      i++;
      continue;
    }
    if (c === "'" || c === '"') {
      quote = c;
      cur += c;
      continue;
    }
    if (c === "&" && command[i + 1] === "&") {
      segments.push(cur);
      cur = "";
      i++;
      continue;
    }
    if (c === "|" && command[i + 1] === "|") {
      segments.push(cur);
      cur = "";
      i++;
      continue;
    }
    if (c === ";" || c === "|" || c === "&" || c === "\n" || c === "\r") {
      segments.push(cur);
      cur = "";
      continue;
    }
    cur += c;
  }
  segments.push(cur);
  return segments;
}

function tokenizeSegment(segment: string): string[] {
  const tokens: string[] = [];
  let cur = "";
  let quote: "'" | '"' | null = null;
  const push = (): void => {
    if (cur.length > 0) {
      tokens.push(cur);
      cur = "";
    }
  };
  for (let i = 0; i < segment.length; i++) {
    const c = segment[i];
    if (c === undefined) break;
    if (quote !== null) {
      if (c === quote) {
        quote = null;
        continue;
      }
      if (quote === '"' && c === "\\" && i + 1 < segment.length) {
        cur += segment[i + 1] ?? "";
        i++;
        continue;
      }
      cur += c;
      continue;
    }
    if (c === "'" || c === '"') {
      quote = c;
      continue;
    }
    if (c === " " || c === "\t") {
      push();
      continue;
    }
    cur += c;
  }
  push();
  return tokens;
}

function isEnvAssign(token: string): boolean {
  const eq = token.indexOf("=");
  if (eq <= 0) return false;
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(token.slice(0, eq));
}

function skipPrefix(tokens: string[]): number {
  let i = 0;
  while (i < tokens.length) {
    const tok = tokens[i];
    if (tok === undefined || !isEnvAssign(tok)) break;
    i++;
  }
  const wrap = tokens[i]?.toLowerCase();
  if (wrap !== undefined && WRAP_BINS.has(wrap)) {
    i++;
    while (i < tokens.length) {
      const tok = tokens[i];
      if (tok === undefined || !isEnvAssign(tok)) break;
      i++;
    }
  }
  return i;
}

function joinDestPrefix(prefix: string | null, path: string): string {
  if (prefix === null || prefix.length === 0) return path;
  if (path.startsWith("/") || /^[A-Za-z]:[\\/]/.test(path)) return path;
  const left = prefix.replace(/[\\/]+$/, "");
  const right = path.replace(/^[\\/]+/, "");
  return `${left}/${right}`;
}

function parseCdDir(segment: string): string | null {
  const tokens = tokenizeSegment(segment.trim());
  let i = skipPrefix(tokens);
  const bin = tokens[i]?.toLowerCase();
  if (bin !== "cd") return null;
  i++;
  while (i < tokens.length) {
    const t = tokens[i];
    if (t === undefined || t === "--" || !t.startsWith("-")) break;
    i++;
  }
  if (tokens[i] === "--") i++;
  const dir = tokens[i];
  if (dir === undefined || dir === "-" || dir.length === 0) return null;
  return dir;
}

function skipGitGlobals(tokens: string[], start: number): { i: number; workTree: string | null } {
  let i = start;
  let workTree: string | null = null;
  while (i < tokens.length) {
    const t = tokens[i];
    if (t === undefined || !t.startsWith("-")) return { i, workTree };
    if (t.startsWith("--work-tree=")) {
      workTree = t.slice("--work-tree=".length) || workTree;
      i++;
      continue;
    }
    if (t === "--work-tree" || t === "-C") {
      workTree = tokens[i + 1] ?? workTree;
      i += 2;
      continue;
    }
    if (t.startsWith("--") && t.includes("=")) {
      i++;
      continue;
    }
    if (GIT_GLOBAL_VALUE_OPTS.has(t)) {
      i += 2;
      continue;
    }
    if (t.startsWith("-C") && t.length > 2) {
      workTree = t.slice(2);
      i++;
      continue;
    }
    if (t.startsWith("-c")) {
      i++;
      continue;
    }
    i++;
  }
  return { i, workTree };
}

function pathsAfterDashDash(tokens: string[], start: number): string[] {
  const dash = tokens.indexOf("--", start);
  if (dash < 0) return [];
  return tokens.slice(dash + 1).filter((t) => t.length > 0);
}

function skipRestoreFlag(tokens: string[], i: number): number {
  const t = tokens[i];
  if (t === undefined) return i;
  if (t.startsWith("--") && t.includes("=")) return i + 1;
  if (RESTORE_VALUE_OPTS.has(t)) return i + 2;
  if (t.startsWith("-s") && t.length > 2) return i + 1;
  return i + 1;
}

function dests(kind: ProductDestFormKind, paths: readonly string[]): ProductDestForm[] {
  return paths.filter((path) => path.length > 0).map((path) => ({ kind, path }));
}

function classifyDestFormSegment(segment: string): ProductDestForm[] {
  const tokens = tokenizeSegment(segment.trim());
  let i = skipPrefix(tokens);
  const binRaw = tokens[i];
  if (binRaw === undefined) return [];
  const bin = binRaw.toLowerCase();

  if (bin === "git" || bin === "git.exe") {
    const skipped = skipGitGlobals(tokens, i + 1);
    i = skipped.i;
    const prefix = skipped.workTree;
    const sub = tokens[i]?.toLowerCase();
    if (sub === "checkout") {
      return dests(
        "git-checkout",
        pathsAfterDashDash(tokens, i + 1).map((p) => joinDestPrefix(prefix, p)),
      );
    }
    if (sub === "restore") {
      i++;
      const afterDash = pathsAfterDashDash(tokens, i);
      if (afterDash.length > 0) {
        return dests(
          "git-restore",
          afterDash.map((p) => joinDestPrefix(prefix, p)),
        );
      }
      const paths: string[] = [];
      while (i < tokens.length) {
        const t = tokens[i];
        if (t === undefined) break;
        if (t === "--") {
          paths.push(...tokens.slice(i + 1));
          break;
        }
        if (t.startsWith("-")) {
          i = skipRestoreFlag(tokens, i);
          continue;
        }
        paths.push(t);
        i++;
      }
      return dests(
        "git-restore",
        paths.map((p) => joinDestPrefix(prefix, p)),
      );
    }
    return [];
  }

  if (bin === "rm" || bin === "rm.exe") {
    return dests("rm", collectRmPaths(tokens, i + 1));
  }
  if (bin === "rmdir" || bin === "rmdir.exe") {
    return dests("rmdir", collectRmPaths(tokens, i + 1));
  }
  return [];
}

function collectRmPaths(tokens: string[], start: number): string[] {
  const paths: string[] = [];
  let i = start;
  while (i < tokens.length) {
    const t = tokens[i];
    if (t === undefined) break;
    if (t === "--") {
      paths.push(...tokens.slice(i + 1));
      break;
    }
    if (t.startsWith("-")) {
      i++;
      continue;
    }
    paths.push(t);
    i++;
  }
  return paths;
}
