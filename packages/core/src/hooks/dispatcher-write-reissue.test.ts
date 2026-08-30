import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { applyWorktreeOccupancy } from "../session/occupancy.js";
import { decideHook, type HookPolicySeams } from "./index.js";
import {
  DIRECT_WRITE_HOOK_MATCHER,
  GROK_MUTATION_TOOL_CATALOG,
  isShellTool,
  matcherHasLiteralToken,
  SHELL_HOOK_MATCHER,
  SPAWN_HOOK_MATCHER,
} from "./tools.js";

const temps: string[] = [];
afterEach(() => {
  for (const t of temps.splice(0)) rmSync(t, { recursive: true, force: true });
});

const READY_RITUAL = {
  code: 0,
  message: "OK session ritual gated tier is fresh.",
  tier: "gated",
  statePath: "/ritual-state.json",
  bypassed: false,
  wouldFailCode: null,
  posture: "mutation" as const,
  ritualStateRequired: true,
};

function readySeams(): HookPolicySeams {
  return {
    verifyRitual: () => READY_RITUAL,
    inspectScope: () => ({ ready: true, path: "/story.xbrief.json", message: "OK" }),
    sessionStart: () => ({ code: 0, stdout: "", stderr: "" }),
    runningInsideDeftRepo: () => true,
    realpathLifecycleExecutionRoot: (path) => resolve(path),
  };
}
function occupiedRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "hook-reissue-"));
  temps.push(root);
  mkdirSync(join(root, "xbrief", "active"), { recursive: true });
  mkdirSync(join(root, "src"), { recursive: true });
  applyWorktreeOccupancy(root, { sessionId: "owner", intent: "mutation" });
  return root;
}

