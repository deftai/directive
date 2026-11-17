/**
 * Commit-target resolver for the prospective scope-cover gate (#6278 / #6247).
 *
 * One quote-aware tokenizer feeds commit recognition, target resolution and the
 * index-mutating-form check, so a quoted and an unquoted path resolve the same
 * way. Two literal shapes name a checkout: `git -C <absolute path> commit …` and
 * one `cd <absolute path>` joined to the commit by `&&`. A commit with neither is
 * judged at the hook project root, as before. Any other `cd` / `-C` / location
 * override on a commit is unresolvable and refused by the caller. This is not a
 * general shell interpreter (content/docs/hook-root-admission.md).
 *
 * Every commit detector reads the command after the shared authz preprocess
 * removes the bodies of quoted-delimiter heredocs (`<<'EOF'`, `<<"EOF"`,
 * `<<\EOF`), which the shell never expands, so such a body that only names a
 * commit is data, not a commit (#6187). An unquoted heredoc body stays visible,
 * because the shell expands it (operator ruling 2026-11-16), but it is read as a
 * chunk of its own, so a quote in it cannot run into the commands after the
 * delimiter (operator ruling 2026-11-17). Other string literals stay a residual
 * of the quote-aware tokenizer.
 */

import { shellCommandChunksWithoutQuotedHereDocBodies } from "../authz/classify.js";

/** One shell word after quote removal. */
export interface ShellWord {
  readonly value: string;
  /** True when the word holds `$`, a backtick or a leading `~` outside single quotes. */
  readonly expands: boolean;
  /**
   * Set when the word starts with an unquoted, unescaped redirection (optional
   * digits or one `&`, then `<` or `>`): `"operator"` when the operator stands
   * alone so the next word is its target, `"attached"` when the target is in the
   * same word. A redirection and its target are not command arguments (#6471).
   */
  readonly redirect?: "operator" | "attached";
}

/** Operator that ends a segment (`null` for the last segment). */
export type ShellSegmentSeparator = "&&" | "||" | "|" | ";" | "\n" | null;

export interface ShellSegment {
  readonly words: readonly ShellWord[];
  readonly next: ShellSegmentSeparator;
}

/** Characters an unquoted backslash escapes; other backslashes stay literal (Windows paths). */
const UNQUOTED_ESCAPABLE = new Set([" ", "\t", '"', "'", "\\", "$", "`", ";", "&", "|", "<", ">"]);
/** Characters a backslash escapes inside double quotes (POSIX). */
const DOUBLE_QUOTED_ESCAPABLE = new Set(['"', "\\", "$", "`"]);

/**
 * Split a shell command into `&&` / `||` / `;` / newline segments of words.
 * Quotes are honoured for both splitting and word values; a quoted path with
 * spaces stays one word and Windows backslashes are not rewritten.
 */
