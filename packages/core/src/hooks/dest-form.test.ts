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
});
