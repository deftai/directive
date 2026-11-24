import { describe, expect, it } from "vitest";
import {
  absoluteCommitTargetPath,
  COMMIT_TARGET_ACCEPTED_FORMS,
  commandHasGitCommitIndexMutatingForm,
  commandHasGitCommitSubcommand,
  findGitCommitIndexMutatingWord,
  resolveCommitTarget,
  splitShellArgvPreservingQuotes,
  tokenizeShellCommand,
} from "./commit-target.js";

const posix = { platform: "linux" as const };
const win = { platform: "win32" as const };
const GROUPED = "the commit runs inside a `( … )` subshell group";

function words(command: string): string[][] {
  return tokenizeShellCommand(command).map((segment) => segment.words.map((w) => w.value));
}

describe("tokenizeShellCommand (#6278)", () => {
  it("splits on && / || / ; / newline outside quotes only", () => {
    expect(words('cd "/a b" && git commit -m "x; y && z"')).toEqual([
      ["cd", "/a b"],
      ["git", "commit", "-m", "x; y && z"],
    ]);
    const segments = tokenizeShellCommand("a || b; c\nd");
    expect(segments.map((s) => s.next)).toEqual(["||", ";", "\n", null]);
  });

  it("keeps Windows backslashes, quoted or not", () => {
    expect(words("cd C:\\Repos\\wt && git commit")[0]).toEqual(["cd", "C:\\Repos\\wt"]);
    expect(words('cd "C:\\Repos\\my wt" && git commit')[0]).toEqual(["cd", "C:\\Repos\\my wt"]);
    expect(words("cd 'C:\\Repos\\wt'")[0]).toEqual(["cd", "C:\\Repos\\wt"]);
  });

  it("honours POSIX escapes and keeps empty quoted words", () => {
    expect(words('git commit -m "say \\"hi\\"" -m ""')[0]).toEqual([
      "git",
      "commit",
      "-m",
      'say "hi"',
      "-m",
      "",
    ]);
    expect(words("cd /a\\ b")[0]).toEqual(["cd", "/a b"]);
  });

  it("marks variables, substitutions and a leading ~ outside single quotes", () => {
    const flags = (command: string) =>
      tokenizeShellCommand(command)[0]?.words.map((w) => w.expands) ?? [];
    expect(flags("cd $WT")).toEqual([false, true]);
    expect(flags('cd "$(pwd)/x"')).toEqual([false, true]);
    expect(flags("cd `pwd`")).toEqual([false, true]);
    expect(flags("cd ~/wt")).toEqual([false, true]);
    expect(flags("cd '$WT'")).toEqual([false, false]);
    expect(flags("cd /a~b")).toEqual([false, false]);
  });

  it("drops empty segments but keeps the operator before them", () => {
    const segments = tokenizeShellCommand("cd /a &&\ngit commit -m x;");
    expect(segments.map((s) => s.words.map((w) => w.value))).toEqual([
      ["cd", "/a"],
      ["git", "commit", "-m", "x"],
    ]);
    expect(segments[0]?.next).toBe("&&");
  });

  it("splitShellArgvPreservingQuotes flattens the same words (#5656)", () => {
    expect(splitShellArgvPreservingQuotes('git commit -m "" -a')).toEqual([
      "git",
      "commit",
      "-m",
      "",
      "-a",
    ]);
  });
});

describe("commit recognition and index-mutating forms share the tokenizer (#6278)", () => {
  it("recognizes commits behind env prefixes, globals, quotes and compounds", () => {
    expect(commandHasGitCommitSubcommand("GIT_EDITOR=true git -C /tmp/r commit -F msg")).toBe(true);
    expect(commandHasGitCommitSubcommand('cd "/a b" && git commit -m x')).toBe(true);
    expect(commandHasGitCommitSubcommand('"C:\\Program Files\\Git\\bin\\git.exe" commit')).toBe(
      true,
    );
    expect(commandHasGitCommitSubcommand("git status || git commit -m x")).toBe(true);
    expect(commandHasGitCommitSubcommand('echo "git commit"')).toBe(false);
    expect(commandHasGitCommitSubcommand("git -c")).toBe(false);
    expect(commandHasGitCommitSubcommand("")).toBe(false);
  });

  it("reads quoted and unquoted forms of the same path the same way", () => {
    for (const command of [
      'cd "/c/wt" && git commit -F "/c/msg.txt"',
      "cd /c/wt && git commit -F /c/msg.txt",
      "git -C '/c/wt' commit -F /c/msg.txt",
    ]) {
      expect(commandHasGitCommitIndexMutatingForm(command)).toBe(false);
    }
  });

  it("flags -a / --include / pathspecs and ignores letters inside attached values", () => {
    expect(commandHasGitCommitIndexMutatingForm("git commit -am msg")).toBe(true);
    expect(commandHasGitCommitIndexMutatingForm("git commit -a -m msg")).toBe(true);
    expect(commandHasGitCommitIndexMutatingForm("git commit --include -m msg")).toBe(true);
    expect(commandHasGitCommitIndexMutatingForm("git commit -sa -m msg")).toBe(true);
    expect(commandHasGitCommitIndexMutatingForm("git commit -m msg -- src/a.ts")).toBe(true);
    expect(commandHasGitCommitIndexMutatingForm("git commit -m msg --")).toBe(false);
    expect(commandHasGitCommitIndexMutatingForm("git commit -m msg src/a.ts")).toBe(true);
    expect(commandHasGitCommitIndexMutatingForm('git commit -m"fix parser"')).toBe(false);
    expect(commandHasGitCommitIndexMutatingForm("git commit -Fmessage.txt")).toBe(false);
    expect(commandHasGitCommitIndexMutatingForm("git commit --message=all --no-verify")).toBe(
      false,
    );
    expect(commandHasGitCommitIndexMutatingForm("git commit -s -m msg")).toBe(false);
    expect(commandHasGitCommitIndexMutatingForm("git status -a")).toBe(false);
  });
});

