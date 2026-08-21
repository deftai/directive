/**
 * Product dest-form classifier for in-repo Shell mutations (#3438).
 *
 * NEW harvest — do not reuse `classifyShellAuthzOps` / `listShellOps` as-is.
 * Those return [] for `git checkout --` / `rm` of ordinary product paths.
 *
 * ! Resolves a target for ONE shape only: a single simple command. Everything
 * else is recognized and fail-closed. Reconstructing a target from shell state
 * was implemented and withdrawn — cwd depends on operator precedence, on exit
 * status, on subshell boundaries, and on git config, and every resolution rule
 * added produced its own fence bypass. Do not add it back; widen the recognized
 * *forms* instead, and see `content/contracts/path-write-fence.md`.
 *
 * Residual known-open (recognition, not resolution): `python -c`,
 * `cmd /c copy`, obfuscated `bash -c`. Commit-time active-scope is out of this
 * slice (#3438).
 */

import { record, toolInputRecord } from "./classify/payload.js";

export type ProductDestFormKind = "git-checkout" | "git-restore" | "rm" | "rmdir";

export interface ProductDestForm {
  readonly kind: ProductDestFormKind;
  readonly path: string;
  /**
   * True when the target is not provable — a glob/variable or leading `~` dest,
   * a git context option, or any command that is not a single simple one. The
   * dispatcher denies these outright; `path` is then only for the message, and
   * is `SHELL_DEST_EXPANSION_SENTINEL` when no token can be named.
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
 * Characters a preceding backslash escapes in an unquoted word. A backslash
 * before anything else is retained, so Windows dests keep their separators.
 */
const SHELL_ESCAPABLE = new Set([
  " ",
  "\t",
  "\n",
  "\r",
  '"',
  "'",
  "\\",
  "$",
  "`",
  "&",
  "|",
  ";",
  "(",
  ")",
  "<",
  ">",
  "*",
  "?",
  "[",
  "]",
  "{",
  "}",
  "~",
  "#",
]);

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
  const segments = splitCommandSegments(cmd);
  // A single simple command is the only shape whose target this classifier can
  // PROVE. Anything compound gets recognized but never resolved: reconstructing
  // a target from shell state was tried and abandoned (#3438) — cwd depends on
  // operator precedence, on exit status (`cd x || …`), on subshell boundaries,
  // and on git context options, so each reconstruction rule grew its own
  // bypass.
  //
  // ⊗ Recognition is NOT total either, and this is not a security boundary.
  // Only four verbs are recognized, and a non-literal verb (`\rm`, `rm${IFS}x`)
  // defeats the tokenizer, so the fail-closed branch below only fires when the
  // verb is still legible. Unrecognized mutators (`git reset --hard`,
  // `git clean`, `git checkout` without `--`, `mv`, `sed -i`, `>` redirection)
  // and interpreters (`bash -c`, `python -c`) are fail-OPEN. See the threat
  // model in content/contracts/path-write-fence.md: this is a guardrail for
  // careless agents, not a boundary against adversarial ones.
  if (segments.length === 1 && !hasUnsupportedSyntax(cmd)) {
    return classifySimpleDestForms(segments[0] ?? "");
  }
  // Compound: report one fail-closed dest per recognized kind. No path is
  // claimed, because any path claimed here would be a guess.
  const kinds = new Set<ProductDestFormKind>();
  for (const seg of segments) {
    for (const dest of classifyDestFormSegment(seg)) kinds.add(dest.kind);
  }
  return [...kinds].map((kind) => ({
    kind,
    path: SHELL_DEST_EXPANSION_SENTINEL,
    expansion: true as const,
  }));
}

/** Classify one command with no operators, no grouping, and no substitution. */
function classifySimpleDestForms(segment: string): ProductDestForm[] {
  const found: ProductDestForm[] = [];
  const seen = new Set<string>();
  for (const dest of classifyDestFormSegment(segment)) {
    const path = dest.path;
    const expansion =
      // `unsafe` from the classifier (git context options relocate the tree).
      dest.expansion === true ||
      // `~` expands to $HOME only at the START of a word, so a trailing `~`
      // (`foo.ts~`) is an ordinary path and must not be swept up here.
      path.startsWith("~") ||
      destFormHasExpansion(path);
    const key = `${dest.kind}\0${path}`;
    if (seen.has(key)) continue;
    seen.add(key);
    found.push(expansion ? { kind: dest.kind, path, expansion: true } : { kind: dest.kind, path });
  }
  return found;
}

/**
 * Unquoted syntax whose effect on the target this classifier does not model:
 * subshell grouping, brace groups, and command substitution. Presence of any of
 * it makes the command non-simple, so it is recognized and fail-closed rather
 * than resolved (#3438).
 */