describe("shell write reissue (#3983 / #3987)", () => {
  it("classifies run_terminal_command as a shell tool and deposits it in the matcher", () => {
    expect(isShellTool("run_terminal_command")).toBe(true);
    expect(matcherHasLiteralToken(SHELL_HOOK_MATCHER, "run_terminal_command")).toBe(true);
  });

  it("fails closed when a known Grok mutation tool is missing from deposited matchers", () => {
    for (const name of GROK_MUTATION_TOOL_CATALOG.directWrite) {
      expect(matcherHasLiteralToken(DIRECT_WRITE_HOOK_MATCHER, name)).toBe(true);
    }
    for (const name of GROK_MUTATION_TOOL_CATALOG.shell) {
      expect(matcherHasLiteralToken(SHELL_HOOK_MATCHER, name)).toBe(true);
    }
    for (const name of GROK_MUTATION_TOOL_CATALOG.spawn) {
      expect(matcherHasLiteralToken(SPAWN_HOOK_MATCHER, name)).toBe(true);
    }
  });
  it("denies Write occupancy and the same in-repo path reissued through run_terminal_command", () => {
    const root = occupiedRoot();
    const dest = join(root, "src", "app.ts");
    const write = decideHook(
      {
        host: "grok",
        event: "tool.before",
        projectRoot: root,
        payload: { tool_name: "Write", tool_input: { file_path: dest } },
        environ: { DEFT_SESSION_ID: "other" },
      },
      readySeams(),
    );
    expect(write).toMatchObject({ verdict: "deny", code: "occupancy-occupied" });
    const setContent = decideHook(
      {
        host: "grok",
        event: "tool.before",
        projectRoot: root,
        payload: {
          tool_name: "run_terminal_command",
          tool_input: { command: "Set-Content -Path src/app.ts -Value x" },
        },
        environ: { DEFT_SESSION_ID: "other" },
      },
      readySeams(),
    );
    expect(setContent).toMatchObject({ verdict: "deny", code: "occupancy-occupied" });
    const DQ = String.fromCharCode(34);
    const AQ = String.fromCharCode(39);
    const py =
      "python -c " +
      DQ +
      "from pathlib import Path; Path(" +
      AQ +
      "src/app.ts" +
      AQ +
      ").write_text(" +
      AQ +
      "x" +
      AQ +
      ")" +
      DQ;
    const pathlib = decideHook(
      {
        host: "grok",
        event: "tool.before",
        projectRoot: root,
        payload: { tool_name: "run_terminal_command", tool_input: { command: py } },
        environ: { DEFT_SESSION_ID: "other" },
      },
      readySeams(),
    );
    expect(pathlib).toMatchObject({ verdict: "deny", code: "occupancy-occupied" });
  });
  it("allows git status, occupancy:release, and an OS-temp pathlib write", () => {
    const root = occupiedRoot();
    const env = { DEFT_SESSION_ID: "other" };
    const status = decideHook(
      {
        host: "grok",
        event: "tool.before",
        projectRoot: root,
        payload: {
          tool_name: "run_terminal_command",
          tool_input: { command: "git status --short --branch" },
        },
        environ: env,
      },
      readySeams(),
    );
    expect(status.verdict).toBe("allow");
    const release = decideHook(
      {
        host: "grok",
        event: "tool.before",
        projectRoot: root,
        payload: {
          tool_name: "run_terminal_command",
          tool_input: { command: "deft occupancy:release --session-id=owner" },
        },
        environ: env,
      },
      readySeams(),
    );
    expect(release.verdict).toBe("allow");
    const tmp = join(tmpdir(), "body.md");
    const tempWrite = decideHook(
      {
        host: "grok",
        event: "tool.before",
        projectRoot: root,
        payload: {
          tool_name: "run_terminal_command",
          tool_input: { command: "Set-Content -Path " + tmp + " -Value x" },
        },
        environ: env,
      },
      readySeams(),
    );
    expect(tempWrite.verdict).toBe("allow");
  });
  it("allows echo of a Set-Content spelling on an occupied tree", () => {
    const root = occupiedRoot();
    const decision = decideHook(
      {
        host: "grok",
        event: "tool.before",
        projectRoot: root,
        payload: {
          tool_name: "run_terminal_command",
          tool_input: { command: "echo Set-Content -Path src/app.ts" },
        },
        environ: { DEFT_SESSION_ID: "other" },
      },
      readySeams(),
    );
    expect(decision.verdict).toBe("allow");
  });
  it("denies compound cd plus Set-Content as unprovable", () => {
    const root = occupiedRoot();
    const decision = decideHook(
      {
        host: "grok",
        event: "tool.before",
        projectRoot: root,
        payload: {
          tool_name: "run_terminal_command",
          tool_input: { command: "cd src && Set-Content -Path app.ts -Value x" },
        },
        environ: { DEFT_SESSION_ID: "owner" },
      },
      readySeams(),
    );
    expect(decision).toMatchObject({ verdict: "deny", code: "scope-not-ready" });
  });
  it("allows compound OS-temp WriteAllText on an occupied tree", () => {
    const root = occupiedRoot();
    const AQ = String.fromCharCode(39);
    const tmp = join(tmpdir(), "body.md");
    const decision = decideHook(
      {
        host: "grok",
        event: "tool.before",
        projectRoot: root,
        payload: {
          tool_name: "run_terminal_command",
          tool_input: {
            command:
              "echo x; [System.IO.File]::WriteAllText(" +
              AQ +
              tmp +
              AQ +
              ", " +
              AQ +
              "x" +
              AQ +
              ")",
          },
        },
        environ: { DEFT_SESSION_ID: "other" },
      },
      readySeams(),
    );
    expect(decision.verdict).toBe("allow");
  });
  it("allows a python write_text method reference on an occupied tree", () => {
    const root = occupiedRoot();
    const DQ2 = String.fromCharCode(34);
    const AQ2 = String.fromCharCode(39);
    const py =
      "python -c " + DQ2 + "print(Path(" + AQ2 + "src/app.ts" + AQ2 + ").write_text)" + DQ2;
    const decision = decideHook(
      {
        host: "grok",
        event: "tool.before",
        projectRoot: root,
        payload: { tool_name: "run_terminal_command", tool_input: { command: py } },
        environ: { DEFT_SESSION_ID: "other" },
      },
      readySeams(),
    );
    expect(decision.verdict).toBe("allow");
  });
  it("allows relative WriteAllText after cd to env TEMP", () => {
    const root = occupiedRoot();
    const decision = decideHook(
      {
        host: "grok",
        event: "tool.before",
        projectRoot: root,
        payload: {
          tool_name: "run_terminal_command",
          tool_input: { command: "cd $env:TEMP; [System.IO.File]::WriteAllText('body.md', 'x')" },
        },
        environ: { DEFT_SESSION_ID: "other" },
      },
      readySeams(),
    );
    expect(decision.verdict).toBe("allow");
  });
});
