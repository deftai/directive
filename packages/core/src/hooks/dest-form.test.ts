import { describe, expect, it } from "vitest";
import { listShellOps } from "../policy/runtime-authority.js";
import { classifyProductDestForms, payloadWithInjectedWriteTarget } from "./dest-form.js";

const REPORTER =
  "git checkout -- apps/web/tsconfig.json apps/web/next-env.d.ts && rm apps/web/AGENTS.md apps/web/CLAUDE.md";

describe("classifyProductDestForms (#3438)", () => {
  it("does not reuse listShellOps for the filed repro", () => {
    expect(listShellOps(REPORTER)).toEqual([]);
    expect(listShellOps("git checkout -- apps/web/tsconfig.json")).toEqual([]);
    expect(listShellOps("rm apps/web/AGENTS.md")).toEqual([]);
    expect(listShellOps("git restore src/a.ts")).toEqual([]);
  });

  it("harvests git checkout -- and rm dests from the reporter compound", () => {
    expect(classifyProductDestForms(REPORTER)).toEqual([
      { kind: "git-checkout", path: "apps/web/tsconfig.json" },
      { kind: "git-checkout", path: "apps/web/next-env.d.ts" },
      { kind: "rm", path: "apps/web/AGENTS.md" },
      { kind: "rm", path: "apps/web/CLAUDE.md" },
    ]);
  });

  it("requires the -- separator for git checkout dest-forms", () => {
    expect(classifyProductDestForms("git checkout main")).toEqual([]);
    expect(classifyProductDestForms("git checkout -b topic")).toEqual([]);
    expect(classifyProductDestForms("git checkout apps/web/tsconfig.json")).toEqual([]);
    expect(classifyProductDestForms("git checkout HEAD -- src/a.ts")).toEqual([
      { kind: "git-checkout", path: "src/a.ts" },
    ]);
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
  });

  it("harvests rm and rmdir dests after flags", () => {
    expect(classifyProductDestForms("rm -rf apps/web/AGENTS.md")).toEqual([
      { kind: "rm", path: "apps/web/AGENTS.md" },
    ]);
    expect(classifyProductDestForms('rmdir --ignore-fail-on-non-empty "tmp/dir"')).toEqual([
      { kind: "rmdir", path: "tmp/dir" },
    ]);
    expect(classifyProductDestForms("rm -- -weird")).toEqual([{ kind: "rm", path: "-weird" }]);
  });

  it("leaves non-dest and hostile residual commands unclassifiable", () => {
    expect(classifyProductDestForms("git status")).toEqual([]);
    expect(classifyProductDestForms("git push origin HEAD")).toEqual([]);
    expect(classifyProductDestForms("python -c \"open('f','w').write('x')\"")).toEqual([]);
    expect(classifyProductDestForms("cmd /c copy a b")).toEqual([]);
    expect(classifyProductDestForms("bash -c 'rm apps/web/AGENTS.md'")).toEqual([]);
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

  it("covers wrappers, git globals, separators, and quoted dests", () => {
    expect(classifyProductDestForms("")).toEqual([]);
    expect(classifyProductDestForms("   ")).toEqual([]);
    expect(classifyProductDestForms("FOO=1 sudo rm src/a.ts")).toEqual([
      { kind: "rm", path: "src/a.ts" },
    ]);
    expect(classifyProductDestForms("env BAR=2 rm.exe src/a.ts")).toEqual([
      { kind: "rm", path: "src/a.ts" },
    ]);
    expect(classifyProductDestForms("command rmdir.exe tmp/dir")).toEqual([
      { kind: "rmdir", path: "tmp/dir" },
    ]);
    expect(
      classifyProductDestForms("git.exe -C repo --git-dir=/tmp/g -- checkout -- src/a.ts"),
    ).toEqual([{ kind: "git-checkout", path: "repo/src/a.ts" }]);
    expect(classifyProductDestForms("git --work-tree=tree checkout -- src/a.ts")).toEqual([
      { kind: "git-checkout", path: "tree/src/a.ts" },
    ]);
    expect(classifyProductDestForms("GIT_WORK_TREE=pkg git checkout -- a.ts")).toEqual([
      { kind: "git-checkout", path: "pkg/a.ts" },
    ]);
    expect(classifyProductDestForms("cd apps/web && rm AGENTS.md")).toEqual([
      { kind: "rm", path: "apps/web/AGENTS.md" },
    ]);
    expect(classifyProductDestForms("cd /tmp | rm secret.ts")).toEqual([
      { kind: "rm", path: "secret.ts" },
    ]);
    expect(classifyProductDestForms("cd /tmp & rm secret.ts")).toEqual([
      { kind: "rm", path: "secret.ts" },
    ]);
    expect(classifyProductDestForms("rm src/*.ts")).toEqual([
      { kind: "rm", path: "src/*.ts", expansion: true },
    ]);
    expect(classifyProductDestForms("echo 'rm src/a.ts'")).toEqual([]);
    expect(classifyProductDestForms("git restore -sHEAD src/a.ts")).toEqual([
      { kind: "git-restore", path: "src/a.ts" },
    ]);
    expect(classifyProductDestForms("git restore --conflict merge src/a.ts")).toEqual([
      { kind: "git-restore", path: "src/a.ts" },
    ]);
    expect(classifyProductDestForms("git restore --staged --")).toEqual([]);
    expect(classifyProductDestForms('rm "apps/web/AGENTS.md"')).toEqual([
      { kind: "rm", path: "apps/web/AGENTS.md" },
    ]);
    expect(classifyProductDestForms('rm "quoted\\"name"')).toEqual([
      { kind: "rm", path: 'quoted"name' },
    ]);
    expect(classifyProductDestForms("rm src/a.ts ; rm src/a.ts")).toEqual([
      { kind: "rm", path: "src/a.ts" },
    ]);
    expect(classifyProductDestForms("rm src/a.ts || rmdir tmp/dir")).toEqual([
      { kind: "rm", path: "src/a.ts" },
      { kind: "rmdir", path: "tmp/dir" },
    ]);
    expect(classifyProductDestForms("rm src/a.ts\nrmdir tmp/dir")).toEqual([
      { kind: "rm", path: "src/a.ts" },
      { kind: "rmdir", path: "tmp/dir" },
    ]);
    expect(classifyProductDestForms("rm -rf --")).toEqual([]);
    expect(classifyProductDestForms("git push origin HEAD")).toEqual([]);
  });

  it("keeps the parent cwd for pipeline and backgrounded segments", () => {
    // A pipeline member runs in a subshell, but a subshell inherits the parent
    // cwd — dropping the prefix here would fence a shallower path than the
    // shell mutates. `cd` in the parent, pipeline in the child.
    expect(classifyProductDestForms("cd sub && rm allowed | rm secret")).toEqual([
      { kind: "rm", path: "sub/allowed" },
      { kind: "rm", path: "sub/secret" },
    ]);
    expect(classifyProductDestForms("cd apps/web && rm a; rm b")).toEqual([
      { kind: "rm", path: "apps/web/a" },
      { kind: "rm", path: "apps/web/b" },
    ]);
    expect(classifyProductDestForms("cd a && cd b && rm c.ts")).toEqual([
      { kind: "rm", path: "a/b/c.ts" },
    ]);
  });

  it("applies shell precedence: & binds looser than && / ||, which bind looser than |", () => {
    // `cd sub && rm a & rm b` parses as `{ cd sub && rm a } &` plus `rm b`.
    // The trailing removal runs in the parent shell at the ORIGINAL cwd, so it
    // targets root `b`. Reconstructing `sub/b` would fence an in-scope path
    // while the shell deletes an out-of-scope one (#3438).
    expect(classifyProductDestForms("cd sub && rm a & rm b")).toEqual([
      { kind: "rm", path: "sub/a" },
      { kind: "rm", path: "b" },
    ]);
    expect(classifyProductDestForms("cd sub && rm a && rm b & rm c")).toEqual([
      { kind: "rm", path: "sub/a" },
      { kind: "rm", path: "sub/b" },
      { kind: "rm", path: "c" },
    ]);
    // `|` binds tighter, so the whole pipeline stays inside the cd.
    expect(classifyProductDestForms("cd sub && rm a | rm b")).toEqual([
      { kind: "rm", path: "sub/a" },
      { kind: "rm", path: "sub/b" },
    ]);
    // A backgrounded list still reads the cwd exported before it.
    expect(classifyProductDestForms("cd sub; cd deep && rm a & rm b")).toEqual([
      { kind: "rm", path: "sub/deep/a" },
      { kind: "rm", path: "sub/b" },
    ]);
    // Pipeline inside a backgrounded list: confined, but inherits.
    expect(classifyProductDestForms("cd sub && rm a | rm b & rm c")).toEqual([
      { kind: "rm", path: "sub/a" },
      { kind: "rm", path: "sub/b" },
      { kind: "rm", path: "c" },
    ]);
  });

  it("confines a cd that runs inside a pipeline or background subshell", () => {
    // Export-out is the conditional direction: the child's `cd` dies with it.
    expect(classifyProductDestForms("rm a.ts | cd sub && rm b.ts")).toEqual([
      { kind: "rm", path: "a.ts" },
      { kind: "rm", path: "b.ts" },
    ]);
    expect(classifyProductDestForms("cd sub | rm a.ts; rm b.ts")).toEqual([
      { kind: "rm", path: "a.ts" },
      { kind: "rm", path: "b.ts" },
    ]);
    expect(classifyProductDestForms("cd sub & rm a.ts")).toEqual([{ kind: "rm", path: "a.ts" }]);
  });

  it("composes repeated git -C and --work-tree context options", () => {
    expect(classifyProductDestForms("git -C a -C b checkout -- f.ts")).toEqual([
      { kind: "git-checkout", path: "a/b/f.ts" },
    ]);
    expect(classifyProductDestForms("git -Ca -Cb checkout -- f.ts")).toEqual([
      { kind: "git-checkout", path: "a/b/f.ts" },
    ]);
    expect(classifyProductDestForms("git -C a --work-tree=w checkout -- f.ts")).toEqual([
      { kind: "git-checkout", path: "a/w/f.ts" },
    ]);
    expect(classifyProductDestForms("git -C a --work-tree w restore -- f.ts")).toEqual([
      { kind: "git-restore", path: "a/w/f.ts" },
    ]);
    // An absolute -C resets the chain, matching git.
    expect(classifyProductDestForms("git -C a -C /srv/repo checkout -- f.ts")).toEqual([
      { kind: "git-checkout", path: "/srv/repo/f.ts" },
    ]);
    // The compound cwd still layers on top of the composed git context.
    expect(classifyProductDestForms("cd sub && git -C a -C b checkout -- f.ts")).toEqual([
      { kind: "git-checkout", path: "sub/a/b/f.ts" },
    ]);
  });

  it("fails closed on subshell grouping it cannot reconstruct", () => {
    // Grouping is detected, not parsed: the token keeps its trailing `)` and the
    // reconstruction is best-effort. Only the fail-closed verdict is load-bearing.
    expect(classifyProductDestForms("(cd sub && rm secret.ts)")).toEqual([
      { kind: "rm", path: "secret.ts)", expansion: true },
    ]);
    expect(classifyProductDestForms("( cd sub ) && rm secret.ts")).toEqual([
      { kind: "rm", path: "secret.ts", expansion: true },
    ]);
    // Quoted parens are literal, not grouping.
    expect(classifyProductDestForms("rm 'weird(name).ts'")).toEqual([
      { kind: "rm", path: "weird(name).ts" },
    ]);
  });
});