describe("absoluteCommitTargetPath (#6278)", () => {
  it("maps the MSYS drive form to its drive path on Windows", () => {
    expect(absoluteCommitTargetPath("/c/Repos/wt", "win32")).toBe("C:\\Repos\\wt");
    expect(absoluteCommitTargetPath("/d", "win32")).toBe("D:\\");
    expect(absoluteCommitTargetPath("C:\\Repos\\wt", "win32")).toBe("C:\\Repos\\wt");
    expect(absoluteCommitTargetPath("C:/Repos/wt", "win32")).toBe("C:/Repos/wt");
  });

  it("refuses non-drive paths on Windows and relative paths everywhere", () => {
    expect(absoluteCommitTargetPath("/tmp/wt", "win32")).toBeNull();
    expect(absoluteCommitTargetPath("\\\\server\\share", "win32")).toBeNull();
    expect(absoluteCommitTargetPath("wt", "win32")).toBeNull();
    expect(absoluteCommitTargetPath(".", "linux")).toBeNull();
    expect(absoluteCommitTargetPath("/c/wt", "linux")).toBe("/c/wt");
  });
});

describe("resolveCommitTarget (#6278)", () => {
  it("returns null for a command with no commit", () => {
    expect(resolveCommitTarget("git status && cd /x", posix)).toBeNull();
  });

  it("keeps the hook project root for a commit with no cd and no -C", () => {
    expect(resolveCommitTarget("git add a && git commit -m x", posix)).toEqual({
      kind: "hook-root",
    });
    expect(resolveCommitTarget("git commit -m x && cd /after", posix)).toEqual({
      kind: "hook-root",
    });
  });

  it("names the checkout for git -C and a cd joined by &&", () => {
    expect(resolveCommitTarget("git -C /r/wt commit -m x", posix)).toEqual({
      kind: "named",
      path: "/r/wt",
      shape: "git -C",
    });
    // One absolute -C wins over a prior reaching cd, same or different path (#7273).
    expect(resolveCommitTarget("cd /r/wt; git -C /r/wt commit -m x", posix)).toEqual({
      kind: "named",
      path: "/r/wt",
      shape: "git -C",
    });
    expect(resolveCommitTarget("cd /a && git -C /b commit -m x", posix)).toEqual({
      kind: "named",
      path: "/b",
      shape: "git -C",
    });
    expect(resolveCommitTarget("cd /a; git -C /b commit -m x", posix)).toEqual({
      kind: "named",
      path: "/b",
      shape: "git -C",
    });
    expect(resolveCommitTarget('cd "/r/my wt" && git add a && git commit -m x', posix)).toEqual({
      kind: "named",
      path: "/r/my wt",
      shape: "cd",
    });
    expect(resolveCommitTarget("git status && cd /r/wt && git commit -m x", posix)).toEqual({
      kind: "named",
      path: "/r/wt",
      shape: "cd",
    });
    // A brace group runs in the current shell: its `cd` and commit read as unwrapped.
    expect(resolveCommitTarget("cd /r/wt && { git commit -m x; }", posix)).toMatchObject({
      kind: "named",
      path: "/r/wt",
    });
    expect(resolveCommitTarget("{ cd /r/wt && git commit -m x; }", posix)).toMatchObject({
      kind: "named",
      path: "/r/wt",
    });
    // A subshell `cd` does not move a later commit.
    expect(resolveCommitTarget("(cd /r/wt) && git commit -m x", posix)).toEqual({
      kind: "hook-root",
    });
    // `;` before the `cd` cannot skip it.
    expect(resolveCommitTarget("false; cd /r/wt && git commit -m x", posix)).toMatchObject({
      kind: "named",
      path: "/r/wt",
    });
  });

  it("maps the MSYS and drive forms to the same drive path on Windows", () => {
    const msys = resolveCommitTarget("cd /c/r/wt && git commit -F /c/m", win);
    const quoted = resolveCommitTarget('cd "C:\\r\\wt" && git commit -F "C:\\m"', win);
    const dashC = resolveCommitTarget("git -C 'C:\\r\\wt' commit -F m", win);
    expect(msys).toMatchObject({ kind: "named", path: "C:\\r\\wt" });
    expect(quoted).toMatchObject({ kind: "named", path: "C:\\r\\wt" });
    expect(dashC).toMatchObject({ kind: "named", path: "C:\\r\\wt" });
  });

  it.each([
    ["git -C . commit -m x", /not an absolute path/],
    ["cd wt && git commit -m x", /not an absolute path/],
    ["cd /a && cd /b && git commit -m x", /more than one/],
    ["git -C /a -C b commit -m x", /more than one/],
    ["cd $WT && git commit -m x", /variable/],
    ["git -C ~/wt commit -m x", /variable/],
    ['cd "$(git rev-parse --show-toplevel)" && git commit -m x', /variable/],
    ["git --git-dir=/r/.git commit -m x", /--git-dir or --work-tree/],
    ["git --work-tree /r commit -m x", /--git-dir or --work-tree/],
    ["GIT_DIR=/r/.git git commit -m x", /GIT_DIR=/],
    ["GIT_WORK_TREE=/r git commit -m x", /GIT_WORK_TREE=/],
    ["GIT_INDEX_FILE=/tmp/i git commit -m x", /GIT_INDEX_FILE=/],
    ["GIT_COMMON_DIR=/r/.git git commit -m x", /GIT_COMMON_DIR=/],
    ["cd /a; git commit -m x", /not joined to the commit/],
    ["cd /a || git commit -m x", /not joined to the commit/],
    ["true || cd /a && git commit -m x", /`\|\|` before the `cd`/],
    ["git status && true || cd /a && git commit -m x", /`\|\|` before the `cd`/],
    ["{ cd /a; } && git commit -m x", /not joined to the commit/],
    ["{ cd /a && true; } && git commit -m x", /not joined to the commit/],
    ["{ { cd /a; }; } && git commit -m x", /not joined to the commit/],
    ["true || { cd /a && git commit -m x; }", /`\|\|` before the `cd`/],
    ["cd /a | cat && git commit -m x", /not joined to the commit/],
    ["cd && git commit -m x", /exactly one path/],
    ["cd -P /a && git commit -m x", /exactly one path/],
    ["git -C", null],
    ["git -C /a commit -m x && git commit -m y", /different checkouts/],
  ])("refuses %s as unresolvable", (command, reason) => {
    const target = resolveCommitTarget(command, posix);
    if (reason === null) {
      expect(target).toBeNull();
      return;
    }
    expect(target).toMatchObject({ kind: "unresolvable" });
    if (target?.kind === "unresolvable") expect(target.reason).toMatch(reason);
  });

  it("refuses a POSIX root path on Windows but accepts it elsewhere", () => {
    expect(resolveCommitTarget("git -C /tmp/wt commit -m x", win)).toMatchObject({
      kind: "unresolvable",
    });
    expect(resolveCommitTarget("git -C /tmp/wt commit -m x", posix)).toMatchObject({
      kind: "named",
    });
  });

  it("accepts two commits that name the same checkout", () => {
    expect(
      resolveCommitTarget("git -C /a commit -m x && git -C /a commit --amend -m y", posix),
    ).toMatchObject({ kind: "named", path: "/a" });
    expect(resolveCommitTarget("git commit -m x; git commit -m y", posix)).toEqual({
      kind: "hook-root",
    });
  });

  it("defaults to the host platform and names both absolute forms", () => {
    expect(resolveCommitTarget("git commit -m x")).toEqual({ kind: "hook-root" });
    expect(COMMIT_TARGET_ACCEPTED_FORMS).toContain("git -C <absolute path> commit");
    expect(COMMIT_TARGET_ACCEPTED_FORMS).toContain("cd <absolute path> && git commit");
  });
});

