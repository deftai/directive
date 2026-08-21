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
  /**
   * True when the dest token is a glob/variable, or when the command's cwd
   * cannot be reconstructed (subshell grouping). Both stay fail-closed.
   */
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
  // Subshell grouping moves cwd in ways this splitter does not model, so a
  // reconstructed path is not trustworthy — fail closed on the whole command.
  const groupingUnsafe = hasSubshellGrouping(cmd);
  let cwd: string | null = null;
  for (const list of splitDestFormLists(cmd)) {
    // Inherit-in is unconditional: a subshell starts in the parent's cwd.
    let listCwd: string | null = cwd;
    for (const seg of list.segments) {
      const cd = parseCdDir(seg.text);
      if (cd !== null) {
        // Confined to a pipeline member's subshell, or on the `||` failure
        // branch where reaching the next segment means the `cd` did not happen.
        if (!seg.pipelineMember && !seg.closedByOr) listCwd = joinDestPrefix(listCwd, cd);
        continue;
      }
      for (const dest of classifyDestFormSegment(seg.text)) {
        const path = joinDestPrefix(listCwd, dest.path);
        const expansion = groupingUnsafe || dest.expansion === true || destFormHasExpansion(path);
        const key = `${dest.kind}\0${path}`;
        if (seen.has(key)) continue;
        seen.add(key);
        found.push(
          expansion ? { kind: dest.kind, path, expansion: true } : { kind: dest.kind, path },
        );
      }
    }
    // `&` runs the whole and-or list in a subshell, so nothing it did to cwd
    // reaches the lists after it.
    if (!list.backgrounded) cwd = listCwd;
  }
  return found;
}

interface DestFormSegment {
  readonly text: string;
  /**
   * True when this segment is a member of a `|` pipeline (on either side). A
   * pipeline member runs in a subshell, so a `cd` in it retargets nothing —
   * but it still *reads* the enclosing cwd, which is why inheritance is not
   * gated on this flag.
   */
  readonly pipelineMember: boolean;
  /**
   * True when terminated by `||`. The next segment runs only if this one
   * FAILED, so a `cd` here must not retarget it: `cd sub || rm x` removes root
   * `x`, because reaching `rm x` means the `cd` did not happen (#3438).
   */
  readonly closedByOr: boolean;
}

/**
 * One `&`- / `;`-delimited and-or list.
 *
 * ! Three separate facts, do not collapse them into one per-segment boolean
 * (#3438). Inheritance into a segment is unconditional — a subshell starts in
 * the parent's cwd — so gating it drops the parent prefix and the fence
 * inspects a shallower path than the shell mutates. Confinement is per
 * construct and follows shell precedence: `|` binds tighter than `&&`/`||`,
 * which bind tighter than `&`. So `cd sub && rm a | rm b` runs BOTH removals
 * in `sub`, while `cd sub && rm a & rm b` backgrounds the whole `cd sub &&
 * rm a` list and leaves `rm b` in the parent at the original cwd.
 */
interface DestFormList {
  readonly segments: readonly DestFormSegment[];
  /** True when terminated by `&`: the entire list ran in a subshell. */
  readonly backgrounded: boolean;
}

/** Unquoted `(` / `)`: subshell grouping this splitter does not model. */
function hasSubshellGrouping(command: string): boolean {
  let quote: "'" | '"' | null = null;
  for (let i = 0; i < command.length; i++) {
    const c = command[i];
    if (c === undefined) break;
    if (quote !== null) {
      if (c === quote) quote = null;
      continue;
    }
    if (c === "\\" && i + 1 < command.length) {
      i++;
      continue;
    }
    if (c === "'" || c === '"') {
      quote = c;
      continue;
    }
    if (c === "(" || c === ")") return true;
  }
  return false;
}

function splitDestFormLists(command: string): DestFormList[] {
  const lists: DestFormList[] = [];
  let segments: DestFormSegment[] = [];
  let cur = "";
  let openedByPipe = false;
  let quote: "'" | '"' | null = null;
  const endSegment = (closedByPipe: boolean, closedByOr = false): void => {
    segments.push({ text: cur, pipelineMember: openedByPipe || closedByPipe, closedByOr });
    cur = "";
    openedByPipe = closedByPipe;
  };
  const endList = (backgrounded: boolean): void => {
    endSegment(false);
    lists.push({ segments, backgrounded });
    segments = [];
    openedByPipe = false;
  };
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
      endSegment(false);
      i++;
      continue;
    }
    if (c === "|" && command[i + 1] === "|") {
      endSegment(false, true);
      i++;
      continue;
    }
    if (c === "|") {
      endSegment(true);
      continue;
    }
    // `&` and `;` close the whole and-or list; `&` backgrounds it.
    if (c === "&") {
      endList(true);
      continue;
    }
    if (c === ";" || c === "\n" || c === "\r") {
      endList(false);
      continue;
    }
    cur += c;
  }
  endList(false);
  return lists;
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

function gitWorkTreeFromAssign(token: string): string | null {
  const eq = token.indexOf("=");
  if (eq <= 0) return null;
  if (token.slice(0, eq) !== "GIT_WORK_TREE") return null;
  const value = token.slice(eq + 1);
  return value.length > 0 ? value : null;
}

