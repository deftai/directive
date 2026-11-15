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
 */

/** One shell word after quote removal. */
export interface ShellWord {
  readonly value: string;
  /** True when the word holds `$`, a backtick or a leading `~` outside single quotes. */
  readonly expands: boolean;
}

/** Operator that ends a segment (`null` for the last segment). */
export type ShellSegmentSeparator = "&&" | "||" | ";" | "\n" | null;

export interface ShellSegment {
  readonly words: readonly ShellWord[];
  readonly next: ShellSegmentSeparator;
}

/** Characters an unquoted backslash escapes; other backslashes stay literal (Windows paths). */
const UNQUOTED_ESCAPABLE = new Set([" ", "\t", '"', "'", "\\", "$", "`", ";", "&", "|"]);
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
  const flushWord = (): void => {
    if (started) words.push({ value: cur, expands });
    cur = "";
    started = false;
    expands = false;
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
      continue;
    }
    if (ch === "\\" && UNQUOTED_ESCAPABLE.has(nextCh)) {
      cur += nextCh;
      started = true;
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
    if ((ch === "&" || ch === "|") && nextCh === ch) {
      endSegment(ch === "&" ? "&&" : "||");
      i += 1;
      continue;
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
  return commitInvocations(tokenizeShellCommand(command)).length > 0;
}

/** Commit options whose value is the next word (so it is not read as a pathspec). */
const COMMIT_VALUE_OPTIONS = new Set([
  "-m",
  "-F",
  "--message",
  "--file",
  "--author",
  "--date",
  "-c",
  "-C",
  "--reuse-message",
  "--reedit-message",
  "--fix",
  "--cleanup",
  "--untracked-files",
]);

function commitArgsMutateIndex(git: GitInvocation): boolean {
  const words = git.words;
  let i = git.argsStart;
  while (i < words.length) {
    const w = words[i]?.value ?? "";
    if (w === "--") return i + 1 < words.length;
    if (w === "-a" || w === "--all" || w === "-i" || w === "--include" || w === "-am") return true;
    if (w.startsWith("--message=") || w.startsWith("--file=") || w.startsWith("--author=")) {
      i += 1;
      continue;
    }
    if (COMMIT_VALUE_OPTIONS.has(w)) {
      i += 2;
      continue;
    }
    // Attached value-taking shorts (-mMSG / -Ffile / -cSHA / -CSHA) before the
    // combined-flag scan so letters inside the value are not read as -a/-i
    // (#5656 Greptile: `git commit -m"fix parser"` / `-Fmessage.txt`).
    if (w.startsWith("-") && !w.startsWith("--") && /^[mFcC].+/.test(w.slice(1))) {
      i += 1;
      continue;
    }
    if (w.startsWith("-") && !w.startsWith("--") && /[ai]/.test(w.slice(1))) return true;
    if (w.startsWith("-")) {
      i += 1;
      continue;
    }
    return true;
  }
  return false;
}

/**
 * True when a Shell git commit uses -a/--all/-am/--include or trailing pathspecs
 * that can change the checked file set after the pre-tool index snapshot (#5656).
 */
export function commandHasGitCommitIndexMutatingForm(command: string): boolean {
  return commitInvocations(tokenizeShellCommand(command)).some(({ git }) =>
    commitArgsMutateIndex(git),
  );
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
  // The commit runs only after the `cd` succeeded when every operator between
  // them is `&&`; with `;` or `||` the commit can run in the inherited cwd.
  for (let j = cdIndex; j < index; j++) {
    if (segments[j]?.next !== "&&") {
      return { kind: "unresolvable", reason: "the `cd` is not joined to the commit by `&&`" };
    }
  }
  const args = cd !== undefined ? commandWords(cd).slice(1) : [];
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
  const segments = tokenizeShellCommand(command);
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