describe("quoted heredoc bodies are data to every commit detector (#6187)", () => {
  // The issue repro: a note whose body names a compound commit with a file
  // message and trailing prose, which used to read as an index-mutating commit.
  const body = "- the hook refuses `cd <wt> && git commit -F <file>`; a standalone commit works";
  const quotedNote = `cat >> /tmp/notes.md <<'NOTE'\n${body}\nNOTE`;
  const tabNote = `cat >> /tmp/notes.md <<-'NOTE'\n\t${body}\n\tNOTE`;

  it("does not read a quoted-delimiter note that names a commit as a commit", () => {
    for (const note of [
      quotedNote,
      tabNote,
      `cat >> /tmp/notes.md <<"NOTE"\n${body}\nNOTE`,
      `cat >> /tmp/notes.md <<\\NOTE\n${body}\nNOTE`,
      `cat >> /tmp/notes.md <<N'OTE'\n${body}\nNOTE`,
    ]) {
      expect(commandHasGitCommitSubcommand(note)).toBe(false);
      expect(commandHasGitCommitIndexMutatingForm(note)).toBe(false);
      expect(resolveCommitTarget(note, posix)).toBeNull();
    }
  });

  it("keeps an unquoted heredoc body visible (operator ruling)", () => {
    const plain = "cat >> /tmp/notes.md <<NOTE\ngit commit -am msg\nNOTE";
    expect(commandHasGitCommitSubcommand(plain)).toBe(true);
    expect(commandHasGitCommitIndexMutatingForm(plain)).toBe(true);
    for (const nested of [
      "cat <<EOF\n$(\ngit commit -am msg\n)\nEOF",
      'cat <<EOF\n$(\ngit com""mit -am msg\n)\nEOF',
    ]) {
      expect(commandHasGitCommitSubcommand(nested)).toBe(true);
      expect(commandHasGitCommitIndexMutatingForm(nested)).toBe(true);
      expect(resolveCommitTarget(nested, posix)).toEqual({ kind: "hook-root" });
    }
    // A quoted heredoc after an unquoted one is still data; a commit after it is seen.
    const later = "cat <<A\nx\nA\ncat <<'B'\ngit commit -am msg\nB";
    expect(commandHasGitCommitSubcommand(later)).toBe(false);
    expect(commandHasGitCommitIndexMutatingForm(`${later}\ngit commit -am msg`)).toBe(true);
    // An unclosed unquoted body stays visible to the end of the text.
    expect(commandHasGitCommitIndexMutatingForm("cat <<EOF\ngit commit -am msg")).toBe(true);
    // A continued commit after an unquoted heredoc is one command.
    const continued = "cat <<EOF\nmessage\nEOF\ngit \\\n  commit -am msg";
    expect(commandHasGitCommitSubcommand(continued)).toBe(true);
    expect(commandHasGitCommitIndexMutatingForm(continued)).toBe(true);
    expect(resolveCommitTarget(continued, posix)).toEqual({ kind: "hook-root" });
  });

  it("strips a quoted body before an unquoted heredoc and keeps the unquoted body", () => {
    const mixed = `${quotedNote}\ncat <<EOF\n$(\ngit commit -am msg\n)\nEOF`;
    expect(commandHasGitCommitIndexMutatingForm(mixed)).toBe(true);
    expect(commandHasGitCommitIndexMutatingForm(`${quotedNote}\ncat <<EOF\nok\nEOF`)).toBe(false);
  });

  it("does not let a quote in an unquoted body swallow the commands after it", () => {
    const command = "cat <<EOF\n$(printf x)\n'\nEOF\ngit commit -am msg";
    expect(commandHasGitCommitSubcommand(command)).toBe(true);
    expect(commandHasGitCommitIndexMutatingForm(command)).toBe(true);
    expect(resolveCommitTarget(command, posix)).toEqual({ kind: "hook-root" });
    const doubleQuote = 'cat <<EOF\n"\nEOF\ncd /c/wt && git commit -F /c/msg.txt';
    expect(resolveCommitTarget(doubleQuote, posix)).toEqual({
      kind: "named",
      path: "/c/wt",
      shape: "cd",
    });
  });

  it("keeps a real compound commit with a file message", () => {
    const command = "cd /c/wt && git commit -F /c/msg.txt";
    expect(commandHasGitCommitSubcommand(command)).toBe(true);
    expect(commandHasGitCommitIndexMutatingForm(command)).toBe(false);
    expect(resolveCommitTarget(command, posix)).toEqual({
      kind: "named",
      path: "/c/wt",
      shape: "cd",
    });
  });

  it("still flags -am and trailing pathspecs, also after a heredoc that closes", () => {
    expect(commandHasGitCommitIndexMutatingForm("git commit -am msg")).toBe(true);
    expect(commandHasGitCommitIndexMutatingForm("git commit -m msg -- src/a.ts")).toBe(true);
    const after = `${quotedNote}\ngit commit -am msg`;
    expect(commandHasGitCommitSubcommand(after)).toBe(true);
    expect(commandHasGitCommitIndexMutatingForm(after)).toBe(true);
  });

  it("keeps commands on the heredoc opener line and resolves a commit after the body", () => {
    const opener = `cat > /tmp/m.txt <<'EOF' && git commit -F /tmp/m.txt\n${body}\nEOF`;
    expect(commandHasGitCommitSubcommand(opener)).toBe(true);
    expect(commandHasGitCommitIndexMutatingForm(opener)).toBe(false);
    const cdAfter = `cat > /tmp/m.txt <<'EOF'\n${body}\nEOF\ncd /c/wt && git commit -F /tmp/m.txt`;
    expect(resolveCommitTarget(cdAfter, posix)).toEqual({
      kind: "named",
      path: "/c/wt",
      shape: "cd",
    });
  });

  it("strips a heredoc whose opener is line-continued (shared authz chain)", () => {
    const continued = `cat >> /tmp/notes.md \\\n  <<'NOTE'\n${body}\nNOTE`;
    expect(commandHasGitCommitSubcommand(continued)).toBe(false);
    expect(commandHasGitCommitIndexMutatingForm(continued)).toBe(false);
    expect(commandHasGitCommitSubcommand("git commit \\\n  -m msg")).toBe(true);
  });

  it("treats a substitution in a quoted body as data", () => {
    const quoted = "cat <<'EOF'\n$(\ngit commit -am msg\n)\nEOF";
    expect(commandHasGitCommitSubcommand(quoted)).toBe(false);
    expect(resolveCommitTarget(quoted, posix)).toBeNull();
  });

  it("closes a quoted heredoc whose last body line ends in a backslash", () => {
    const command = "cat <<'EOF'\nline \\\nEOF\ngit commit -am msg";
    expect(commandHasGitCommitSubcommand(command)).toBe(true);
    expect(commandHasGitCommitIndexMutatingForm(command)).toBe(true);
    // A quoted body is read as written, so E\ + OF is not the delimiter and the
    // commit line is still body text of the unclosed heredoc.
    expect(commandHasGitCommitSubcommand("cat <<'EOF'\nE\\\nOF\ngit commit -am msg")).toBe(false);
  });

  it("leaves text after an unclosed heredoc opener dropped, as authz does", () => {
    const unclosed = `cat >> /tmp/notes.md <<'NOTE'\n${body}\ngit commit -am msg`;
    expect(commandHasGitCommitSubcommand(unclosed)).toBe(false);
    expect(commandHasGitCommitIndexMutatingForm(unclosed)).toBe(false);
  });

  it("keeps here-strings and arithmetic shifts as ordinary text", () => {
    expect(commandHasGitCommitSubcommand("cat <<< note && git commit -m x")).toBe(true);
    expect(commandHasGitCommitSubcommand("echo $((1 << 2)) && git commit -m x")).toBe(true);
  });
});

