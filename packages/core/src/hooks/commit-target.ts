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
 *
 * A lone `&` ends a segment. A commit signal outside the two named shapes makes
 * the whole call unresolvable (#6362): a commit inside a `( … )` subshell group,
 * a commit or a non-literal string in a `sh -c` / `bash -c` body or an `eval`, a
 * wrapper such as `env` or `xargs` around a commit, and a command word or git
 * subcommand that holds a variable. The gate does not rebuild a target through
 * these forms; it refuses them. This is a guardrail over the commands it can
 * read, not a security boundary.
 */

import {
  shellCommandChunksWithoutQuotedHereDocBodies,
  shellWithoutHereDocBodies,
} from "../authz/classify.js";

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
  /**
   * The unquoted, unescaped parentheses in the word, in order (#6362): `(` opens
   * a `( … )` group, `$` opens a `$(`, `<(` or `>(` substitution, `)` closes.
   */
  readonly parens?: string;
  /** How many unquoted `(` start the word, before any other character (#6362). */
  readonly leadingOpens?: number;
  /** How many unquoted `)` end the word (#6362). */
  readonly trailingCloses?: number;
}

/** Operator that ends a segment (`null` for the last segment). */
export type ShellSegmentSeparator = "&&" | "||" | "|" | "&" | ";" | "\n" | null;

export interface ShellSegment {
  readonly words: readonly ShellWord[];
  readonly next: ShellSegmentSeparator;
}

/** Characters an unquoted backslash escapes; other backslashes stay literal (Windows paths). */
const UNQUOTED_ESCAPABLE = new Set(" \t\"'\\$`;&|<>()");
/** Characters a backslash escapes inside double quotes (POSIX). */
const DOUBLE_QUOTED_ESCAPABLE = new Set(['"', "\\", "$", "`"]);

/**
 * Split a shell command into `&&` / `||` / `|` / `&` / `;` / newline segments of
 * words. Quotes are honoured for both splitting and word values; a quoted path
 * with spaces stays one word and Windows backslashes are not rewritten. A lone
 * `&` ends a segment (#6362); `&>`, `>&`, `<&`, `2>&1` and `|&` stay attached to
 * their redirection or pipe.
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
  // Parenthesis bookkeeping for the word (#6362); see ShellWord.
  let parens = "";
  let leadingOpens = 0;
  let onlyOpens = true;
  let trailingCloses = 0;
  // The last character the unquoted path added to the word, so `>&` / `$(` are
  // read only when both characters are unquoted and unescaped.
  let prevUnquoted = "";
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
      words.push({
        ...word,
        ...redirection,
        ...(parens === "" ? {} : { parens }),
        ...(leadingOpens === 0 ? {} : { leadingOpens }),
        ...(trailingCloses === 0 ? {} : { trailingCloses }),
      });
    }
    cur = "";
    started = false;
    expands = false;
    literalPrefix = false;
    redirect = false;
    parens = "";
    leadingOpens = 0;
    onlyOpens = true;
    trailingCloses = 0;
    prevUnquoted = "";
  };
  // A quoted or escaped character ends the leading `(` run and any trailing `)` run.
  const literalChar = (): void => {
    onlyOpens = false;
    trailingCloses = 0;
    prevUnquoted = "";
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
      literalChar();
      continue;
    }
    if (ch === "\\" && UNQUOTED_ESCAPABLE.has(nextCh)) {
      cur += nextCh;
      started = true;
      literalPrefix = true;
      literalChar();
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
      prevUnquoted = ch;
      continue;
    }
    if (ch === "|") {
      endSegment("|");
      if (nextCh === "&") i += 1;
      continue;
    }
    // A lone `&` runs the command before it in the background and ends the
    // segment (#6362). It stays in the word after an unquoted `>` / `<` (`2>&1`,
    // `>&2`, `<&3`) and before `>` (`&>`, `&>>`).
    if (ch === "&" && nextCh !== ">" && prevUnquoted !== ">" && prevUnquoted !== "<") {
      endSegment("&");
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
    if (ch === "(") {
      // `$(`, `<(` and `>(` open a substitution; any other `(` opens a group.
      const substitution = prevUnquoted === "$" || prevUnquoted === "<" || prevUnquoted === ">";
      parens += substitution ? "$" : "(";
      if (onlyOpens && !substitution) leadingOpens += 1;
    } else {
      onlyOpens = false;
    }
    if (ch === ")") parens += ")";
    trailingCloses = ch === ")" ? trailingCloses + 1 : 0;
    prevUnquoted = ch;
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
  /** True when the subcommand word holds a variable or substitution (#6362). */
  readonly subcommandExpands: boolean;
  /** Index of the first word after the subcommand. */
  readonly argsStart: number;
  readonly words: readonly ShellWord[];
}

