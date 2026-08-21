import { describe, expect, it } from "vitest";
import { listShellOps } from "../policy/runtime-authority.js";
import {
  classifyProductDestForms,
  payloadWithInjectedWriteTarget,
  SHELL_DEST_EXPANSION_SENTINEL,
} from "./dest-form.js";

const REPORTER =
  "git checkout -- apps/web/tsconfig.json apps/web/next-env.d.ts && rm apps/web/AGENTS.md apps/web/CLAUDE.md";

const sentinel = (kind: string) => ({
  kind,
  path: SHELL_DEST_EXPANSION_SENTINEL,
  expansion: true,
});

describe("classifyProductDestForms (#3438)", () => {
  it("does not reuse listShellOps for the filed repro", () => {
    expect(listShellOps(REPORTER)).toEqual([]);
    expect(listShellOps("git checkout -- apps/web/tsconfig.json")).toEqual([]);
    expect(listShellOps("rm apps/web/AGENTS.md")).toEqual([]);
    expect(listShellOps("git restore src/a.ts")).toEqual([]);
  });

  it("resolves a target only for a single simple command", () => {
    expect(classifyProductDestForms("git checkout HEAD -- src/a.ts")).toEqual([
      { kind: "git-checkout", path: "src/a.ts" },
    ]);
    expect(classifyProductDestForms("git checkout -- apps/web/tsconfig.json a/b.ts")).toEqual([
      { kind: "git-checkout", path: "apps/web/tsconfig.json" },
      { kind: "git-checkout", path: "a/b.ts" },
    ]);
    expect(classifyProductDestForms("rm -rf apps/web/AGENTS.md")).toEqual([
      { kind: "rm", path: "apps/web/AGENTS.md" },
    ]);
    expect(classifyProductDestForms('rmdir --ignore-fail-on-non-empty "tmp/dir"')).toEqual([
      { kind: "rmdir", path: "tmp/dir" },
    ]);
    expect(classifyProductDestForms("rm -- -weird")).toEqual([{ kind: "rm", path: "-weird" }]);
    expect(classifyProductDestForms("rm src/a.ts src/a.ts")).toEqual([
      { kind: "rm", path: "src/a.ts" },
    ]);
  });

  it("requires the -- separator for git checkout dest-forms", () => {
    expect(classifyProductDestForms("git checkout main")).toEqual([]);
    expect(classifyProductDestForms("git checkout -b topic")).toEqual([]);
    expect(classifyProductDestForms("git checkout apps/web/tsconfig.json")).toEqual([]);
  });

  it("harvests git restore dests including flags and --", () => {
    expect(classifyProductDestForms("git restore src/a.ts")).toEqual([
      { kind: "git-restore", path: "src/a.ts" },
    ]);
    expect(classifyProductDestForms("git restore --source=HEAD --staged -- src/a.ts")).toEqual([
      { kind: "git-restore", path: "src/a.ts" },
    ]);
    expect(classifyProductDestForms("git restore --source HEAD src/a.ts")).toEqual([
      { kind: "git-restore", path: "src/a.ts" },
    ]);
    expect(classifyProductDestForms("git restore -sHEAD src/a.ts")).toEqual([
      { kind: "git-restore", path: "src/a.ts" },
    ]);
    expect(classifyProductDestForms("git restore --conflict merge src/a.ts")).toEqual([
      { kind: "git-restore", path: "src/a.ts" },
    ]);
    expect(classifyProductDestForms("git restore --staged --")).toEqual([]);
  });

  it("resolves wrappers and quoted dests", () => {
    expect(classifyProductDestForms("FOO=1 sudo rm src/a.ts")).toEqual([
      { kind: "rm", path: "src/a.ts" },
    ]);
    expect(classifyProductDestForms("env BAR=2 rm.exe src/a.ts")).toEqual([
      { kind: "rm", path: "src/a.ts" },
    ]);
    expect(classifyProductDestForms("command rmdir.exe tmp/dir")).toEqual([
      { kind: "rmdir", path: "tmp/dir" },
    ]);
    expect(classifyProductDestForms('rm "apps/web/AGENTS.md"')).toEqual([
      { kind: "rm", path: "apps/web/AGENTS.md" },
    ]);
    expect(classifyProductDestForms('rm "quoted\\"name"')).toEqual([
      { kind: "rm", path: 'quoted"name' },
    ]);
    // Quoted metacharacters are literal, so they neither split nor fail closed.
    expect(classifyProductDestForms("rm 'weird(name).ts'")).toEqual([
      { kind: "rm", path: "weird(name).ts" },
    ]);
  });

  it("resolves an escaped dest but fails closed on a retained backslash", () => {
    // A CONSUMED escape leaves no backslash, so the path is unambiguous.
    expect(classifyProductDestForms("rm protected\\ file")).toEqual([
      { kind: "rm", path: "protected file" },
    ]);
    expect(classifyProductDestForms("git checkout -- my\\ file.ts")).toEqual([
      { kind: "git-checkout", path: "my file.ts" },
    ]);
    // A RETAINED backslash is dialect-ambiguous and cannot be proved: on win32
    // it is a path separator, but the same word under a POSIX shell (including
    // Git Bash on win32) drops it and targets something else. The payload does
    // not say which shell runs the command, so fail closed rather than pick.
    // Rewrite with forward slashes, which git and node accept on Windows.
    expect(classifyProductDestForms("rm C:\\Repos\\file.ts")).toEqual([
      { kind: "rm", path: "C:\\Repos\\file.ts", expansion: true },
    ]);
    expect(classifyProductDestForms("rm foo\\bar")).toEqual([
      { kind: "rm", path: "foo\\bar", expansion: true },
    ]);
    // The forward-slash rewrite the deny copy should steer toward still resolves.
    expect(classifyProductDestForms("rm C:/Repos/file.ts")).toEqual([
      { kind: "rm", path: "C:/Repos/file.ts" },
    ]);
  });

  it("fails closed on git pathspec-from-file, whose targets live in a file", () => {
    // Reading the file would mean hook-time I/O plus resolving its contents
    // against a cwd this classifier does not know — the resolution trap #3438
    // abandoned. Recognized, never resolved (#3624).
    for (const command of [
      "git checkout --pathspec-from-file=list.txt",
      "git checkout --pathspec-from-file=list.txt --",
      "git restore --pathspec-from-file=list.txt",
      "git checkout --pathspec-from-file=- --pathspec-file-nul",
    ]) {
      const dests = classifyProductDestForms(command);
      expect(dests.length, command).toBeGreaterThan(0);
      expect(
        dests.every((d) => d.expansion === true),
        command,
      ).toBe(true);
    }
  });

  it("leaves non-dest and hostile residual commands unclassifiable", () => {
    expect(classifyProductDestForms("")).toEqual([]);
    expect(classifyProductDestForms("   ")).toEqual([]);
    expect(classifyProductDestForms("git status")).toEqual([]);
    expect(classifyProductDestForms("git push origin HEAD")).toEqual([]);
    expect(classifyProductDestForms("rm -rf --")).toEqual([]);
    expect(classifyProductDestForms("echo 'rm src/a.ts'")).toEqual([]);
    // Known-open: recognition, not resolution, is the gap here (#3438).
    expect(classifyProductDestForms("python -c \"open('f','w').write('x')\"")).toEqual([]);
    expect(classifyProductDestForms("cmd /c copy a b")).toEqual([]);
    expect(classifyProductDestForms("bash -c 'rm apps/web/AGENTS.md'")).toEqual([]);
    // Compound with no recognized dest-form stays unclassifiable, not denied.
    expect(classifyProductDestForms("cd apps/web && npm test")).toEqual([]);
    expect(classifyProductDestForms("cat list | sort > out")).toEqual([]);
  });

  it("fails closed on any compound command rather than reconstructing a target", () => {
    // Reconstructing a target from shell state was tried and abandoned: cwd
    // depends on precedence, exit status, subshells, and git context, and every
    // resolution rule grew its own bypass (#3438). One dest per recognized kind.
    expect(classifyProductDestForms(REPORTER)).toEqual([sentinel("git-checkout"), sentinel("rm")]);
    expect(classifyProductDestForms("cd sub && rm allowed | rm secret")).toEqual([sentinel("rm")]);
    expect(classifyProductDestForms("cd sub && rm a & rm b")).toEqual([sentinel("rm")]);
    expect(classifyProductDestForms("cd scoped || rm x")).toEqual([sentinel("rm")]);
    expect(classifyProductDestForms("cd scoped || echo failed && rm target")).toEqual([
      sentinel("rm"),
    ]);
    expect(classifyProductDestForms("cd ~ && rm secret")).toEqual([sentinel("rm")]);
    expect(classifyProductDestForms("rm src/a.ts || rmdir tmp/dir")).toEqual([
      sentinel("rm"),
      sentinel("rmdir"),
    ]);
    expect(classifyProductDestForms("rm src/a.ts\nrmdir tmp/dir")).toEqual([
      sentinel("rm"),
      sentinel("rmdir"),
    ]);
    expect(classifyProductDestForms("rm a.ts ; rm b.ts")).toEqual([sentinel("rm")]);
  });

  it("fails closed on grouping and substitution even in a single segment", () => {
    expect(classifyProductDestForms("(cd sub && rm secret.ts)")).toEqual([sentinel("rm")]);
    expect(classifyProductDestForms("{ rm secret.ts; }")).toEqual([sentinel("rm")]);
    expect(classifyProductDestForms("rm $(cat list)")).toEqual([sentinel("rm")]);
    expect(classifyProductDestForms('rm "$TARGET/x"')).toEqual([sentinel("rm")]);
    expect(classifyProductDestForms("rm `cat list`")).toEqual([sentinel("rm")]);
  });

  it("fails closed on git context options that relocate the work tree", () => {
    // `-C` composes, `--work-tree` resolves against it, `--git-dir` interacts
    // with both, and `-c core.workTree` depends on the git dir. Not resolved.
    expect(classifyProductDestForms("git -C repo checkout -- src/a.ts")).toEqual([
      { kind: "git-checkout", path: "src/a.ts", expansion: true },
    ]);
    expect(classifyProductDestForms("git -Crepo checkout -- src/a.ts")).toEqual([
      { kind: "git-checkout", path: "src/a.ts", expansion: true },
    ]);
    expect(classifyProductDestForms("git --work-tree=tree checkout -- src/a.ts")).toEqual([
      { kind: "git-checkout", path: "src/a.ts", expansion: true },
    ]);
    expect(classifyProductDestForms("git --git-dir=/tmp/g checkout -- src/a.ts")).toEqual([
      { kind: "git-checkout", path: "src/a.ts", expansion: true },
    ]);
    expect(classifyProductDestForms("git -c core.workTree=/tmp/tree checkout -- f.ts")).toEqual([
      { kind: "git-checkout", path: "f.ts", expansion: true },
    ]);
    expect(classifyProductDestForms("GIT_WORK_TREE=pkg git checkout -- a.ts")).toEqual([
      { kind: "git-checkout", path: "a.ts", expansion: true },
    ]);
    // An unrelated -c is skipped cleanly, not fail-closed.
    expect(classifyProductDestForms("git -c core.editor=vim checkout -- f.ts")).toEqual([
      { kind: "git-checkout", path: "f.ts" },
    ]);
  });

  it("recognizes a wrapped verb behind the wrapper's own options", () => {
    // These previously left the flag in the binary position and fell through to
    // the fail-OPEN path (#3438).
    expect(classifyProductDestForms("sudo -n rm protected/file")).toEqual([
      { kind: "rm", path: "protected/file" },
    ]);
    expect(classifyProductDestForms("env -i rm protected/file")).toEqual([
      { kind: "rm", path: "protected/file" },
    ]);
    expect(classifyProductDestForms("command -- rm protected/file")).toEqual([
      { kind: "rm", path: "protected/file" },
    ]);
    expect(classifyProductDestForms("sudo -n git checkout -- src/a.ts")).toEqual([
      { kind: "git-checkout", path: "src/a.ts" },
    ]);
    // Non-mutating wrapped commands stay unclassifiable, not denied.
    expect(classifyProductDestForms("sudo -n apt-get update")).toEqual([]);
    // Options that take a SEPARATE value used to leave that value in the binary
    // position and hide the verb entirely (fail-open). Scanning forward to the
    // first recognized verb fixes the whole class, not just the flag-only forms.
    expect(classifyProductDestForms("sudo -u root rm protected/file")).toEqual([
      { kind: "rm", path: "protected/file" },
    ]);
    expect(classifyProductDestForms("env -u NODE_ENV rm protected/file")).toEqual([
      { kind: "rm", path: "protected/file" },
    ]);
    expect(classifyProductDestForms("sudo -u root git checkout -- src/a.ts")).toEqual([
      { kind: "git-checkout", path: "src/a.ts" },
    ]);
    // Exact-match keeps the scan tight: a look-alike argument is not a verb.
    expect(classifyProductDestForms("sudo apt-get install rm-utils")).toEqual([]);
    expect(classifyProductDestForms("sudo bash -c 'rm x'")).toEqual([]);
  });

  it("fails closed on env-provided git work-tree relocation", () => {
    expect(classifyProductDestForms("GIT_CONFIG_KEY_0=core.worktree git checkout -- f.ts")).toEqual(
      [{ kind: "git-checkout", path: "f.ts", expansion: true }],
    );
    expect(classifyProductDestForms("GIT_DIR=/tmp/g git checkout -- f.ts")).toEqual([
      { kind: "git-checkout", path: "f.ts", expansion: true },
    ]);
    expect(classifyProductDestForms("GIT_CONFIG_GLOBAL=/tmp/c git checkout -- f.ts")).toEqual([
      { kind: "git-checkout", path: "f.ts", expansion: true },
    ]);
    // An unrelated env-config key is not a relocation.
    expect(classifyProductDestForms("GIT_CONFIG_KEY_0=core.editor git checkout -- f.ts")).toEqual([
      { kind: "git-checkout", path: "f.ts" },
    ]);
    // A bare count is harmless on its own.
    expect(classifyProductDestForms("GIT_CONFIG_COUNT=1 git checkout -- f.ts")).toEqual([
      { kind: "git-checkout", path: "f.ts" },
    ]);
  });

  it("fails closed on glob and tilde dests but not a trailing tilde", () => {
    expect(classifyProductDestForms("rm src/*.ts")).toEqual([
      { kind: "rm", path: "src/*.ts", expansion: true },
    ]);
    expect(classifyProductDestForms("rm ~/secret")).toEqual([
      { kind: "rm", path: "~/secret", expansion: true },
    ]);
    expect(classifyProductDestForms("git checkout -- ~/x.ts")).toEqual([
      { kind: "git-checkout", path: "~/x.ts", expansion: true },
    ]);
    // A trailing `~` is an ordinary backup file, not an expansion.
    expect(classifyProductDestForms("rm src/foo.ts~")).toEqual([
      { kind: "rm", path: "src/foo.ts~" },
    ]);
  });

  it("injects dest path without dropping the original command", () => {
    const next = payloadWithInjectedWriteTarget(
      { tool_name: "Bash", tool_input: { command: "rm src/a.ts", worker_role: "assist" } },
      "src/a.ts",
    );
    expect(next.tool_input).toMatchObject({
      command: "rm src/a.ts",
      worker_role: "assist",
      file_path: "src/a.ts",
    });
    expect(payloadWithInjectedWriteTarget(null, "src/a.ts").tool_input).toMatchObject({
      file_path: "src/a.ts",
    });
  });
});