describe("pipes, redirections and short clusters in a commit (#6471)", () => {
  it("splits a lone pipe and |& as a separator that is not &&", () => {
    expect(tokenizeShellCommand("a | b |& c || d").map((s) => s.next)).toEqual([
      "|",
      "|",
      "||",
      null,
    ]);
    expect(words("echo >|f b")).toEqual([["echo", ">|f", "b"]]);
  });

  it("marks only unquoted unescaped redirections", () => {
    const flags = (command: string): (string | undefined)[] =>
      (tokenizeShellCommand(command)[0]?.words ?? []).map((w) => w.redirect);
    expect(flags("x 2>&1 > f >|g &>h <(p) *>q \\>r '>s' 2'>'t '2'>u")).toEqual([
      undefined,
      "attached",
      "operator",
      undefined,
      "attached",
      "attached",
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
    ]);
  });

  it.each([
    "git -C /wt commit -m msg 2>&1 | tail -3",
    "cd /wt && git commit -F /tmp/m.txt 2>&1 | tail -3",
    "git commit -qm msg",
    "git commit -m msg >/dev/null",
    "git commit -m msg > /dev/null 2>&1",
    "git commit -m msg 2>&1",
    "git commit -m msg &> out.log",
    "git commit -m msg < /dev/null",
    "git commit -m msg >| out",
    "git commit -F - <<'EOF'\nmessage body\nEOF",
    "git commit -sm msg",
    "git commit -m msg -- 2>&1",
    "git commit -m msg |& tee log",
    "git commit -m msg 2>&1 || echo failed",
  ])("does not read %j as index-changing", (command) => {
    expect(commandHasGitCommitIndexMutatingForm(command)).toBe(false);
    expect(findGitCommitIndexMutatingWord(command)).toBeNull();
  });

  it.each([
    ["git commit -a -m msg", "-a"],
    ["git commit -am msg", "-am"],
    ["git commit -qam msg", "-qam"],
    ["git commit -m msg src/a.ts", "src/a.ts"],
    ["git commit -m msg -- src/a.ts", "src/a.ts"],
    ["git commit -m msg -- 2>&1 src/a.ts", "src/a.ts"],
    ["git commit -m msg 2>&1 src/a.ts", "src/a.ts"],
    ["git commit -m msg > out src/a.ts", "src/a.ts"],
    ["git commit -tm src/a.ts", "src/a.ts"],
    ["git commit -um src/a.ts", "src/a.ts"],
    ["git commit -Sm src/a.ts", "src/a.ts"],
    ["git commit -m msg \\>src/a.ts", ">src/a.ts"],
    ["git commit -m msg *>src/a.ts", "*>src/a.ts"],
    ["git commit -m msg *> src/a.ts", "*>"],
    ["git commit -m msg '<(printf src/a.ts)'", "<(printf src/a.ts)"],
    ["git commit -m msg <(printf src/a.ts)", "<(printf"],
    ["git commit -m msg '|'", "|"],
    ["git commit -m msg >'>' -a", "-a"],
    ["git commit -m msg 2>\\> src/a.ts", "src/a.ts"],
    ["git commit -m msg '>x'", ">x"],
    ["git commit --all -m msg", "--all"],
    ["git commit --include -m msg", "--include"],
    ["git commit -i -m msg", "-i"],
    ["git commit -m msg 2>&1 | tail -3 && git commit -am x", "-am"],
  ])("reads %j as index-changing at %j", (command, word) => {
    expect(findGitCommitIndexMutatingWord(command)).toBe(word);
    expect(commandHasGitCommitIndexMutatingForm(command)).toBe(true);
  });

  it("reads git's short-cluster rules", () => {
    // `m` takes the rest of the cluster, so the `a` after it is message text.
    expect(findGitCommitIndexMutatingWord("git commit -mam")).toBeNull();
    // A trailing value letter takes the next word.
    expect(findGitCommitIndexMutatingWord("git commit -sm a")).toBeNull();
    expect(findGitCommitIndexMutatingWord("git commit -s -S -m msg")).toBeNull();
    expect(findGitCommitIndexMutatingWord("git commit -Sa")).toBeNull();
    expect(findGitCommitIndexMutatingWord("git commit -sam msg")).toBe("-sam");
    expect(findGitCommitIndexMutatingWord("git commit -")).toBeNull();
    expect(findGitCommitIndexMutatingWord("git status -a")).toBeNull();
  });

  it("resolves a target through a pipe on the commit's right", () => {
    expect(resolveCommitTarget("git -C /wt commit -m x 2>&1 | tail -3", posix)).toMatchObject({
      kind: "named",
      path: "/wt",
    });
    expect(
      resolveCommitTarget("cd /wt && git commit -F /tmp/m.txt 2>&1 | tail -3", posix),
    ).toMatchObject({ kind: "named", path: "/wt", shape: "cd" });
    expect(resolveCommitTarget("cd /wt 2>/dev/null && git commit -m x", posix)).toMatchObject({
      kind: "named",
      path: "/wt",
    });
  });

  it.each([
    ["true | cd /x && git commit -m msg", /pipe before the `cd`/],
    ["true |& cd /x && git commit -m msg", /pipe before the `cd`/],
    ["true || cd /x && git commit -m msg", /`\|\|` before the `cd`/],
    ["cd /x | git commit -m msg", /not joined/],
    ["cd /x && true | git commit -m msg", /not joined/],
  ])("keeps %j unresolvable", (command, reason) => {
    const target = resolveCommitTarget(command, posix);
    expect(target).toMatchObject({ kind: "unresolvable" });
    if (target?.kind === "unresolvable") expect(target.reason).toMatch(reason);
  });

  it("reads each heredoc chunk as one ordered list with a non-&& boundary", () => {
    // `cd` in one chunk, commit after the delimiter: the shell commits in the
    // cd's directory only through a join the chunk end does not give.
    expect(
      resolveCommitTarget("cd /wt <<EOF\nnote $(x)\nEOF\ngit commit -m msg", posix),
    ).toMatchObject({ kind: "unresolvable" });
    // The commit rides the same line as the heredoc opener, so the join holds.
    expect(resolveCommitTarget("cd /wt <<EOF && git commit -m msg\nnote $(x)\nEOF", posix)).toEqual(
      { kind: "named", path: "/wt", shape: "cd" },
    );
    // A dangling `||` or `|` carried across the chunk boundary stays an `||` / pipe.
    for (const open of ["||", "|"]) {
      const command = `true <<EOF ${open}\nnote $(x)\nEOF\ncd /x && git commit -m msg`;
      expect(resolveCommitTarget(command, posix)).toMatchObject({ kind: "unresolvable" });
    }
    // A dangling `&&` before the heredoc does not tie the `cd` to a later commit.
    expect(
      resolveCommitTarget("cd /wt && <<EOF\nnote $(x)\nEOF\ngit commit -m msg", posix),
    ).toMatchObject({ kind: "unresolvable" });
  });

  it("refuses a commit after an unquoted body with an open quote", () => {
    expect(findGitCommitIndexMutatingWord("cat <<EOF\n'\nEOF\ngit commit -a")).toBe("-a");
  });
});