/** The word value without the unquoted `)` that close a group after it (`commit)`). */
function withoutTrailingCloses(word: ShellWord): string {
  const closes = word.trailingCloses ?? 0;
  return closes === 0 ? word.value : word.value.slice(0, -closes);
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
    const word = words[i];
    return {
      envNames,
      chdirs,
      gitDirOrWorkTree,
      subcommand: (word === undefined ? w : withoutTrailingCloses(word)).toLowerCase(),
      subcommandExpands: word?.expands ?? false,
      argsStart: i + 1,
      words,
    };
  }
  return {
    envNames,
    chdirs,
    gitDirOrWorkTree,
    subcommand: null,
    subcommandExpands: false,
    argsStart: i,
    words,
  };
}

/** True when the word is only unquoted `(` group openers. */
function isGroupOpenWord(word: ShellWord): boolean {
  const opens = word.leadingOpens ?? 0;
  return opens > 0 && opens === word.value.length;
}

/**
 * The command words of a segment: leading `{` brace-group openers and `(`
 * subshell openers dropped. A brace group runs in the current shell, so a `cd`
 * or commit inside it is read like one outside it (`{ cd /x; } && git commit`
 * is a `cd` joined by `;`). A `( … )` subshell is unwrapped only to read the
 * command inside it; a commit inside one is refused, and its `cd` does not move
 * a later commit (#6362).
 */
function commandWords(segment: ShellSegment): readonly ShellWord[] {
  const words = segment.words;
  let start = 0;
  for (;;) {
    const word = words[start];
    if (word === undefined || (word.value !== "{" && !isGroupOpenWord(word))) break;
    start++;
  }
  const first = words[start];
  const opens = first?.leadingOpens ?? 0;
  if (first === undefined || opens === 0) return start === 0 ? words : words.slice(start);
  const stripped: ShellWord = { value: first.value.slice(opens), expands: first.expands };
  return [stripped, ...words.slice(start + 1)];
}

/** A segment with the groups it runs in (#6362). */
interface CommandSegment extends ShellSegment {
  /** Ids of the groups and substitutions open at its command word, outermost first. */
  readonly groups: readonly number[];
  /** True when its command runs in a `( … )` group, or the segment opens or closes one. */
  readonly grouped: boolean;
}

/**
 * Track unquoted parentheses across the segments of one call (#6362). The stack
 * carries across heredoc chunks: a group can span a heredoc, and unquoted body
 * text is read as commands (#6187). An unmatched `)` closes nothing. `group` is
 * false for a `$( … )`, `<( … )` or `>( … )` substitution.
 */
function markGroups(segments: readonly ShellSegment[]): CommandSegment[] {
  const stack: { readonly id: number; readonly group: boolean }[] = [];
  let lastId = 0;
  return segments.map((segment) => {
    let touchesGroup = false;
    const apply = (event: string): void => {
      if (event === ")") {
        const closed = stack.pop();
        if (closed === undefined || closed.group) touchesGroup = true;
        return;
      }
      lastId += 1;
      stack.push({ id: lastId, group: event === "(" });
      if (event === "(") touchesGroup = true;
    };
    // The command word is the first word after `{` and `(` openers; its own
    // leading `(` are applied before the command is read.
    const words = segment.words;
    let w = 0;
    while (w < words.length) {
      const word = words[w];
      if (word === undefined || (word.value !== "{" && !isGroupOpenWord(word))) break;
      for (const event of word.parens ?? "") apply(event);
      w++;
    }
    const command = words[w];
    const leading = command?.leadingOpens ?? 0;
    const events = command?.parens ?? "";
    for (const event of events.slice(0, leading)) apply(event);
    const groups = stack.map((open) => open.id);
    const inGroup = stack.some((open) => open.group);
    for (const event of events.slice(leading)) apply(event);
    for (const word of words.slice(w + 1)) {
      for (const event of word.parens ?? "") apply(event);
    }
    return { ...segment, groups, grouped: inGroup || touchesGroup };
  });
}

