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
 * A commit signal outside the two named shapes makes the whole call unresolvable
 * (#6362); the gate refuses these forms rather than rebuild a target through them.
 * A variable command word, and a `-c` / `env -S` / `eval` string that holds a
 * variable, is a signal only when the call shows the word `commit` (#6871).
 * It is a guardrail over the commands it reads, not a security boundary.
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
  /** Unquoted parentheses in order (#6362): `(` group, `$` for `$(` `<(` `>(`, `)` close. */
  readonly parens?: string;
  /** Unquoted `(` that start the word, and unquoted `)` that end it (#6362). */
  readonly leadingOpens?: number;
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
  let prevUnquoted = ""; // the last unquoted, unescaped character, for `>&` and `$(`
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
/** A bash array-element assignment, `NAME[subscript]=value` or `NAME[subscript]+=value` (#6871). */
const ARRAY_ELEMENT_ASSIGNMENT = /^[A-Za-z_]\w*\[[^\]]*\]\+?=/;

/**
 * True when the word is an assignment the shell runs before the command word:
 * `NAME=value`, or an array element `NAME[subscript]=value` / `+=value` that
 * holds no `$(` and no backtick (#6871). This is assignment recognition only; it
 * makes no claim that a subscript cannot run code supplied by earlier shell state.
 */
function isAssignmentWord(value: string): boolean {
  if (ENV_ASSIGNMENT.test(value)) return true;
  return ARRAY_ELEMENT_ASSIGNMENT.test(value) && !value.includes("$(") && !value.includes("`");
}

/** The variable an assignment word names, without an array subscript (`GIT_DIR[0]=x` → `GIT_DIR`). */
function assignmentName(value: string): string {
  return /^[A-Za-z_][\w.]*/.exec(value)?.[0] ?? "";
}

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
  while (i < words.length && isAssignmentWord(words[i]?.value ?? "")) {
    envNames.push(assignmentName(words[i]?.value ?? ""));
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
 * The command words of a segment, leading `{` and `(` openers dropped. A brace
 * group runs in the current shell, so its `cd` or commit reads as unwrapped; a
 * `( … )` is unwrapped only to read the command in it (#6362).
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

/** Groups open across one call; `group` is false for a `$(`, `<(` or `>(` substitution. */
type GroupState = {
  readonly stack: { readonly id: number; readonly group: boolean }[];
  lastId: number;
};

/**
 * Track unquoted parentheses in one chunk (#6362). Command chunks share the
 * stack, so a group can span a heredoc. A heredoc body is data apart from its
 * substitutions: it inherits the groups open around it, only parentheses inside
 * its `$( … )` count, and it closes nothing outside it. A stray `)` closes nothing.
 */
function markGroups(
  segments: readonly ShellSegment[],
  state: GroupState,
  body: boolean,
): CommandSegment[] {
  const stack = body ? [...state.stack] : state.stack;
  const base = body ? stack.length : 0;
  return segments.map((segment) => {
    let touchesGroup = false;
    const apply = (event: string): void => {
      if (body && event !== "$" && stack.slice(base).every((open) => open.group)) return;
      if (event === ")") {
        const closed = stack.length > base ? stack.pop() : undefined;
        if (closed === undefined || closed.group) touchesGroup = true;
        return;
      }
      state.lastId += 1;
      stack.push({ id: state.lastId, group: event === "(" });
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
 * Which chunks are unquoted heredoc bodies (#6362): the command chunks, joined by
 * newlines, are the command text alone; the first chunk is one, and two are
 * never next to each other.
 */
function heredocBodyFlags(chunks: readonly string[], commandText: string): boolean[] {
  let next = 0;
  let afterCommand = false;
  return chunks.map((chunk, n) => {
    const end = next + chunk.length;
    const fits =
      commandText.startsWith(chunk, next) && /^(?:\n|$)/.test(commandText.slice(end, end + 1));
    afterCommand = n === 0 || (!afterCommand && fits);
    if (afterCommand) next = end + 1;
    return !afterCommand;
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
  const chunks = shellCommandChunksWithoutQuotedHereDocBodies(command);
  const bodies = heredocBodyFlags(chunks, shellWithoutHereDocBodies(command));
  const groups: GroupState = { stack: [], lastId: 0 };
  return chunks.flatMap((chunk, n) => {
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
    return markGroups(chunkSegments, groups, bodies[n] === true);
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

/** Shells whose `-c` command string the gate reads (#6362). */
const SHELL_BINS = new Set(["sh", "bash", "zsh", "dash", "ksh", "ash", "mksh"]);
/** Commands that run the command after them, each with its options that take the next word. */
const WRAPPER_VALUE_OPTIONS = new Map<string, ReadonlySet<string>>();
for (const row of [
  "env -u -C -P --unset --chdir",
  "command",
  "exec -a",
  "nohup",
  "time -f -o --format --output",
  "timeout -s -k --signal --kill-after",
  "xargs -a -d -E -I -J -L -n -P -R -S -s --arg-file --delimiter --max-args --max-chars --max-procs",
  "nice -n --adjustment",
  "sudo -u -g -C -D -h -p -r -t -T -U -R --user --group --close-from --chdir --host --prompt",
  "sudo --role --type --command-timeout --other-user --chroot",
  "doas -u -C",
  "stdbuf -i -o -e --input --output --error",
  "ionice -c -n -p -P -u --class --classdata --pid --pgid --uid",
]) {
  const [bin = "", ...options] = row.split(" ");
  WRAPPER_VALUE_OPTIONS.set(bin, new Set([...(WRAPPER_VALUE_OPTIONS.get(bin) ?? []), ...options]));
}
const GROUPED_COMMIT = "the commit runs inside a `( … )` subshell group";

/** What one command is (#6362); a wrapped command or a `-c` / `eval` string is read next. */
type CommandReading =
  | { readonly kind: "commit"; readonly git: GitInvocation }
  | {
      readonly kind: "signal";
      readonly reason: string;
      /**
       * True for a variable command word and a `-c`, `env -S` or `eval` string
       * that holds a variable: a signal only when the call shows exact-word `commit` (#6871 / #7273).
       */
      readonly needsCommitWord?: true;
      /**
       * Borrowed lifecycle false-positive (#7273): an expanding non-git command word
       * whose own words do not include exact `commit`. Suppressible when the same call
       * also resolves a named absolute commit target.
       */
      readonly suppressibleWithNamedCommit?: true;
    }
  | { readonly kind: "wrapped"; readonly words: readonly ShellWord[]; readonly name: string }
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

/** The commits in one call and the first commit signal, if any (#6362 / #7273). */
interface CallReading {
  readonly segments: readonly CommandSegment[];
  readonly commits: readonly { readonly index: number; readonly git: GitInvocation }[];
  readonly signal: string | null;
  /** False when every needsCommitWord signal is a suppressible lifecycle false-positive (#7273). */
  readonly opaqueSignal: boolean;
}

/** The program a command word names: base name, lower case, no `.exe`. */
function programName(word: ShellWord): string {
  return /^(?:.*[/\\])?(.*?)(?:\.exe)?$/is.exec(word.value)?.[1]?.toLowerCase() ?? "";
}

/** True when the program name holds a variable (`$GIT`, `` `which git` ``); `$HOME/bin/x` is readable. */
function isUnreadableCommandWord(word: ShellWord): boolean {
  return word.expands && /[$`]/.test(word.value.replace(/^.*[/\\]/, ""));
}

function signal(reason: string): CommandReading {
  return { kind: "signal", reason };
}

/**
 * The refusal for text the gate cannot read (#6362). It applies only when the
 * call shows exact-word `commit` (#6871 / #7273); `readCall` drops it otherwise.
 */
function unreadable(
  subject: string,
  options: { readonly suppressibleWithNamedCommit?: true } = {},
): CommandReading {
  return {
    kind: "signal",
    reason: `${subject} holds a variable or substitution, so the gate cannot tell whether it commits`,
    needsCommitWord: true,
    ...(options.suppressibleWithNamedCommit === true
      ? { suppressibleWithNamedCommit: true as const }
      : {}),
  };
}

/** True when a decoded shell word is exactly `commit` (any case) (#7273). */
function isExactCommitWord(value: string): boolean {
  return value.toLowerCase() === "commit";
}

/** Exact-word `commit` among decoded words (#7273). */
function wordsShowExactCommit(words: readonly ShellWord[]): boolean {
  return words.some((word) => isExactCommitWord(word.value));
}

/** Exact-word `commit` after tokenizing a `-c` / `eval` / `env -S` body (#7273). */
function textShowsExactCommitWord(text: string): boolean {
  return tokenizeShellCommand(text).some((segment) => wordsShowExactCommit(segment.words));
}

/**
 * Bodies of `sh`/`bash`/`zsh`/`pwsh -c`, `eval`, and `env -S` in one command
 * (#7273). Expanding bodies are included so exact-word `commit` inside them still arms.
 */
function executableStringBodies(words: readonly ShellWord[]): string[] {
  let k = 0;
  while (k < words.length && isAssignmentWord(words[k]?.value ?? "")) k++;
  const word = words[k];
  if (word === undefined || isUnreadableCommandWord(word)) return [];
  const name = programName(word);
  if (SHELL_BINS.has(name) || name === "pwsh" || name === "powershell") {
    let hasC = false;
    let i = k + 1;
    while (i < words.length) {
      const current = words[i];
      const v = current?.value ?? "";
      if (current?.redirect !== undefined) {
        i += current.redirect === "operator" ? 2 : 1;
        continue;
      }
      if (v === "--" || v === "-") {
        i += 1;
        break;
      }
      if (v.startsWith("--")) {
        i += v === "--rcfile" || v === "--init-file" ? 2 : 1;
        continue;
      }
      if ((v.startsWith("-") || v.startsWith("+")) && v.length > 1) {
        if (v.startsWith("-") && v.includes("c")) hasC = true;
        i += /[oO]/.test(v.slice(1)) ? 2 : 1;
        continue;
      }
      break;
    }
    if (!hasC) return [];
    const body = words[i];
    return body === undefined ? [] : [withoutTrailingCloses(body)];
  }
  if (name === "eval") {
    const args = withoutRedirections(words.slice(k + 1));
    return args.length === 0 ? [] : [args.map(withoutTrailingCloses).join(" ")];
  }
  if (name === "env") {
    const valueOptions = WRAPPER_VALUE_OPTIONS.get(name);
    let c = k + 1;
    let optionsDone = false;
    while (c < words.length) {
      const current = words[c];
      const v = current?.value ?? "";
      if (current?.redirect !== undefined) {
        c += current.redirect === "operator" ? 2 : 1;
        continue;
      }
      if (!optionsDone && v === "--") {
        optionsDone = true;
        c += 1;
        continue;
      }
      const split = !optionsDone ? /^(?:-[^-uCPS]*S|--split-string=?)(.*)$/s.exec(v) : null;
      if (split !== null) {
        const own = split[1] ? current : words[c + 1];
        return own === undefined ? [] : [split[1] || own.value];
      }
      if (!optionsDone && v.startsWith("-") && v.length > 1) {
        const at = v.startsWith("--")
          ? -1
          : [...v].findIndex((l, i) => i > 0 && valueOptions?.has(`-${l}`));
        c += valueOptions?.has(v) || at === v.length - 1 ? 2 : 1;
        continue;
      }
      break;
    }
  }
  return [];
}

/**
 * True when the call shows exact-word `commit` (any case) among decoded shell
 * words, including inside `sh`/`bash`/`zsh`/`pwsh -c`, `eval`, and `env -S`
 * payloads (#6871 / #7273). Pathspecs, filenames, and data/here-string bodies
 * do not count (all heredoc bodies are stripped for this detector). Line
 * continuations are joined. A command supplied wholly by variables set earlier
 * is not read (content/docs/hook-root-admission.md).
 */
function callShowsCommitWord(command: string): boolean {
  const joined = shellWithoutHereDocBodies(command).replace(/\\\r?\n/g, "");
  return tokenizeShellCommand(joined).some((segment) => {
    const words = commandWords(segment);
    if (wordsShowExactCommit(words)) return true;
    return executableStringBodies(words).some((body) => textShowsExactCommitWord(body));
  });
}

/** A `-c`, `env -S` or `eval` string: a literal one is read next, any other is refused. */
function commandString(word: ShellWord, what: string): CommandReading {
  return word.expands
    ? unreadable(what)
    : { kind: "string", text: withoutTrailingCloses(word), what };
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
  return body === undefined ? signal(`${what} is missing`) : commandString(body, what);
}

/** `eval …` and `env -S …`: the words joined by spaces are read as one command string (#6362). */
function joinedString(args: readonly ShellWord[], what: string): CommandReading {
  if (args.length === 0) return null;
  const text = args.map(withoutTrailingCloses).join(" ");
  return commandString({ value: text, expands: args.some((arg) => arg.expands) }, what);
}

/**
 * `env`, `xargs`, `timeout 60` and the like (#6362): the wrapped command is the
 * first word after the wrapper's own options and their values, `timeout`'s
 * duration and any number. Only that command is read, not its arguments.
 */
function readWrapper(words: readonly ShellWord[], k: number, name: string): CommandReading {
  const valueOptions = WRAPPER_VALUE_OPTIONS.get(name);
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
    // `env -S` splits only its own string into words; the words after it are added
    // as they are, less the shell's redirections, so the wrapped command is both.
    const split =
      name === "env" && !optionsDone ? /^(?:-[^-uCPS]*S|--split-string=?)(.*)$/s.exec(v) : null;
    if (split !== null) {
      const own = split[1] ? word : words[c + 1];
      if (own === undefined) return null;
      if (own.expands) return unreadable("an `env -S` string");
      const parts = tokenizeShellCommand(split[1] || own.value).flatMap((part) => part.words);
      const rest = withoutRedirections(words.slice(split[1] ? c + 1 : c + 2));
      return { kind: "wrapped", words: [...parts, ...rest], name };
    }
    if (!optionsDone && v.startsWith("-") && v.length > 1) {
      // `command -v` / `-V` only describe the command.
      if (name === "command" && /^-[^-]*[vV]/.test(v)) return null;
      // In a short cluster the first value-taking letter takes the rest, or the next word.
      const at = v.startsWith("--")
        ? -1
        : [...v].findIndex((l, i) => i > 0 && valueOptions?.has(`-${l}`));
      c += valueOptions?.has(v) || at === v.length - 1 ? 2 : 1;
      continue;
    }
    // A number is an option value or `timeout`'s duration, not the program.
    if (skipOperand || /^\d+(?:\.\d+)?[smhd]?$/.test(v)) {
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
  return wrapped === undefined ? null : { kind: "wrapped", words: words.slice(c), name };
}

/** Read one command's words (after `{` / `(` openers) for a commit or a commit signal (#6362). */
function readCommand(words: readonly ShellWord[]): CommandReading {
  let k = 0;
  while (k < words.length && isAssignmentWord(words[k]?.value ?? "")) k++;
  const word = words[k];
  if (word === undefined) return null;
  if (isUnreadableCommandWord(word)) {
    // Independently commit-shaped when this command's own words include exact `commit` (#7273).
    return unreadable(`the command word ${JSON.stringify(word.value)}`, {
      ...(wordsShowExactCommit(words) ? {} : { suppressibleWithNamedCommit: true as const }),
    });
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
  if (name === "eval") return joinedString(withoutRedirections(words.slice(k + 1)), "an `eval`");
  if (WRAPPER_VALUE_OPTIONS.has(name)) return readWrapper(words, k, name);
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
 * Read a call: its commits and the first commit signal (#6362). Wrappers, `-c`
 * strings, `eval` and unreadable words are read from the command text alone, so
 * heredoc body text raises no signal (#6187). Each command read next is shorter
 * than the one that held it, so the work list runs out without a depth limit.
 */
function readCall(command: string): CallReading {
  const segments = commandSegments(command);
  const commits = recognizedCommits(segments);
  let found: string | null = commits.some(({ index }) => segments[index]?.grouped)
    ? GROUPED_COMMIT
    : null;
  let opaqueSignal = found !== null;
  const pending: PendingCommand[] = commandTextWords(command).map((words) => ({
    words,
    asCommit: null,
    prefix: "",
  }));
  let showsCommit: boolean | null = null;
  // Keep scanning after suppressible lifecycle signals so an opaque signal later still wins (#7273).
  for (let i = 0; i < pending.length; i++) {
    if (opaqueSignal) break;
    const item = pending[i];
    const reading = item === undefined ? null : readCommand(item.words);
    if (item === undefined || reading === null) continue;
    if (reading.kind === "signal") {
      if (reading.needsCommitWord === true) {
        showsCommit ??= callShowsCommitWord(command);
        if (!showsCommit) continue;
      }
      const reason = `${item.prefix}${reading.reason}`;
      const suppressible =
        reading.needsCommitWord === true && reading.suppressibleWithNamedCommit === true;
      found ??= reason;
      if (!suppressible) {
        found = reason;
        opaqueSignal = true;
      }
    } else if (reading.kind === "commit") {
      if (item.asCommit !== null) {
        found = item.asCommit;
        opaqueSignal = true;
      }
    } else if (reading.kind === "wrapped") {
      const asCommit = `${item.prefix}the commit runs behind the \`${reading.name}\` wrapper`;
      pending.push({ words: reading.words, asCommit, prefix: item.prefix });
    } else {
      // The gate does not rebuild a target inside a `-c` or `eval` string.
      const asCommit = `${item.prefix}${reading.what} runs a git commit`;
      if (recognizedCommits(commandSegments(reading.text)).length > 0) {
        found = asCommit;
        opaqueSignal = true;
        continue;
      }
      const prefix = `${item.prefix}in ${reading.what}, `;
      for (const words of commandTextWords(reading.text)) pending.push({ words, asCommit, prefix });
    }
  }
  return { segments, commits, signal: found, opaqueSignal };
}

/**
 * True when the commit gate treats the command as a commit: a recognized `git
 * commit` or a commit signal (#5656 / #6362). Forms it does not read are not
 * caught later: the git pre-commit hook runs only `verify:encoding`.
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

/** The accepted forms, named in every unresolvable-target refusal (#6278 / #7273). */
export const COMMIT_TARGET_ACCEPTED_FORMS =
  "Name the checkout by an absolute path in one of two forms: " +
  "`git -C <absolute path> commit …` (enough even when an earlier statement is a separate `cd`) " +
  "or `cd <absolute path> && git commit …` (one `cd`, joined to the commit by `&&`; " +
  "on Windows a drive path such as `C:\\…` or `C:/…`, or the MSYS form `/c/…`). " +
  "Exact-word `commit` (including inside `sh`/`bash`/`zsh`/`pwsh -c`, `eval`, and `env -S` payloads) " +
  "arms the variable-command signal; a lifecycle `$BIN` beside a later named absolute commit is admitted, " +
  "but opaque commit-shaped wrappers (`$GIT commit`, expanding `-c`/`eval` payloads) stay refused.";

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

/** A `cd` moves the commit only while its groups are still open (`(cd /x) && git commit`, #6362). */
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
  // One absolute `git -C` is the sole chdir authority; ignore prior reaching `cd` (#7273).
  if (git.chdirs.length > 1) {
    return { kind: "unresolvable", reason: "more than one `cd` or `-C` comes before the commit" };
  }
  const chdir = git.chdirs[0];
  if (chdir !== undefined) return namedPath(chdir, "git -C", platform);
  if (cdIndexes.length > 1) {
    return { kind: "unresolvable", reason: "more than one `cd` or `-C` comes before the commit" };
  }
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
 * the command holds no commit and no commit signal. An opaque signal anywhere in
 * the call makes it unresolvable, whatever visible commit comes before or after
 * it (#6362). A suppressible lifecycle needsCommitWord signal alone is dropped
 * when every recognized commit resolves to the same named absolute target (#7273).
 * Every commit must resolve to the same target, or it is unresolvable.
 */
export function resolveCommitTarget(
  command: string,
  options: ResolveCommitTargetOptions = {},
): CommitTarget | null {
  const platform = options.platform ?? process.platform;
  const { segments, commits, signal: found, opaqueSignal } = readCall(command);
  // Opaque signals still win over any visible commit (#6362).
  if (opaqueSignal && found !== null) {
    return { kind: "unresolvable", reason: found };
  }
  if (commits.length === 0) {
    if (found !== null) return { kind: "unresolvable", reason: found };
    return null;
  }
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
  if (found !== null) {
    // Limb 3 (#7273): borrowed lifecycle `$BIN` + named absolute commit → named.
    if (!opaqueSignal && target?.kind === "named") return target;
    return { kind: "unresolvable", reason: found };
  }
  return target;
}