describe("a lone & ends a segment (#6362 clause 1)", () => {
  it("splits on a lone & and keeps &>, >&, <&, 2>&1 and |& attached", () => {
    const segments = tokenizeShellCommand("a & b 2>&1 >&2 <&3 &>x &>>y >&- |& c&d");
    expect(segments.map((s) => s.words.map((w) => w.value))).toEqual([
      ["a"],
      ["b", "2>&1", ">&2", "<&3", "&>x", "&>>y", ">&-"],
      ["c"],
      ["d"],
    ]);
    expect(segments.map((s) => s.next)).toEqual(["&", "|", "&", null]);
    expect(tokenizeShellCommand("a && b").map((s) => s.next)).toEqual(["&&", null]);
  });

  it("does not split a quoted or escaped &, or an & after a quoted >", () => {
    expect(words("echo 'a & b' \"c & d\" e\\&f")).toEqual([["echo", "a & b", "c & d", "e&f"]]);
    expect(words("echo '>'& git status")).toEqual([
      ["echo", ">"],
      ["git", "status"],
    ]);
    expect(words("echo \\>& git status")).toEqual([
      ["echo", ">"],
      ["git", "status"],
    ]);
  });

  it("drops the empty segment after a trailing &", () => {
    const segments = tokenizeShellCommand("nohup node server.js &");
    expect(segments).toHaveLength(1);
    expect(segments[0]?.next).toBe("&");
  });

  it("no longer reads a trailing & as a pathspec, and keeps redirections working", () => {
    expect(findGitCommitIndexMutatingWord("git commit -m x &")).toBeNull();
    expect(resolveCommitTarget("git commit -m x &", posix)).toEqual({ kind: "hook-root" });
    for (const command of [
      "git commit -m msg &> out.log",
      "git commit -m msg >&2",
      "git commit -m msg 2>&1 | tail -3",
      "git commit -m msg |& tee log",
    ]) {
      expect(findGitCommitIndexMutatingWord(command), command).toBeNull();
      expect(resolveCommitTarget(command, posix), command).toEqual({ kind: "hook-root" });
    }
    expect(resolveCommitTarget("git -C /wt commit -F /m 2>&1 | tail -5", posix)).toMatchObject({
      kind: "named",
      path: "/wt",
    });
  });

  it("refuses a cd backgrounded before the commit, and reads an & before the cd like ;", () => {
    for (const command of [
      "cd /x & git commit -m x",
      "cd /x && git commit -m a & git commit -m b",
    ]) {
      const target = resolveCommitTarget(command, posix);
      expect(target, command).toMatchObject({ kind: "unresolvable" });
      if (target?.kind === "unresolvable") expect(target.reason).toMatch(/not joined/);
    }
    expect(resolveCommitTarget("true & cd /x && git commit -m x", posix)).toEqual({
      kind: "named",
      path: "/x",
      shape: "cd",
    });
  });
});

