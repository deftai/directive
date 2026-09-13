import { describe, expect, it } from "vitest";
import { classifyProductDestForms } from "./dest-form.js";
import { classifyLauncherFamilyArgv, NOT_LAUNCHER } from "./launcher-argv.js";
import { isSpawnTool, SPAWN_TOOL_NAMES } from "./tools.js";

describe("classifyLauncherFamilyArgv (#4219)", () => {
  it("classifies grok --cwd dest as launcher with dest", () => {
    expect(
      classifyLauncherFamilyArgv(
        "grok --cwd /wt --prompt-file /e.md --permission-mode bypassPermissions --always-approve",
      ),
    ).toEqual({ kind: "launcher", family: "grok", dest: "/wt", compound: false });
  });

  it("preserves Windows dest inside quotes", () => {
    expect(classifyLauncherFamilyArgv('grok --cwd "C:\\wt" --always-approve')).toEqual({
      kind: "launcher",
      family: "grok",
      dest: "C:\\wt",
      compound: false,
    });
  });

  it("classifies grok --cwd=dest", () => {
    expect(classifyLauncherFamilyArgv("grok --cwd=/wt --always-approve")).toEqual({
      kind: "launcher",
      family: "grok",
      dest: "/wt",
      compound: false,
    });
  });

  it("treats --cwd without a value as dest-absent", () => {
    expect(classifyLauncherFamilyArgv("grok --cwd --always-approve")).toEqual({
      kind: "launcher",
      family: "grok",
      dest: null,
      compound: false,
    });
  });

  it("classifies dest-absent grok as launcher with null dest", () => {
    expect(
      classifyLauncherFamilyArgv("grok --always-approve --permission-mode bypassPermissions"),
    ).toEqual({ kind: "launcher", family: "grok", dest: null, compound: false });
  });

  it("does not classify bare grok or grok login/models as worker launches", () => {
    expect(classifyLauncherFamilyArgv("grok")).toEqual(NOT_LAUNCHER);
    expect(classifyLauncherFamilyArgv("grok login")).toEqual(NOT_LAUNCHER);
    expect(classifyLauncherFamilyArgv("grok logout")).toEqual(NOT_LAUNCHER);
    expect(classifyLauncherFamilyArgv("grok models")).toEqual(NOT_LAUNCHER);
  });

  it("does not inherit payload cwd for grok (#4066)", () => {
    expect(classifyLauncherFamilyArgv("grok --always-approve", { payloadCwd: "/wt" })).toEqual({
      kind: "launcher",
      family: "grok",
      dest: null,
      compound: false,
    });
  });

  it("does not classify grok --version", () => {
    expect(classifyLauncherFamilyArgv("grok --version")).toEqual(NOT_LAUNCHER);
  });

  it("classifies claude -p worker argv; dest from payload cwd", () => {
    expect(
      classifyLauncherFamilyArgv(
        'claude -p "Read and follow /e.md" --model opus --permission-mode bypassPermissions --output-format text',
        { payloadCwd: "/wt" },
      ),
    ).toEqual({ kind: "launcher", family: "claude", dest: "/wt", compound: false });
  });

  it("classifies dest-absent claude worker argv", () => {
    expect(
      classifyLauncherFamilyArgv(
        'claude -p "Read and follow /e.md" --permission-mode bypassPermissions',
      ),
    ).toEqual({ kind: "launcher", family: "claude", dest: null, compound: false });
  });

  it("does not classify claude --version", () => {
    expect(classifyLauncherFamilyArgv("claude --version")).toEqual(NOT_LAUNCHER);
  });

  it("classifies codex exec -C dest", () => {
    expect(
      classifyLauncherFamilyArgv(
        'codex exec --ephemeral --skip-git-repo-check --dangerously-bypass-approvals-and-sandbox -C /wt "Read and follow /e.md"',
      ),
    ).toEqual({ kind: "launcher", family: "codex", dest: "/wt", compound: false });
  });

  it("classifies dest-absent codex exec", () => {
    expect(classifyLauncherFamilyArgv("codex exec --ephemeral --skip-git-repo-check")).toEqual({
      kind: "launcher",
      family: "codex",
      dest: null,
      compound: false,
    });
  });

  it("does not inherit payload cwd for codex", () => {
    expect(classifyLauncherFamilyArgv("codex exec --ephemeral", { payloadCwd: "/wt" })).toEqual({
      kind: "launcher",
      family: "codex",
      dest: null,
      compound: false,
    });
  });

  it("does not classify git status", () => {
    expect(classifyLauncherFamilyArgv("git status")).toEqual(NOT_LAUNCHER);
  });

  it("does not classify rm product dest-forms", () => {
    expect(classifyLauncherFamilyArgv("rm packages/core/src/a.ts")).toEqual(NOT_LAUNCHER);
  });

  it("classifies grok.exe and path-prefixed bins", () => {
    expect(classifyLauncherFamilyArgv("C:\\\\bin\\\\grok.exe --cwd /wt")).toEqual({
      kind: "launcher",
      family: "grok",
      dest: "/wt",
      compound: false,
    });
  });

  it("skips env/sudo wrappers", () => {
    expect(classifyLauncherFamilyArgv("env FOO=1 grok --cwd /wt --always-approve")).toEqual({
      kind: "launcher",
      family: "grok",
      dest: "/wt",
      compound: false,
    });
    expect(classifyLauncherFamilyArgv("env -C /tmp grok --cwd /wt --always-approve")).toEqual({
      kind: "launcher",
      family: "grok",
      dest: "/wt",
      compound: false,
    });
  });

  it("marks compound launcher argv so trailing segments cannot skip gates", () => {
    expect(classifyLauncherFamilyArgv("git status && grok --cwd /wt --always-approve")).toEqual({
      kind: "launcher",
      family: "grok",
      dest: "/wt",
      compound: true,
    });
    expect(classifyLauncherFamilyArgv("grok --cwd /wt && git reset --hard")).toEqual({
      kind: "launcher",
      family: "grok",
      dest: "/wt",
      compound: true,
    });
  });

  it("classifies claude --cwd in argv over payload cwd", () => {
    expect(
      classifyLauncherFamilyArgv(
        'claude --cwd /argv-dest -p "Read and follow /e.md" --permission-mode bypassPermissions',
        { payloadCwd: "/payload-dest" },
      ),
    ).toEqual({ kind: "launcher", family: "claude", dest: "/argv-dest", compound: false });
  });

  it("classifies empty command as not-launcher", () => {
    expect(classifyLauncherFamilyArgv("   ")).toEqual(NOT_LAUNCHER);
  });

  it("does not host classification on product dest-forms", () => {
    expect(classifyProductDestForms("grok --cwd /wt --always-approve")).toEqual([]);
    expect(
      classifyProductDestForms(
        'claude -p "Read and follow /e.md" --permission-mode bypassPermissions',
      ),
    ).toEqual([]);
    expect(classifyProductDestForms("codex exec --cd /wt")).toEqual([]);
  });

  it("does not host classification on SPAWN_TOOL_NAMES", () => {
    expect(SPAWN_TOOL_NAMES).not.toContain("grok");
    expect(isSpawnTool("run_terminal_command")).toBe(false);
    expect(isSpawnTool("monitor")).toBe(false);
  });
});