/**
 * Segments of the commands the shell runs: quoted heredoc bodies removed, and
 * each unquoted body tokenized apart from the commands around it (#6187).
 */
function commandSegments(command: string): CommandSegment[] {
  // A dangling `||` or `|` at the end of a chunk is still pending after the
  // heredoc body, so it is carried to the end of the next chunk (#6471).
  let pending: ShellSegmentSeparator = null;
  const segments = shellCommandChunksWithoutQuotedHereDocBodies(command).flatMap((chunk) => {
    const chunkSegments = tokenizeShellCommand(chunk);
    // The end of a chunk is a heredoc boundary, not an `&&` join: a dangling
    // `&&` must not tie a `cd` here to a commit after the delimiter.
    const last = chunkSegments[chunkSegments.length - 1];
    if (last !== undefined) {
      const open = last.next === "||" || last.next === "|" ? last.next : null;
      const next = open ?? pending ?? (last.next === ";" ? ";" : "\n");
      chunkSegments[chunkSegments.length - 1] = { words: last.words, next };
      pending = open;
    }
    return chunkSegments;
  });
  return markGroups(segments);
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

/** Shells whose `-c` command string the gate reads (#6362). */
const SHELL_BINS = new Set(["sh", "bash", "zsh", "dash", "ksh", "ash", "mksh"]);
/** Commands that run the command written after them (#6362). */
const WRAPPER_BINS = new Set(
  "env command exec nohup time timeout xargs nice sudo doas stdbuf ionice".split(" "),
);
/** Wrapper options whose value is the next word, so it is not read as the wrapped command. */
const WRAPPER_VALUE_OPTIONS = new Set(
  (
    "-a -C -c -D -d -E -e -f -g -h -I -i -k -L -n -o -P -p -r -S -s -T -t -U -u --adjustment " +
    "--arg-file --chdir --delimiter --error --group --input --kill-after --max-args " +
    "--max-lines --max-procs --output --replace --signal --split-string --unset --user"
  ).split(" "),
);
const GROUPED_COMMIT = "the commit runs inside a `( … )` subshell group";

/** What one command is, as far as the commit gate reads it (#6362). */
type CommandReading =
  | { readonly kind: "commit"; readonly git: GitInvocation }
  | { readonly kind: "signal"; readonly reason: string }
  /** A wrapper: the wrapped command is read next. */
  | { readonly kind: "wrapped"; readonly words: readonly ShellWord[]; readonly name: string }
  /** A `-c` or `eval` string: it is read next as a command list. */
  | { readonly kind: "string"; readonly text: string; readonly what: string }
  | null;

/** A command still to read, and how to report what it holds (#6362). */
interface PendingCommand {
  readonly words: readonly ShellWord[];
  /** The refusal when the command is a commit; null at the top level, where commits resolve. */
  readonly asCommit: string | null;
  /** Put before a signal found in it (`in a \`bash -c\` string, `). */
  readonly prefix: string;
}

/** The commits in one call and the first commit signal, if any (#6362). */
interface CallReading {
  readonly segments: readonly CommandSegment[];
  readonly commits: readonly { readonly index: number; readonly git: GitInvocation }[];
  readonly signal: string | null;
}

/** The program a command word names: base name, lower case, no `.exe`. */
function programName(word: ShellWord): string {
  return word.value
    .replace(/^.*[/\\]/, "")
    .toLowerCase()
    .replace(/\.exe$/, "");
}

/**
 * True when the program a command word names holds a variable or substitution
 * (`$GIT`, `"$CMD"`, `` `which git` ``). A variable only in the directory part
 * (`$HOME/bin/tool`) still names the program.
 */
function isUnreadableCommandWord(word: ShellWord): boolean {
  return word.expands && /[$`]/.test(word.value.replace(/^.*[/\\]/, ""));
}

function signal(reason: string): CommandReading {
  return { kind: "signal", reason };
}

/** `sh -c '…'` and the like: the first operand after options holding `c` (#6362). */
function readShellCommand(words: readonly ShellWord[], k: number, name: string): CommandReading {
  let hasC = false;
  let i = k + 1;
  while (i < words.length) {
    const word = words[i];
    const v = word?.value ?? "";
    if (word?.redirect !== undefined) {
      i += word.redirect === "operator" ? 2 : 1;
      continue;
    }
    if (v === "--" || v === "-") {
      i += 1;
      break;
    }
    if (v.startsWith("--")) {
      // `--rcfile` / `--init-file` take a file as the next word.
      i += v === "--rcfile" || v === "--init-file" ? 2 : 1;
      continue;
    }
    if ((v.startsWith("-") || v.startsWith("+")) && v.length > 1) {
      if (v.startsWith("-") && v.includes("c")) hasC = true;
      // `-o` / `-O` take an option name as the next word (`bash -o pipefail -c …`).
      i += /[oO]/.test(v.slice(1)) ? 2 : 1;
      continue;
    }
    break;
  }
  if (!hasC) return null;
  const what = `a \`${name} -c\` string`;
  const body = words[i];
  if (body === undefined) return signal(`${what} is missing`);
  if (body.expands) {
    return signal(
      `${what} holds a variable or substitution, so the gate cannot tell whether it commits`,
    );
  }
  return { kind: "string", text: withoutTrailingCloses(body), what };
}

/** `eval …`: the arguments joined by spaces are read as a command string (#6362). */
function readEval(words: readonly ShellWord[], k: number): CommandReading {
  const args = withoutRedirections(words.slice(k + 1));
  if (args.length === 0) return null;
  if (args.some((arg) => arg.expands)) {
    return signal(
      "an `eval` argument holds a variable or substitution, so the gate cannot tell whether it commits",
    );
  }
  return { kind: "string", text: args.map(withoutTrailingCloses).join(" "), what: "an `eval`" };
}

/** `env`, `xargs`, `timeout 60` and the like around a command (#6362). */
function readWrapper(words: readonly ShellWord[], k: number, name: string): CommandReading {
  // The wrapped command: the first word after options, option values and, for
  // `timeout`, the duration.
  let c = k + 1;
  let optionsDone = false;
  let skipOperand = name === "timeout";
  while (c < words.length) {
    const word = words[c];
    const v = word?.value ?? "";
    if (word?.redirect !== undefined) {
      c += word.redirect === "operator" ? 2 : 1;
      continue;
    }
    if (!optionsDone && v === "--") {
      optionsDone = true;
      c += 1;
      continue;
    }
    if (!optionsDone && v.startsWith("-") && v.length > 1) {
      c += WRAPPER_VALUE_OPTIONS.has(v) ? 2 : 1;
      continue;
    }
    if (skipOperand) {
      skipOperand = false;
      c += 1;
      continue;
    }
    break;
  }
  const wrapped = words[c];
  if (
    name === "xargs" &&
    wrapped !== undefined &&
    programName(wrapped) === "git" &&
    parseGitInvocation(words.slice(c))?.subcommand === null
  ) {
    return signal("`xargs` runs git with arguments from its input");
  }
  // An option value read as the command can hide a later `git … commit`.
  for (let j = k + 1; j < words.length; j++) {
    const word = words[j];
    if (j === c || word === undefined || programName(word) !== "git") continue;
    if (parseGitInvocation(words.slice(j))?.subcommand === "commit") {
      return signal(`the commit runs behind the \`${name}\` wrapper`);
    }
  }
  return wrapped === undefined ? null : { kind: "wrapped", words: words.slice(c), name };
}

/** Read one command's words (after `{` / `(` openers) for a commit or a commit signal (#6362). */
function readCommand(words: readonly ShellWord[]): CommandReading {
  let k = 0;
  while (k < words.length && ENV_ASSIGNMENT.test(words[k]?.value ?? "")) k++;
  const word = words[k];
  if (word === undefined) return null;
  if (isUnreadableCommandWord(word)) {
    return signal(
      `the command word ${JSON.stringify(word.value)} holds a variable or substitution, ` +
        "so the gate cannot tell whether it commits",
    );
  }
  const name = programName(word);
  if (name === "git") {
    const git = parseGitInvocation(words);
    if (git === null) return null;
    if (git.subcommandExpands) {
      const sub = git.words[git.argsStart - 1]?.value ?? "";
      return signal(`the git subcommand ${JSON.stringify(sub)} holds a variable or substitution`);
    }
    return git.subcommand === "commit" ? { kind: "commit", git } : null;
  }
  if (SHELL_BINS.has(name)) return readShellCommand(words, k, name);
  if (name === "eval") return readEval(words, k);
  if (WRAPPER_BINS.has(name)) return readWrapper(words, k, name);
  return null;
}

/** The recognized commits in a command list, from every chunk the shell runs or expands. */
function recognizedCommits(
  segments: readonly CommandSegment[],
): { index: number; git: GitInvocation }[] {
  const commits: { index: number; git: GitInvocation }[] = [];
  segments.forEach((segment, index) => {
    const git = parseGitInvocation(commandWords(segment));
    if (git !== null && git.subcommand === "commit") commits.push({ index, git });
  });
  return commits;
}

/** The command words of a list's command text, heredoc bodies removed (#6187). */
function commandTextWords(command: string): (readonly ShellWord[])[] {
  return tokenizeShellCommand(shellWithoutHereDocBodies(command)).map(commandWords);
}

/**
 * Read a call: its commits and the first commit signal (#6362). A commit inside
 * a `( … )` group is a signal. Wrappers, `-c` strings, `eval` and unreadable
 * command words are read from the command text alone: a heredoc body is data
 * apart from the commits it shows (#6187), so its text raises no signal. Each
 * command read next is shorter than the one that held it, so the work list
 * runs out without a depth limit.
 */
function readCall(command: string): CallReading {
  const segments = commandSegments(command);
  const commits = recognizedCommits(segments);
  let found: string | null = commits.some(({ index }) => segments[index]?.grouped)
    ? GROUPED_COMMIT
    : null;
  const pending: PendingCommand[] = commandTextWords(command).map((words) => ({
    words,
    asCommit: null,
    prefix: "",
  }));
  for (let i = 0; i < pending.length && found === null; i++) {
    const item = pending[i];
    const reading = item === undefined ? null : readCommand(item.words);
    if (item === undefined || reading === null) continue;
    if (reading.kind === "signal") {
      found = `${item.prefix}${reading.reason}`;
    } else if (reading.kind === "commit") {
      found = item.asCommit;
    } else if (reading.kind === "wrapped") {
      const asCommit = `${item.prefix}the commit runs behind the \`${reading.name}\` wrapper`;
      pending.push({ words: reading.words, asCommit, prefix: item.prefix });
    } else {
      // The gate does not rebuild a target inside a `-c` or `eval` string.
      const asCommit = `${item.prefix}${reading.what} runs a git commit`;
      if (recognizedCommits(commandSegments(reading.text)).length > 0) {
        found = asCommit;
        continue;
      }
      const prefix = `${item.prefix}in ${reading.what}, `;
      for (const words of commandTextWords(reading.text)) pending.push({ words, asCommit, prefix });
    }
  }
  return { segments, commits, signal: found };
}

/**
 * True when the commit gate treats the command as a commit (#5656 / #6362): it
 * holds a recognized `git commit`, or a commit signal the gate refuses. Forms the
 * gate does not read at all (`if … then git commit`, `pushd`, other git verbs
 * that create commits) are not caught later either: the git pre-commit hook runs
 * only `verify:encoding`.
 */
export function commandHasGitCommitSubcommand(command: string): boolean {
  return resolveCommitTarget(command) !== null;
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
  for (const { git } of readCall(command).commits) {
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

/**
 * True when a `cd` can move the commit: every group open at the `cd` is still
 * open at the commit. A `cd` in a `( … )` that closed first moves nothing
 * (`(cd /x) && git commit`, #6362).
 */
function cdReachesCommit(cd: CommandSegment, commit: CommandSegment): boolean {
  return cd.groups.every((id, depth) => commit.groups[depth] === id);
}

function resolveOneCommit(
  segments: readonly CommandSegment[],
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
  const commit = segments[index];
  const cdIndexes: number[] = [];
  for (let j = 0; j < index; j++) {
    const segment = segments[j];
    if (
      segment !== undefined &&
      commit !== undefined &&
      isCdSegment(segment) &&
      cdReachesCommit(segment, commit)
    ) {
      cdIndexes.push(j);
    }
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
 * the command holds no commit and no commit signal. A signal anywhere in the
 * call makes it unresolvable, whatever visible commit comes before or after it
 * (#6362). Every commit must resolve to the same target, or it is unresolvable.
 */
export function resolveCommitTarget(
  command: string,
  options: ResolveCommitTargetOptions = {},
): CommitTarget | null {
  const platform = options.platform ?? process.platform;
  const { segments, commits, signal: found } = readCall(command);
  if (found !== null) return { kind: "unresolvable", reason: found };
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