describe("commit signals outside the named shapes are unresolvable (#6362 clauses 2-3)", () => {
  it("records unquoted parentheses only", () => {
    const word = (command: string, n = 0) => tokenizeShellCommand(command)[0]?.words[n];
    expect(word("((git")).toMatchObject({ value: "((git", parens: "((", leadingOpens: 2 });
    expect(word("x)")).toMatchObject({ value: "x)", parens: ")", trailingCloses: 1 });
    expect(word("$(a")).toMatchObject({ parens: "$" });
    expect(word("<(a")).toMatchObject({ parens: "$" });
    expect(word("fix(x)")).toMatchObject({ parens: "()", trailingCloses: 1 });
    expect(word("fix(x)")?.leadingOpens).toBeUndefined();
    for (const quoted of ["'(git'", '"(git"', "\\(git", "'x)'"]) {
      expect(word(quoted), quoted).not.toHaveProperty("parens");
      expect(word(quoted), quoted).not.toHaveProperty("leadingOpens");
      expect(word(quoted), quoted).not.toHaveProperty("trailingCloses");
    }
  });

  it.each([
    ["(cd /x && git commit -m x)", /subshell group/],
    ["cd /y && (cd /x && git commit -m x)", /subshell group/],
    ["cd /x && (git commit -m x)", /subshell group/],
    ["cd /x && ( git commit -m x )", /subshell group/],
    ["(cd /x && git commit -m x && true)", /subshell group/],
    ["(cd /x\ngit commit -m x\n)", /subshell group/],
    ["{ (cd /x && git commit -m x); }", /subshell group/],
    ["(git commit -am x)", /subshell group/],
    ["git commit -m x)", /subshell group/],
  ])("refuses the grouped commit %j", (command, reason) => {
    const target = resolveCommitTarget(command, posix);
    expect(target).toMatchObject({ kind: "unresolvable" });
    if (target?.kind === "unresolvable") expect(target.reason).toMatch(reason);
    expect(commandHasGitCommitSubcommand(command)).toBe(true);
  });

  it.each([
    ["bash -c 'git commit -m x'", /`bash -c` string runs a git commit/],
    ["sh -c 'git commit -m x'", /`sh -c` string runs a git commit/],
    ["cd /y && bash -c 'git commit -m x'", /`bash -c` string runs a git commit/],
    ["sh -c 'git -C /x commit -m x'", /`sh -c` string runs a git commit/],
    ['bash -lc "cd /x && git commit -m y"', /`bash -c` string runs a git commit/],
    ["bash -o pipefail -c 'git commit -m x'", /`bash -c` string runs a git commit/],
    ["/bin/zsh --norc -c 'git commit -m x'", /`zsh -c` string runs a git commit/],
    ["bash -c 'sh -c \"git commit -m x\"'", /in a `bash -c` string, a `sh -c` string runs/],
    ["(bash -c 'git commit -m x')", /`bash -c` string runs a git commit/],
    ['sh -c "$CMD commit"', /`sh -c` string holds a variable/],
    ['bash -c "echo $HOME; git commit -m x"', /`bash -c` string holds a variable/],
    ["sh -c", /`sh -c` string is missing/],
    ["sh -c '$CMD commit -m x'", /in a `sh -c` string, the command word "\$CMD"/],
    ["eval 'git commit -m x'", /`eval` runs a git commit/],
    ["eval git commit -m x", /`eval` runs a git commit/],
    ['eval "$X commit"', /`eval` holds a variable/],
    ["command -p bash -c 'git commit -m x'", /`bash -c` string runs a git commit/],
    ["env -i bash -c 'git commit -m x'", /`bash -c` string runs a git commit/],
    ["env -S 'git commit -m x'", /behind the `env` wrapper/],
    ["env --split-string 'git -C /x commit -m y'", /behind the `env` wrapper/],
    ['env -S "$X commit"', /`env -S` string holds a variable/],
    ["env -S git commit -m x", /behind the `env` wrapper/],
    ["env -Sgit commit -m x", /behind the `env` wrapper/],
    ["env --split-string=git commit -m x", /behind the `env` wrapper/],
    ["env -S 'sh -c' 'git commit -m x'", /`sh -c` string runs a git commit/],
    ["env -S git >/tmp/commit.log commit -m x", /behind the `env` wrapper/],
    ["env -S git 2> /tmp/err commit -m x", /behind the `env` wrapper/],
    ["xargs --max-chars 100 git commit -m x", /behind the `xargs` wrapper/],
    ["xargs --max-procs=4 -L 1 git commit -m x", /behind the `xargs` wrapper/],
    ["sudo --other-user bob git commit -m x", /behind the `sudo` wrapper/],
    ["timeout --kill-after 5 10s git commit -m x", /behind the `timeout` wrapper/],
    ["ionice -c 2 -n 7 git commit -m x", /behind the `ionice` wrapper/],
    ["sudo -Eu bob git commit -m x", /behind the `sudo` wrapper/],
    ["sudo -ubob git commit -m x", /behind the `sudo` wrapper/],
    ["env -iS 'git commit -m x'", /behind the `env` wrapper/],
    ["env git commit -m x", /behind the `env` wrapper/],
    ["env -C /x git commit -m x", /behind the `env` wrapper/],
    ["command git commit -m x", /behind the `command` wrapper/],
    ["exec git commit -m x", /behind the `exec` wrapper/],
    ["nohup git commit -m x &", /behind the `nohup` wrapper/],
    ["time git commit -m x", /behind the `time` wrapper/],
    ["timeout 60 git commit -m x", /behind the `timeout` wrapper/],
    ["xargs -I {} git -C {} commit -m x", /behind the `xargs` wrapper/],
    ["sudo -u bob git commit -m x", /behind the `sudo` wrapper/],
    ["nice -n 5 git commit -m x", /behind the `nice` wrapper/],
    ["command -p git commit -m x", /behind the `command` wrapper/],
    ["env FOO=1 bash -c 'git commit -m x'", /`bash -c` string runs a git commit/],
    ["timeout 5 $CMD commit -m x", /command word "\$CMD"/],
    ["xargs git", /`xargs` runs git with arguments/],
    ["G=git; $G commit -m x", /command word "\$G"/],
    ['"$GIT" commit -m x', /command word "\$GIT"/],
    ["`which git` commit -m x", /command word "`which"/],
    ["git $SUB -m x", /git subcommand "\$SUB"/],
  ])("refuses %j as a commit signal", (command, reason) => {
    const target = resolveCommitTarget(command, posix);
    expect(target).toMatchObject({ kind: "unresolvable" });
    if (target?.kind === "unresolvable") expect(target.reason).toMatch(reason);
    expect(commandHasGitCommitSubcommand(command)).toBe(true);
  });

  it("lets a signal win over a visible commit before or after it", () => {
    for (const command of [
      'sh -c "$CMD" && git commit -m x',
      'git commit -m x && sh -c "$CMD"',
      'git -C /x commit -m x && sh -c "$CMD"',
      'cd /x && git commit -m x; eval "$X"',
      "(git commit -m a) && git -C /x commit -m b",
      "git -C /x commit -m b && env git commit -m a",
    ]) {
      expect(resolveCommitTarget(command, posix), command).toMatchObject({ kind: "unresolvable" });
    }
  });

  it("reads deeply nested wrappers, eval and -c strings without a depth limit", () => {
    const wrapped = `${"env ".repeat(500)}git commit -m x`;
    expect(resolveCommitTarget(wrapped, posix)).toMatchObject({
      kind: "unresolvable",
      reason: expect.stringMatching(/behind the `env` wrapper/),
    });
    const evals = `${"eval ".repeat(200)}git commit -m x`;
    expect(resolveCommitTarget(evals, posix)).toMatchObject({
      kind: "unresolvable",
      reason: expect.stringMatching(/^(in an `eval`, )+an `eval` runs a git commit$/),
    });
    expect(resolveCommitTarget(`${"eval ".repeat(200)}npm test`, posix)).toBeNull();
    expect(
      resolveCommitTarget("bash -c \"sh -c 'env timeout 5 git commit -m x'\"", posix),
    ).toMatchObject({
      kind: "unresolvable",
      reason:
        "in a `bash -c` string, in a `sh -c` string, the commit runs behind the `timeout` wrapper",
    });
  });

  it("never falls back to the hook root or an outer named path", () => {
    for (const command of [
      "(cd /x && git commit -m x)",
      "cd /y && (cd /x && git commit -m x)",
      "cd /y && bash -c 'git commit -m x'",
    ]) {
      const target = resolveCommitTarget(command, posix);
      expect(target?.kind, command).toBe("unresolvable");
    }
  });
});