function skipPrefix(tokens: string[]): { i: number; workTree: string | null } {
  let i = 0;
  let workTree: string | null = null;
  while (i < tokens.length) {
    const tok = tokens[i];
    if (tok === undefined || !isEnvAssign(tok)) break;
    workTree = gitWorkTreeFromAssign(tok) ?? workTree;
    i++;
  }
  const wrap = tokens[i]?.toLowerCase();
  if (wrap !== undefined && WRAP_BINS.has(wrap)) {
    i++;
    while (i < tokens.length) {
      const tok = tokens[i];
      if (tok === undefined || !isEnvAssign(tok)) break;
      workTree = gitWorkTreeFromAssign(tok) ?? workTree;
      i++;
    }
  }
  return { i, workTree };
}

function trimSlashEnd(value: string): string {
  let i = value.length;
  while (i > 0 && (value[i - 1] === "/" || value[i - 1] === "\\")) i--;
  return value.slice(0, i);
}

function trimSlashStart(value: string): string {
  let i = 0;
  while (i < value.length && (value[i] === "/" || value[i] === "\\")) i++;
  return value.slice(i);
}

function joinDestPrefix(prefix: string | null, path: string): string {
  if (prefix === null || prefix.length === 0) return path;
  if (path.startsWith("/") || /^[A-Za-z]:[\\/]/.test(path)) return path;
  return `${trimSlashEnd(prefix)}/${trimSlashStart(path)}`;
}

function parseCdDir(segment: string): string | null {
  const tokens = tokenizeSegment(segment.trim());
  let i = skipPrefix(tokens).i;
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

function skipGitGlobals(
  tokens: string[],
  start: number,
): { i: number; workTree: string | null; unsafe: boolean } {
  let i = start;
  // `-C` composes rather than overwrites: `git -C a -C b` runs in `a/b`, and an
  // absolute `-C` resets the chain. `--work-tree` resolves against the `-C`
  // chain seen before it, so absorb the base at the point it appears (#3438).
  let base: string | null = null;
  let workTree: string | null = null;
  let unsafe = false;
  const effective = (): string | null => (workTree === null ? base : workTree);
  while (i < tokens.length) {
    const t = tokens[i];
    if (t === undefined || !t.startsWith("-")) return { i, workTree: effective(), unsafe };
    if (t === "-c" || t === "--config-env") {
      if (isCoreWorkTreeConfig(tokens[i + 1])) unsafe = true;
      i += 2;
      continue;
    }
    if (t.startsWith("--config-env=")) {
      if (isCoreWorkTreeConfig(t.slice("--config-env=".length))) unsafe = true;
      i++;
      continue;
    }
    if (t.startsWith("--work-tree=")) {
      const val = t.slice("--work-tree=".length);
      if (val.length > 0) workTree = joinDestPrefix(base, val);
      i++;
      continue;
    }
    if (t === "--work-tree") {
      const val = tokens[i + 1];
      if (val !== undefined && val.length > 0) workTree = joinDestPrefix(base, val);
      i += 2;
      continue;
    }
    if (t === "-C") {
      const val = tokens[i + 1];
      if (val !== undefined && val.length > 0) base = joinDestPrefix(base, val);
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
      base = joinDestPrefix(base, t.slice(2));
      i++;
      continue;
    }
    if (t.startsWith("-c")) {
      if (isCoreWorkTreeConfig(t.slice(2))) unsafe = true;
      i++;
      continue;
    }
    i++;
  }
  return { i, workTree: effective(), unsafe };
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

function dests(
  kind: ProductDestFormKind,
  paths: readonly string[],
  unsafe = false,
): ProductDestForm[] {
  return paths
    .filter((path) => path.length > 0)
    .map((path) => (unsafe ? { kind, path, expansion: true as const } : { kind, path }));
}

/**
 * `-c core.workTree=...` / `--config-env` relocates the work tree through git
 * config. Resolution depends on the git dir, which this classifier does not
 * model, so the target is not reconstructable and stays fail-closed (#3438).
 */
function isCoreWorkTreeConfig(token: string | undefined): boolean {
  if (token === undefined) return false;
  const eq = token.indexOf("=");
  const key = eq < 0 ? token : token.slice(0, eq);
  return key.toLowerCase() === "core.worktree";
}

function classifyDestFormSegment(segment: string): ProductDestForm[] {
  const tokens = tokenizeSegment(segment.trim());
  const prefixSkip = skipPrefix(tokens);
  let i = prefixSkip.i;
  const binRaw = tokens[i];
  if (binRaw === undefined) return [];
  const bin = binRaw.toLowerCase();

  if (bin === "git" || bin === "git.exe") {
    const skipped = skipGitGlobals(tokens, i + 1);
    i = skipped.i;
    const prefix = skipped.workTree ?? prefixSkip.workTree;
    const unsafe = skipped.unsafe;
    const sub = tokens[i]?.toLowerCase();
    if (sub === "checkout") {
      return dests(
        "git-checkout",
        pathsAfterDashDash(tokens, i + 1).map((p) => joinDestPrefix(prefix, p)),
        unsafe,
      );
    }
    if (sub === "restore") {
      i++;
      const afterDash = pathsAfterDashDash(tokens, i);
      if (afterDash.length > 0) {
        return dests(
          "git-restore",
          afterDash.map((p) => joinDestPrefix(prefix, p)),
          unsafe,
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
        unsafe,
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
