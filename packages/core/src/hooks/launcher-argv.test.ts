import { describe, expect, it } from "vitest";
import {
  AGY_CRITIC_MODEL,
  AGY_PONG_ARGV,
  AGY_SHORT_POINTER_ARGV,
  agyModelDischargesSeat,
  evaluateAgySeatCompletion,
  evaluatePanelSeatComposition,
} from "../design-critique/panel-seat-families.js";
import { classifyProductDestForms } from "./dest-form.js";
import { classifyLauncherFamilyArgv, LAUNCHER_FAMILIES, NOT_LAUNCHER } from "./launcher-argv.js";
import { isSpawnTool, SPAWN_TOOL_NAMES } from "./tools.js";

describe("classifyLauncherFamilyArgv (#4219)", () => {
  it("classifies grok --cwd dest as launcher with dest", () => {
    expect(
      classifyLauncherFamilyArgv(
        "grok --cwd /wt --prompt-file /e.md --permission-mode bypassPermissions --always-approve",
      ),
    ).toEqual({ kind: "launcher", family: "grok", dest: "/wt" });
  });

  it("preserves Windows dest inside quotes", () => {
    expect(classifyLauncherFamilyArgv('grok --cwd "C:\\wt" --always-approve')).toEqual({
      kind: "launcher",
      family: "grok",
      dest: "C:\\wt",
    });
  });

  it("classifies grok --cwd=dest", () => {
    expect(classifyLauncherFamilyArgv("grok --cwd=/wt --always-approve")).toEqual({
      kind: "launcher",
      family: "grok",
      dest: "/wt",
    });
  });

  it("treats --cwd without a value as dest-absent", () => {
    expect(classifyLauncherFamilyArgv("grok --cwd --always-approve")).toEqual({
      kind: "launcher",
      family: "grok",
      dest: null,
    });
  });

  it("classifies dest-absent grok as launcher with null dest", () => {
    expect(
      classifyLauncherFamilyArgv("grok --always-approve --permission-mode bypassPermissions"),
    ).toEqual({ kind: "launcher", family: "grok", dest: null });
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
    ).toEqual({ kind: "launcher", family: "claude", dest: "/wt" });
  });

  it("classifies dest-absent claude worker argv", () => {
    expect(
      classifyLauncherFamilyArgv(
        'claude -p "Read and follow /e.md" --permission-mode bypassPermissions',
      ),
    ).toEqual({ kind: "launcher", family: "claude", dest: null });
  });

  it("does not classify claude --version", () => {
    expect(classifyLauncherFamilyArgv("claude --version")).toEqual(NOT_LAUNCHER);
  });

  it("classifies codex exec -C dest", () => {
    expect(
      classifyLauncherFamilyArgv(
        'codex exec --ephemeral --skip-git-repo-check --dangerously-bypass-approvals-and-sandbox -C /wt "Read and follow /e.md"',
      ),
    ).toEqual({ kind: "launcher", family: "codex", dest: "/wt" });
  });

  it("classifies dest-absent codex exec", () => {
    expect(classifyLauncherFamilyArgv("codex exec --ephemeral --skip-git-repo-check")).toEqual({
      kind: "launcher",
      family: "codex",
      dest: null,
    });
  });

  it("does not inherit payload cwd for codex", () => {
    expect(classifyLauncherFamilyArgv("codex exec --ephemeral", { payloadCwd: "/wt" })).toEqual({
      kind: "launcher",
      family: "codex",
      dest: null,
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
    });
  });

  it("skips env/sudo wrappers", () => {
    expect(classifyLauncherFamilyArgv("env FOO=1 grok --cwd /wt --always-approve")).toEqual({
      kind: "launcher",
      family: "grok",
      dest: "/wt",
    });
    expect(classifyLauncherFamilyArgv("env -C /tmp grok --cwd /wt --always-approve")).toEqual({
      kind: "launcher",
      family: "grok",
      dest: "/wt",
    });
  });

  it("does not classify compound argv as an allowable launcher", () => {
    expect(classifyLauncherFamilyArgv("git status && grok --cwd /wt --always-approve")).toEqual({
      kind: "compound",
      family: "grok",
    });
    expect(classifyLauncherFamilyArgv("grok --cwd /wt && git reset --hard")).toEqual({
      kind: "compound",
      family: "grok",
    });
  });

  it("does not classify quoted command substitution as an allowable launcher", () => {
    expect(classifyLauncherFamilyArgv('grok --cwd /wt --always-approve "$(rm target)"')).toEqual({
      kind: "compound",
      family: "grok",
    });
    expect(classifyLauncherFamilyArgv("grok --cwd /wt --always-approve `rm target`")).toEqual({
      kind: "compound",
      family: "grok",
    });
    expect(classifyLauncherFamilyArgv("grok --cwd /wt --always-approve $(rm target)")).toEqual({
      kind: "compound",
      family: "grok",
    });
    expect(classifyLauncherFamilyArgv("grok --cwd /wt --always-approve <(echo x)")).toEqual({
      kind: "compound",
      family: "grok",
    });
    expect(classifyLauncherFamilyArgv('grok --cwd "$(pwd)/wt" --always-approve')).toEqual({
      kind: "compound",
      family: "grok",
    });
    expect(
      classifyLauncherFamilyArgv('grok --cwd /wt --always-approve --prompt "use `whoami`"'),
    ).toEqual({ kind: "compound", family: "grok" });
  });

  it("does not treat single-quoted or escaped substitution syntax as compound", () => {
    expect(
      classifyLauncherFamilyArgv("grok --cwd /wt --always-approve --prompt 'explain $(...)'"),
    ).toEqual({ kind: "launcher", family: "grok", dest: "/wt" });
    expect(classifyLauncherFamilyArgv("grok --cwd /wt --always-approve --prompt \\$(...)")).toEqual(
      { kind: "launcher", family: "grok", dest: "/wt" },
    );
    expect(
      classifyLauncherFamilyArgv("grok --cwd /wt --always-approve --prompt 'use `code`'"),
    ).toEqual({ kind: "launcher", family: "grok", dest: "/wt" });
    expect(
      classifyLauncherFamilyArgv("grok --cwd /wt --always-approve --prompt \\`code\\`"),
    ).toEqual({ kind: "launcher", family: "grok", dest: "/wt" });
    expect(
      classifyLauncherFamilyArgv('grok --cwd /wt --always-approve --prompt "\\$(...)"'),
    ).toEqual({ kind: "launcher", family: "grok", dest: "/wt" });
  });

  it("classifies claude --cwd in argv over payload cwd", () => {
    expect(
      classifyLauncherFamilyArgv(
        'claude --cwd /argv-dest -p "Read and follow /e.md" --permission-mode bypassPermissions',
        { payloadCwd: "/payload-dest" },
      ),
    ).toEqual({ kind: "launcher", family: "claude", dest: "/argv-dest" });
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

  it("admits agy on LAUNCHER_FAMILIES (#7245)", () => {
    expect(LAUNCHER_FAMILIES).toContain("agy");
  });

  it("classifies agy -p worker argv; dest from payload cwd (#7245)", () => {
    expect(
      classifyLauncherFamilyArgv(
        'agy -p "Read and follow /e.md" --model gemini-4-hydrogen-high --output-format json --print-timeout 2m --sandbox',
        { payloadCwd: "/wt" },
      ),
    ).toEqual({ kind: "launcher", family: "agy", dest: "/wt" });
  });

  it("classifies dest-absent agy worker argv (#7245)", () => {
    expect(
      classifyLauncherFamilyArgv(
        'agy -p "Do not use tools. Reply with the single word: pong" --model gemini-4-hydrogen-high --output-format json --print-timeout 2m --sandbox',
      ),
    ).toEqual({ kind: "launcher", family: "agy", dest: null });
  });

  it("does not classify bare agy, agy models, or agy --version (#7245)", () => {
    expect(classifyLauncherFamilyArgv("agy")).toEqual(NOT_LAUNCHER);
    expect(classifyLauncherFamilyArgv("agy models")).toEqual(NOT_LAUNCHER);
    expect(classifyLauncherFamilyArgv("agy --version")).toEqual(NOT_LAUNCHER);
    expect(classifyLauncherFamilyArgv("agy.exe --help")).toEqual(NOT_LAUNCHER);
  });

  it("classifies path-prefixed agy.exe print argv (#7245)", () => {
    expect(
      classifyLauncherFamilyArgv(
        'C:\\\\agy\\\\bin\\\\agy.exe --print "pong" --model gemini-4-hydrogen-high --sandbox',
        { payloadCwd: "C:\\wt" },
      ),
    ).toEqual({ kind: "launcher", family: "agy", dest: "C:\\wt" });
  });

  it("does not classify compound agy argv as an allowable launcher (#7245)", () => {
    expect(
      classifyLauncherFamilyArgv('agy -p "pong" --sandbox && git reset --hard', {
        payloadCwd: "/wt",
      }),
    ).toEqual({ kind: "compound", family: "agy" });
  });

  it("classifies agy -i and --prompt-interactive worker argv (#7451)", () => {
    expect(classifyLauncherFamilyArgv("agy -i 'Read /e.md'")).toEqual({
      kind: "launcher",
      family: "agy",
      dest: null,
    });
    expect(
      classifyLauncherFamilyArgv("agy --prompt-interactive 'Read /e.md'", { payloadCwd: "/wt" }),
    ).toEqual({ kind: "launcher", family: "agy", dest: "/wt" });
  });

  it("classifies agy --dangerously-skip-permissions with stream formats (#7451)", () => {
    expect(
      classifyLauncherFamilyArgv(
        "agy --dangerously-skip-permissions --output-format stream-json 'Read /e.md'",
      ),
    ).toEqual({ kind: "launcher", family: "agy", dest: null });
    expect(
      classifyLauncherFamilyArgv(
        "agy -p 'x' --input-format stream-json --output-format stream-json",
        { payloadCwd: "/wt" },
      ),
    ).toEqual({ kind: "launcher", family: "agy", dest: "/wt" });
  });

  it("keeps agy --version and --help non-launcher after the flag widen (#7451)", () => {
    expect(classifyLauncherFamilyArgv("agy --version")).toEqual(NOT_LAUNCHER);
    expect(classifyLauncherFamilyArgv("agy --help")).toEqual(NOT_LAUNCHER);
  });
});

describe("agy critic seat (#7245)", () => {
  it("publishes pong and short-pointer argv pinned to gemini-4-hydrogen-high", () => {
    expect(AGY_CRITIC_MODEL).toBe("gemini-4-hydrogen-high");
    expect(AGY_PONG_ARGV).toContain("--model gemini-4-hydrogen-high");
    expect(AGY_PONG_ARGV).toContain("--print-timeout 2m");
    expect(AGY_PONG_ARGV).toContain("--sandbox");
    expect(AGY_SHORT_POINTER_ARGV).toContain("Read and follow <envelope-path>");
    expect(AGY_SHORT_POINTER_ARGV).toContain("--model gemini-4-hydrogen-high");
    expect(classifyLauncherFamilyArgv(AGY_PONG_ARGV, { payloadCwd: "/wt" })).toEqual({
      kind: "launcher",
      family: "agy",
      dest: "/wt",
    });
    expect(classifyLauncherFamilyArgv(AGY_SHORT_POINTER_ARGV, { payloadCwd: "/wt" })).toEqual({
      kind: "launcher",
      family: "agy",
      dest: "/wt",
    });
  });

  it("refuses paste-ready only for claimed family agy when path.agy resolves", () => {
    const refused = evaluatePanelSeatComposition({
      claimedSeats: [{ family: "agy", launcher: "paste-ready" }],
      path: { claude: true, codex: true, agy: true },
    });
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.code).toBe("paste-ready-first");

    const allowedAbsent = evaluatePanelSeatComposition({
      claimedSeats: [{ family: "agy", launcher: "paste-ready" }],
      path: { claude: true, codex: true, agy: false },
    });
    expect(allowedAbsent).toEqual({ ok: true });

    const otherFamilyUnchanged = evaluatePanelSeatComposition({
      claimedSeats: [{ family: "claude", launcher: "paste-ready" }],
      path: { claude: false, codex: false, agy: true },
    });
    expect(otherFamilyUnchanged).toEqual({ ok: true });
  });

  it("treats Claude, GPT, retiring 3.8, and non-pinned Hydrogen slugs as model misses; completion needs a comment URL", () => {
    expect(agyModelDischargesSeat("gemini-4-hydrogen-high")).toBe(true);
    expect(agyModelDischargesSeat("claude-sonnet-4-6")).toBe(false);
    expect(agyModelDischargesSeat("gpt-oss-120b-medium")).toBe(false);
    expect(agyModelDischargesSeat("gemini-4-hydrogen-medium")).toBe(false);
    expect(agyModelDischargesSeat("gemini-3.8-flash-high")).toBe(false);
    expect(
      evaluateAgySeatCompletion({
        model: "gemini-4-hydrogen-high",
        commentUrl: "https://github.com/deftai/directive/issues/7245#issuecomment-1",
      }),
    ).toEqual({ ok: true });
    expect(
      evaluateAgySeatCompletion({ model: "gemini-4-hydrogen-high", commentUrl: null }),
    ).toEqual({ ok: false, reason: "missing-comment-url" });
    expect(
      evaluateAgySeatCompletion({
        model: "gemini-4-hydrogen-medium",
        commentUrl: "https://github.com/deftai/directive/issues/7245#issuecomment-1",
      }),
    ).toEqual({ ok: false, reason: "model-miss" });
  });
});