function hasUnsupportedSyntax(command: string): boolean {
  let quote: "'" | '"' | null = null;
  for (let i = 0; i < command.length; i++) {
    const c = command[i];
    if (c === undefined) break;
    if (quote !== null) {
      // A single-quoted string is fully literal; `"` still expands `$` / backtick.
      if (c === quote) quote = null;
      else if (quote === '"' && (c === "$" || c === "`")) return true;
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
    if (c === "(" || c === ")" || c === "{" || c === "}" || c === "`" || c === "$") return true;
  }
  return false;
}

/**
 * Split on unquoted `&&`, `||`, `|`, `&`, `;`, and newline. Segment TEXT only —
 * deliberately no cwd or precedence metadata. A command that splits into more
 * than one segment is not simple, and the only thing done with the pieces is to
 * recognize which dest-form kinds appear in them.
 */
function splitCommandSegments(command: string): string[] {
  const segments: string[] = [];
  let cur = "";
  let quote: "'" | '"' | null = null;
  const flush = (): void => {
    segments.push(cur);
    cur = "";
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
    if ((c === "&" && command[i + 1] === "&") || (c === "|" && command[i + 1] === "|")) {
      flush();
      i++;
      continue;
    }
    if (c === "|" || c === "&" || c === ";" || c === "\n" || c === "\r") {
      flush();
      continue;
    }
    cur += c;
  }
  flush();
  return segments.filter((seg) => seg.trim().length > 0);
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
    if (c === "\\" && i + 1 < segment.length) {
      const next = segment[i + 1] ?? "";
      // `rm protected\ file` is ONE path. But this module also accepts Windows
      // dests (`C:\Repos\file.ts`), where a backslash is a separator, not an
      // escape — so only consume it before a character that needs escaping and
      // otherwise keep it verbatim (#3438).
      if (SHELL_ESCAPABLE.has(next)) {
        cur += next;
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

/** `GIT_WORK_TREE=` / `GIT_DIR=` relocate the tree the same way `-C` does. */
function isGitWorkTreeAssign(token: string): boolean {
  const eq = token.indexOf("=");
  if (eq <= 0) return false;
  const key = token.slice(0, eq);
  if (key !== "GIT_WORK_TREE" && key !== "GIT_DIR") return false;
  return token.length > eq + 1;
}

function skipPrefix(tokens: string[]): { i: number; gitContext: boolean } {
  let i = 0;
  let gitContext = false;
  const consumeAssigns = (): void => {
    while (i < tokens.length) {
      const tok = tokens[i];
      if (tok === undefined) break;
      // Standalone grouping / negation punctuation: skip so the binary behind it
      // is still RECOGNIZED. Only compound commands can reach here, and every
      // one of them is fail-closed, so liberal recognition is the safe side.
      if (tok === "{" || tok === "}" || tok === "(" || tok === ")" || tok === "!") {
        i++;
        continue;
      }
      if (!isEnvAssign(tok)) break;
      if (isGitWorkTreeAssign(tok)) gitContext = true;
      i++;
    }
  };
  consumeAssigns();
  const wrap = tokens[i]?.toLowerCase();
  if (wrap !== undefined && WRAP_BINS.has(wrap)) {
    i++;
    consumeAssigns();
  }
  return { i, gitContext };
}

/**
 * Skip git's global options, reporting whether any of them RELOCATES the work
 * tree. Relocation is not resolved: `-C` composes, `--work-tree` resolves
 * against the `-C` chain, `--git-dir` interacts with both, and `-c
 * core.workTree` depends on the git dir. Each of those resolution rules grew
 * its own fence bypass (#3438), so a relocating command fails closed instead.
 */
function skipGitGlobals(tokens: string[], start: number): { i: number; gitContext: boolean } {
  let i = start;
  let gitContext = false;
  while (i < tokens.length) {
    const t = tokens[i];
    if (t === undefined || !t.startsWith("-")) return { i, gitContext };
    if (t === "-c" || t === "--config-env") {
      if (isCoreWorkTreeConfig(tokens[i + 1])) gitContext = true;
      i += 2;
      continue;
    }
    if (t.startsWith("--config-env=")) {
      if (isCoreWorkTreeConfig(t.slice("--config-env=".length))) gitContext = true;
      i++;
      continue;
    }
    if (t === "-C" || t === "--work-tree" || t === "--git-dir") {
      gitContext = true;
      i += 2;
      continue;
    }
    if (
      t.startsWith("--work-tree=") ||
      t.startsWith("--git-dir=") ||
      (t.startsWith("-C") && t.length > 2)
    ) {
      gitContext = true;
      i++;
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
    if (t.startsWith("-c")) {
      if (isCoreWorkTreeConfig(t.slice(2))) gitContext = true;
      i++;
      continue;
    }
    i++;
  }
  return { i, gitContext };
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
  // Strip grouping punctuation glued to the binary (`{rm`, `(rm`) for the same
  // recognition reason as in skipPrefix. Unquoted grouping can only appear in a
  // command that is already fail-closed.
  const bin = binRaw.replace(/^[({!]+/, "").toLowerCase();

  if (bin === "git" || bin === "git.exe") {
    const skipped = skipGitGlobals(tokens, i + 1);
    i = skipped.i;
    // Any relocating context option makes the target unprovable — fail closed.
    const unsafe = skipped.gitContext || prefixSkip.gitContext;
    const sub = tokens[i]?.toLowerCase();
    if (sub === "checkout") {
      return dests("git-checkout", pathsAfterDashDash(tokens, i + 1), unsafe);
    }
    if (sub === "restore") {
      i++;
      const afterDash = pathsAfterDashDash(tokens, i);
      if (afterDash.length > 0) return dests("git-restore", afterDash, unsafe);
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
      return dests("git-restore", paths, unsafe);
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