describe("controls that stay as they were (#6362 clause 4)", () => {
  it("keeps a closed subshell cd from moving a later commit", () => {
    for (const command of [
      "(cd /r/wt) && git commit -m x",
      "( cd /r/wt ) && git commit -m x",
      "(true && cd /x) && git commit -m x",
      "(cd /a) && (cd /b) && git commit -m x",
    ]) {
      expect(resolveCommitTarget(command, posix), command).toEqual({ kind: "hook-root" });
    }
    expect(resolveCommitTarget("(cd /a) && cd /b && git commit -m x", posix)).toEqual({
      kind: "named",
      path: "/b",
      shape: "cd",
    });
    expect(resolveCommitTarget("cd /x && (git status) && git commit -m x", posix)).toEqual({
      kind: "named",
      path: "/x",
      shape: "cd",
    });
  });

  it("keeps quoted commit text, quoted heredoc data and parentheses in quotes as data", () => {
    expect(resolveCommitTarget('echo "git commit" && echo "(x)"', posix)).toBeNull();
    expect(resolveCommitTarget("cat <<'EOF'\n(cd /x && git commit -m x)\nEOF", posix)).toBeNull();
    expect(resolveCommitTarget("cat <<'EOF'\nbash -c \"$X\"\nEOF", posix)).toBeNull();
    expect(resolveCommitTarget('git commit -m "fix(hooks): x (#6362)"', posix)).toEqual({
      kind: "hook-root",
    });
    const heredocMessage = "git commit -m \"$(cat <<'EOF'\nfix(hooks): x (#6362)\nEOF\n)\"";
    expect(resolveCommitTarget(heredocMessage, posix)).toEqual({ kind: "hook-root" });
    expect(resolveCommitTarget("git commit -F - <<EOF\nfix(hooks): x (#6362)\nEOF", posix)).toEqual(
      { kind: "hook-root" },
    );
  });

  it("keeps heredoc body parentheses outside a substitution from opening or closing groups", () => {
    for (const command of [
      "cat <<EOF\n(note\nEOF\ngit commit -m x",
      "cat <<EOF\nlist 1) a\nEOF\ngit commit -m x",
      "cat <<EOF\n$(\ngit commit -am msg\n)\nEOF",
      "cat <<A <<B\n(x\nA\n)y\nB\ngit commit -m x",
      "cat <<EOF\r\n(note\r\nEOF\r\ngit commit -m x",
      "cat <<EOF\ngit commit -m x\nEOF\ngit commit -m x",
    ]) {
      expect(resolveCommitTarget(command, posix), command).toEqual({ kind: "hook-root" });
    }
    for (const command of [
      "(cat <<EOF\n)\nEOF\ngit commit -m x\n)",
      "(cd /x && cat <<EOF\n$(\ngit commit -am y\n)\nEOF\n)",
      "cat <<EOF\n$(\n(cd /x && git commit -m y)\n)\nEOF",
    ]) {
      expect(resolveCommitTarget(command, posix), command).toMatchObject({
        kind: "unresolvable",
        reason: GROUPED,
      });
    }
  });

  it("reads no signal from unquoted heredoc body text", () => {
    const body = 'cat > /tmp/b.md <<EOF\n`task check` passes\n$PATH\neval "$X"\nEOF';
    expect(resolveCommitTarget(body, posix)).toBeNull();
    expect(resolveCommitTarget(`${body}\ngit commit -F /tmp/b.md`, posix)).toEqual({
      kind: "hook-root",
    });
  });

  it("reads commands that cannot commit as no commit", () => {
    for (const command of [
      "bash -lc 'npm test'",
      "bash -c 'echo $HOME'",
      "bash script.sh",
      "sh -c 'git status && git log'",
      "eval 'echo hi'",
      "eval",
      "env FOO=1 npm test",
      "env echo git commit",
      "nice -n 5 echo git commit -m x",
      "env -S 'npm test'",
      "env -S 'echo git commit'",
      "env -S 'echo hi' >/tmp/out 2>&1",
      "env -S git >/tmp/status.log status",
      "env -uS git status",
      "command -v git commit",
      "timeout 60 npm test",
      "nohup node server.js &",
      "command -v git",
      "xargs git add",
      "$HOME/bin/tool --flag",
      '"$HOME/.local/bin/tool" run',
      "echo $((1 << 2))",
      "FOO=$(date) npm test",
    ]) {
      expect(resolveCommitTarget(command, posix), command).toBeNull();
      expect(commandHasGitCommitSubcommand(command), command).toBe(false);
    }
  });

  it("still reads a git binary named by path with a variable directory", () => {
    expect(resolveCommitTarget("~/bin/git commit -m x", posix)).toEqual({ kind: "hook-root" });
    expect(resolveCommitTarget("$HOME/bin/git -C /x commit -m x", posix)).toMatchObject({
      kind: "named",
      path: "/x",
    });
  });
});

