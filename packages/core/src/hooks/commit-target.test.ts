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
    ["cd /a && git -C /b commit -m x", /more than one/],
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