export function tokenizeShellCommand(command: string): ShellSegment[] {
  const text = command.replace(/\r\n/g, "\n");
  const segments: ShellSegment[] = [];
  let words: ShellWord[] = [];
  let cur = "";
  let started = false;
  let expands = false;
  let quote: '"' | "'" | null = null;
  // True once a quote or an escape is in the word, so a later `<` / `>` is not
  // read as the start of a redirection (`'2'>x`, `\2>x`).
  let literalPrefix = false;
  let redirect = false;
  const flushWord = (): void => {
    if (started) {
      const word: ShellWord = { value: cur, expands };
      // An operator alone (`>`, `2>>`, `&>`, `<<<`) takes the next word as its
      // target; anything attached after it (`2>&1`, `>out`) carries its own.
      const redirection = redirect
        ? ({
            // Decided from the raw text: a quote or escape after the operator
            // (`>'>'`) makes a target, so the next word stays an argument.
            redirect: !literalPrefix && /^(?:\d*|&)[<>|&]+$/.test(cur) ? "operator" : "attached",
          } as const)
        : {};
      words.push({ ...word, ...redirection });
    }
    cur = "";
    started = false;
    expands = false;
    literalPrefix = false;
    redirect = false;
  };
  const endSegment = (next: ShellSegmentSeparator): void => {
    flushWord();
    segments.push({ words, next });
    words = [];
  };
  for (let i = 0; i < text.length; i++) {
    const ch = text.charAt(i);
    const nextCh = text.charAt(i + 1);
    if (quote === "'") {
      if (ch === "'") quote = null;
      else cur += ch;
      continue;
    }
    if (quote === '"') {
      if (ch === '"') {
        quote = null;
      } else if (ch === "\\" && DOUBLE_QUOTED_ESCAPABLE.has(nextCh)) {
        cur += nextCh;
        i += 1;
      } else {
        if (ch === "$" || ch === "`") expands = true;
        cur += ch;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      started = true;
      literalPrefix = true;
      continue;
    }
    if (ch === "\\" && UNQUOTED_ESCAPABLE.has(nextCh)) {
      cur += nextCh;
      started = true;
      literalPrefix = true;
      i += 1;
      continue;
    }
    if (ch === "\n") {
      endSegment("\n");
      continue;
    }
    if (ch === ";") {
      endSegment(";");
      continue;
    }
    // `||` and `|&` are recognized before a lone `|`; a `|` right after a
    // redirect's `>` belongs to it (`>|`).
    if ((ch === "&" || ch === "|") && nextCh === ch) {
      endSegment(ch === "&" ? "&&" : "||");
      i += 1;
      continue;
    }
    if (ch === "|" && redirect && cur.endsWith(">")) {
      cur += ch;
      continue;
    }
    if (ch === "|") {
      endSegment("|");
      if (nextCh === "&") i += 1;
      continue;
    }
    if (
      (ch === "<" || ch === ">") &&
      !redirect &&
      !literalPrefix &&
      /^(?:\d*|&)$/.test(cur) &&
      !(cur === "" && nextCh === "(")
    ) {
      redirect = true;
    }
    if (ch === " " || ch === "\t") {
      flushWord();
      continue;
    }
    if (ch === "$" || ch === "`" || (ch === "~" && !started)) expands = true;
    cur += ch;
    started = true;
  }
  endSegment(null);
  // Empty segments (a trailing `;`, a newline after `&&`) carry no command; the
  // operator before them stays on the previous segment.
  return segments.filter((segment) => segment.words.length > 0);
}

/** Quote-aware argv split of one command part (#5656); kept for existing callers. */
export function splitShellArgvPreservingQuotes(part: string): string[] {
  return tokenizeShellCommand(part).flatMap((segment) => segment.words.map((w) => w.value));
}

const ENV_ASSIGNMENT = /^[A-Za-z_][\w.]*=/;

/** Environment prefixes that move the index, work tree or repository of a commit. */
const GIT_LOCATION_ENV = new Set(["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_COMMON_DIR"]);

/** A `git` invocation in one segment, globals parsed (#5656 / #6278). */
interface GitInvocation {
  readonly envNames: readonly string[];
  /** Values of global `-C` options, in order. */
  readonly chdirs: readonly ShellWord[];
  /** True when a global `--git-dir` / `--work-tree` is present. */
  readonly gitDirOrWorkTree: boolean;
  readonly subcommand: string | null;
  /** Index of the first word after the subcommand. */
  readonly argsStart: number;
  readonly words: readonly ShellWord[];
}

function parseGitInvocation(words: readonly ShellWord[]): GitInvocation | null {
  let i = 0;
  const envNames: string[] = [];
  while (i < words.length && ENV_ASSIGNMENT.test(words[i]?.value ?? "")) {
    envNames.push((words[i]?.value ?? "").split("=")[0] ?? "");
    i++;
  }
  const binTok = words[i]?.value;
  if (binTok === undefined) return null;
  const bin = binTok.replace(/^.*[/\\]/, "").toLowerCase();
  if (bin !== "git" && bin !== "git.exe") return null;
  i++;
  const chdirs: ShellWord[] = [];
  let gitDirOrWorkTree = false;
  while (i < words.length) {
    const w = words[i]?.value ?? "";
    if (w === "-C") {
      const target = words[i + 1];
      chdirs.push(target ?? { value: "", expands: false });
      i += 2;
      continue;
    }
    if (w === "--git-dir" || w === "--work-tree") {
      gitDirOrWorkTree = true;
      i += 2;
      continue;
    }
    if (w.startsWith("--git-dir=") || w.startsWith("--work-tree=")) {
      gitDirOrWorkTree = true;
      i += 1;
      continue;
    }
    if (w === "-c") {
      i += 2;
      continue;
    }
    if (w.startsWith("-") && w !== "--") {
      i += 1;
      continue;
    }
    return {
      envNames,
      chdirs,
      gitDirOrWorkTree,
      subcommand: w.toLowerCase(),
      argsStart: i + 1,
      words,
    };
  }
  return { envNames, chdirs, gitDirOrWorkTree, subcommand: null, argsStart: i, words };
}

/**
 * The command words of a segment: leading `{` brace-group openers dropped. A
 * brace group runs in the current shell, so a `cd` or commit inside it is read
 * like one outside it (`{ cd /x; } && git commit` is a `cd` joined by `;`).
 * A subshell `( … )` is not unwrapped: its `cd` does not move a later commit.
 */
function commandWords(segment: ShellSegment): readonly ShellWord[] {
  let start = 0;
  while (segment.words[start]?.value === "{") start++;
  return start === 0 ? segment.words : segment.words.slice(start);
}

/**
 * Segments of the commands the shell runs: quoted heredoc bodies removed, and
 * each unquoted body tokenized apart from the commands around it (#6187).
 */
function commandSegments(command: string): ShellSegment[] {
  // A dangling `||` or `|` at the end of a chunk is still pending after the
  // heredoc body, so it is carried to the end of the next chunk (#6471).
  let pending: ShellSegmentSeparator = null;
  return shellCommandChunksWithoutQuotedHereDocBodies(command).flatMap((chunk) => {
    const segments = tokenizeShellCommand(chunk);
    // The end of a chunk is a heredoc boundary, not an `&&` join: a dangling
    // `&&` must not tie a `cd` here to a commit after the delimiter.
    const last = segments[segments.length - 1];
    if (last !== undefined) {
      const open = last.next === "||" || last.next === "|" ? last.next : null;
      const next = open ?? pending ?? (last.next === ";" ? ";" : "\n");
      segments[segments.length - 1] = { words: last.words, next };
      pending = open;
    }
    return segments;
  });
}

/** The words of a segment that are command arguments: redirections and their targets dropped. */
function withoutRedirections(words: readonly ShellWord[]): ShellWord[] {
  const out: ShellWord[] = [];
  for (let i = 0; i < words.length; i++) {
    const word = words[i];
    if (word === undefined) continue;
    if (word.redirect === "operator") i += 1;
    else if (word.redirect === undefined) out.push(word);
  }
  return out;
}

function commitInvocations(
  segments: readonly ShellSegment[],
): { readonly index: number; readonly git: GitInvocation }[] {
  const out: { index: number; git: GitInvocation }[] = [];
  segments.forEach((segment, index) => {
    const git = parseGitInvocation(commandWords(segment));
    if (git !== null && git.subcommand === "commit") out.push({ index, git });
  });
  return out;
}

/**
 * Detect `git commit` as the git subcommand in a Shell command string (#5656).
 * Handles env prefixes, -C/-c globals and &&/||/; compounds; non-commit git
 * parts do not stop the scan. Obscured forms remain a hooks-installed /
 * `--no-verify` residual.
 */
export function commandHasGitCommitSubcommand(command: string): boolean {
  return commitInvocations(commandSegments(command)).length > 0;
}

/** Long commit options whose value is the next word (so it is not read as a pathspec). */
const COMMIT_VALUE_OPTIONS = new Set([
  "--message",
  "--file",
  "--author",
  "--date",
  "--reuse-message",
  "--reedit-message",
  "--fix",
  "--cleanup",
  "--untracked-files",
]);

/** Short options whose value is the rest of the cluster, or the next word when last. */
const SHORT_VALUE_LETTERS = new Set(["m", "F", "c", "C", "t"]);
/** Short options that take the rest of the cluster and never the next word. */
const SHORT_ATTACHED_ONLY_LETTERS = new Set(["u", "S"]);

/**
 * The first word that makes a commit change the file set after the pre-tool
 * index snapshot, or null (#5656 / #6471): `-a`, `--all`, `-i`, `--include` in
 * any short-option cluster, or a pathspec. Short clusters are read as git reads
 * them, letter by letter: the first value-taking letter (m F c C t) ends the
 * cluster and takes the rest of it, or the next word when it is last; `u` and
 * `S` take the rest of the cluster only. Redirections and their targets are
 * not arguments.
 */
function commitIndexMutatingWord(git: GitInvocation): string | null {
  const words = git.words;
  let i = git.argsStart;
  let afterDashDash = false;
  while (i < words.length) {
    const word = words[i];
    const w = word?.value ?? "";
    if (word?.redirect !== undefined) {
      i += word.redirect === "operator" ? 2 : 1;
      continue;
    }
    if (!afterDashDash && w === "--") {
      afterDashDash = true;
      i += 1;
      continue;
    }
    if (afterDashDash) return w;
    if (w === "--all" || w === "--include") return w;
    if (w.startsWith("--")) {
      i += w.includes("=") || !COMMIT_VALUE_OPTIONS.has(w) ? 1 : 2;
      continue;
    }
    if (w.startsWith("-") && w.length > 1) {
      let nextWordIsValue = false;
      for (let k = 1; k < w.length; k++) {
        const letter = w.charAt(k);
        if (letter === "a" || letter === "i") return w;
        if (SHORT_VALUE_LETTERS.has(letter)) {
          nextWordIsValue = k === w.length - 1;
          break;
        }
        if (SHORT_ATTACHED_ONLY_LETTERS.has(letter)) break;
      }
      i += nextWordIsValue ? 2 : 1;
      continue;
    }
    if (w === "-") {
      i += 1;
      continue;
    }
    return w;
  }
  return null;
}

/**
 * The first word that makes a Shell git commit index-changing (`-a`, `--all`,
 * `-am`, `--include` or a pathspec), or null (#5656 / #6471). The refusal names it.
 */
export function findGitCommitIndexMutatingWord(command: string): string | null {
  for (const { git } of commitInvocations(commandSegments(command))) {
    const word = commitIndexMutatingWord(git);
    if (word !== null) return word;
  }
  return null;
}

/**
 * True when a Shell git commit uses -a/--all/-am/--include or trailing pathspecs
 * that can change the checked file set after the pre-tool index snapshot (#5656).
 */
export function commandHasGitCommitIndexMutatingForm(command: string): boolean {
  return findGitCommitIndexMutatingWord(command) !== null;
}

/** Where a Shell `git commit` lands, as far as the gate can tell (#6278). */
export type CommitTarget =
  /** No `cd` and no `-C`: the hook project root, as before. */
  | { readonly kind: "hook-root" }
  /** A named absolute checkout path (MSYS `/c/…` already mapped on Windows). */
  | { readonly kind: "named"; readonly path: string; readonly shape: "git -C" | "cd" }
  /** The gate cannot resolve one checkout; the caller refuses. */
  | { readonly kind: "unresolvable"; readonly reason: string };

/** The two accepted forms, named in every unresolvable-target refusal (#6278). */
export const COMMIT_TARGET_ACCEPTED_FORMS =
  "Name the checkout by an absolute path in one of two forms: " +
  "`git -C <absolute path> commit …` or `cd <absolute path> && git commit …` " +
  "(one `cd`, joined to the commit by `&&`; " +
  "on Windows a drive path such as `C:\\…` or `C:/…`, or the MSYS form `/c/…`).";

export interface ResolveCommitTargetOptions {
  /** Platform whose absolute-path rules apply; defaults to `process.platform`. */
  readonly platform?: NodeJS.Platform;
}

/**
 * Map a named path to a native absolute path, or null when it is not absolute.
 * On Windows only a drive path or the MSYS drive form counts; the MSYS form maps
 * to its drive path. Elsewhere a path starting with `/` counts.
 */
export function absoluteCommitTargetPath(raw: string, platform: NodeJS.Platform): string | null {
  if (platform !== "win32") return raw.startsWith("/") ? raw : null;
  if (/^[A-Za-z]:[\\/]/.test(raw)) return raw;
  const msys = /^\/([A-Za-z])(?:\/(.*))?$/.exec(raw);
  if (msys === null) return null;
  const drive = (msys[1] ?? "").toUpperCase();
  return `${drive}:\\${(msys[2] ?? "").replace(/\//g, "\\")}`;
}

function namedPath(
  word: ShellWord,
  shape: "git -C" | "cd",
  platform: NodeJS.Platform,
): CommitTarget {
  if (word.expands) {
    return {
      kind: "unresolvable",
      reason: `the ${shape} path ${JSON.stringify(word.value)} holds a variable, \`~\` or substitution`,
    };
  }
  const path = absoluteCommitTargetPath(word.value, platform);
  if (path === null) {
    return {
      kind: "unresolvable",
      reason: `the ${shape} path ${JSON.stringify(word.value)} is not an absolute path`,
    };
  }
  return { kind: "named", path, shape };
}

function isCdSegment(segment: ShellSegment): boolean {
  return commandWords(segment)[0]?.value.toLowerCase() === "cd";
}

function resolveOneCommit(
  segments: readonly ShellSegment[],
  index: number,
  git: GitInvocation,
  platform: NodeJS.Platform,
): CommitTarget {
  if (git.gitDirOrWorkTree) {
    return { kind: "unresolvable", reason: "the commit uses --git-dir or --work-tree" };
  }
  const envOverride = git.envNames.find((name) => GIT_LOCATION_ENV.has(name));
  if (envOverride !== undefined) {
    return { kind: "unresolvable", reason: `the commit carries a ${envOverride}= prefix` };
  }
  const cdIndexes: number[] = [];
  for (let j = 0; j < index; j++) {
    const segment = segments[j];
    if (segment !== undefined && isCdSegment(segment)) cdIndexes.push(j);
  }
  if (cdIndexes.length + git.chdirs.length > 1) {
    return { kind: "unresolvable", reason: "more than one `cd` or `-C` comes before the commit" };
  }
  const chdir = git.chdirs[0];
  if (chdir !== undefined) return namedPath(chdir, "git -C", platform);
  const cdIndex = cdIndexes[0];
  if (cdIndex === undefined) return { kind: "hook-root" };
  const cd = segments[cdIndex];
  // `&&` / `||` lists are left-associative: an `||` right before the `cd` skips
  // it when the earlier command succeeds, and a following `&&` chain still runs
  // the commit in the inherited cwd (`true || cd /x && git commit`).
  if (segments[cdIndex - 1]?.next === "||") {
    return { kind: "unresolvable", reason: "an `||` before the `cd` can skip it" };
  }
  // A command on the right of a pipe runs in a subshell, so a `cd` there moves nothing.
  if (segments[cdIndex - 1]?.next === "|") {
    return { kind: "unresolvable", reason: "a pipe before the `cd` runs it in a subshell" };
  }
  // The commit runs only after the `cd` succeeded when every operator between
  // them is `&&`; with `;` or `||` the commit can run in the inherited cwd.
  for (let j = cdIndex; j < index; j++) {
    if (segments[j]?.next !== "&&") {
      return { kind: "unresolvable", reason: "the `cd` is not joined to the commit by `&&`" };
    }
  }
  const args = cd !== undefined ? withoutRedirections(commandWords(cd).slice(1)) : [];
  const pathWord = args[0];
  if (args.length !== 1 || pathWord === undefined || pathWord.value.startsWith("-")) {
    return { kind: "unresolvable", reason: "the `cd` does not name exactly one path" };
  }
  return namedPath(pathWord, "cd", platform);
}

/**
 * Resolve where a Shell command's `git commit` lands (#6278). Returns null when
 * the command holds no commit. Every commit in the call must resolve to the same
 * target; otherwise the target is unresolvable.
 */
export function resolveCommitTarget(
  command: string,
  options: ResolveCommitTargetOptions = {},
): CommitTarget | null {
  const platform = options.platform ?? process.platform;
  const segments = commandSegments(command);
  const commits = commitInvocations(segments);
  if (commits.length === 0) return null;
  let target: CommitTarget | null = null;
  for (const { index, git } of commits) {
    const next = resolveOneCommit(segments, index, git, platform);
    if (next.kind === "unresolvable") return next;
    if (target === null) {
      target = next;
      continue;
    }
    const same =
      target.kind === next.kind &&
      (target.kind !== "named" || (next.kind === "named" && target.path === next.path));
    if (!same) {
      return { kind: "unresolvable", reason: "the commits in this call name different checkouts" };
    }
  }
  return target;
}