describe("a variable needs a commit word; array assignments are assignments (#6871)", () => {
  it("reads a call with a variable but no commit word as no commit", () => {
    for (const command of [
      "declare -A M; M[$k]=v; echo ok",
      "$D verify:x",
      '$env:X="1"; deft foo',
      "$id = 5; deft scope:show $id",
      'bash -c "deft foo $X"',
      'sh -c "$CMD"',
      'bash -c "echo $HOME"',
      "sh -c '$CMD'",
      'eval "$X"',
      'env -S "$X"',
      "timeout 5 $CMD",
      "cat <<'EOF'\ncommit\nEOF\n$D verify:x",
    ]) {
      expect(resolveCommitTarget(command, posix), command).toBeNull();
      expect(commandHasGitCommitSubcommand(command), command).toBe(false);
    }
  });

  it("keeps a variable a signal when the call shows exact-word commit", () => {
    for (const [command, reason] of [
      ["$GIT commit -m x", /command word "\$GIT"/],
      ["GIT=git; $GIT co''mmit -m x", /command word "\$GIT"/],
      ['GIT=git; $GIT "com"mit -m x', /command word "\$GIT"/],
      ["GIT=git; $GIT co\\\nmmit -m x", /command word "\$GIT"/],
      ["$GIT COMMIT -m x", /command word "\$GIT"/],
      ['eval "$CMD"; git commit -m y', /`eval` holds a variable/],
      ['bash -c "$X" && git commit -m y', /`bash -c` string holds a variable/],
      // Exact word as a non-git argument still arms; substring-only paths do not (#7273).
      ["$BIN scope:promote; echo commit", /command word "\$BIN"/],
    ] as const) {
      const target = resolveCommitTarget(command, posix);
      expect(target, command).toMatchObject({ kind: "unresolvable" });
      if (target?.kind === "unresolvable") expect(target.reason, command).toMatch(reason);
    }
  });

  it("drops substring-only commit and admits lifecycle $BIN beside a named commit (#7273)", () => {
    expect(resolveCommitTarget("$BIN scope:promote --path with-commit-in-name", posix)).toBeNull();
    expect(
      resolveCommitTarget("$BIN scope:promote; git -C /r/wt commit -m x", posix),
    ).toMatchObject({ kind: "named", path: "/r/wt", shape: "git -C" });
    // Unquoted heredoc / path substring alone is not exact-word commit.
    expect(resolveCommitTarget("cat <<EOF\ncommit-me\nEOF\n$D verify:x", posix)).toBeNull();
    expect(resolveCommitTarget("cat <<EOF\ncommit\nEOF\n$D verify:x", posix)).toBeNull();
  });

  it("refuses opaque commit-shaped wrappers even beside a named commit (#7273)", () => {
    for (const command of [
      "$GIT commit -m x",
      "timeout 5 $CMD commit -m x",
      'bash -c "$GIT commit -m x"',
      'eval "$GIT commit -m x"',
      'env -S "$GIT commit -m x"',
      "$GIT commit -m x; git -C /r/wt commit -m y",
      "timeout 5 $CMD commit -m x; git -C /r/wt commit -m y",
      'bash -c "$GIT commit -m x"; git -C /r/wt commit -m y',
      'eval "$GIT commit -m x"; git -C /r/wt commit -m y',
      'env -S "$GIT commit -m x"; git -C /r/wt commit -m y',
      "git -C /r/wt commit -m y; $GIT commit -m x",
      // Expanding `$BIN -c` payload with exact commit stays opaque (#7305 P1).
      "BIN=bash; $BIN -c 'git -C /other commit -m x'; git -C /safe commit -m y",
      // Wrapper → nested expanding `-c` still arms exact-word scan (#7305 P1).
      'MSG=fix; timeout 60 bash -c "git -C /r/wt commit -m $MSG"',
    ]) {
      expect(resolveCommitTarget(command, posix), command).toMatchObject({ kind: "unresolvable" });
    }
  });

  it("keeps a variable git subcommand, grouped, wrapped and literal -c commits as signals", () => {
    for (const command of [
      "git $SUB",
      "(git commit -m x)",
      "env git commit -m x",
      "bash -c 'git commit -m x'",
      "xargs git",
    ]) {
      expect(resolveCommitTarget(command, posix), command).toMatchObject({ kind: "unresolvable" });
    }
  });

  it("reads array-element assignments as assignments", () => {
    expect(
      resolveCommitTarget("for x in a b; do\n  M[$x]=1\ndone; git commit -m y", posix),
    ).toEqual({ kind: "hook-root" });
    expect(resolveCommitTarget("M[k]+=v git commit -m y", posix)).toEqual({ kind: "hook-root" });
    expect(resolveCommitTarget("A[1]=x", posix)).toBeNull();
    expect(resolveCommitTarget("GIT_DIR[0]=/x git commit -m y", posix)).toMatchObject({
      kind: "unresolvable",
      reason: "the commit carries a GIT_DIR= prefix",
    });
  });

  it("does not read a substitution in a subscript as an assignment", () => {
    for (const command of ["M[$(git commit -m y)]=1", "M[`git commit -m y`]=1"]) {
      expect(resolveCommitTarget(command, posix), command).toMatchObject({ kind: "unresolvable" });
    }
  });
});
