import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { decideHook, type HookDecision, type HookPolicySeams } from "./dispatcher.js";
import {
  appendShellObservation,
  buildShellObservation,
  SHELL_OBSERVATION_COMMAND_CAP,
  type ShellObservation,
  shellObservationPath,
} from "./shell-observe.js";

const READY_RITUAL = {
  code: 0,
  message: "OK session ritual gated tier is fresh.",
  tier: "gated",
  statePath: "/project/.deft/ritual-state.json",
  bypassed: false,
  wouldFailCode: null,
  posture: "mutation" as const,
  ritualStateRequired: true,
};

const EMPTY_SCOPE = {
  ready: false,
  path: null,
  message: "No active xBRIEF artifact was found under xbrief/active/",
};

function runShell(command: string): { decision: HookDecision; seen: ShellObservation[] } {
  const seen: ShellObservation[] = [];
  const seams = {
    verifyRitual: () => READY_RITUAL,
    inspectScope: () => EMPTY_SCOPE,
    sessionStart: () => ({ code: 0, stdout: "", stderr: "" }),
    shellObserve: (observation: ShellObservation) => seen.push(observation),
  } as unknown as HookPolicySeams;
  const decision = decideHook(
    {
      host: "claude",
      event: "tool.before",
      projectRoot: "/project",
      payload: { tool_name: "Bash", cwd: "/project", tool_input: { command } },
    },
    seams,
  );
  return { decision, seen };
}

describe("shell observation (#3438)", () => {
  it("records the fail-OPEN surface, which was previously invisible", () => {
    // These are allowed today and wrote no audit record before this existed.
    for (const command of [
      "git reset --hard",
      "git clean -fd",
      "git checkout .",
      "mv product.ts /tmp/",
      "bash -c 'rm apps/web/AGENTS.md'",
      "echo x > protected.file",
    ]) {
      const { decision, seen } = runShell(command);
      expect(decision.verdict).toBe("allow");
      expect(seen).toHaveLength(1);
      expect(seen[0]).toMatchObject({
        command,
        verdict: "allow",
        unrecognized: true,
        destKinds: [],
      });
    }
  });

  it("marks recognized-but-unresolvable dests distinctly from unrecognized ones", () => {
    const compound = runShell("cd x && rm y");
    expect(compound.decision.verdict).toBe("deny");
    expect(compound.seen[0]).toMatchObject({
      verdict: "deny",
      unrecognized: false,
      unresolvedDest: true,
      destKinds: ["rm"],
    });

    const simple = runShell("rm src/a.ts");
    expect(simple.decision.verdict).toBe("deny");
    expect(simple.seen[0]).toMatchObject({
      verdict: "deny",
      unrecognized: false,
      unresolvedDest: false,
      destKinds: ["rm"],
    });
  });

  it("records allows that pass the gate, not only denials", () => {
    const { decision, seen } = runShell("rm /other/repo/scratch.txt");
    expect(decision.verdict).toBe("allow");
    expect(seen[0]).toMatchObject({
      verdict: "allow",
      unrecognized: false,
      unresolvedDest: false,
      destKinds: ["rm"],
    });
  });

  it("emits exactly one observation per decision", () => {
    expect(runShell("rm a.ts && rm b.ts").seen).toHaveLength(1);
    expect(runShell("git status").seen).toHaveLength(1);
  });

  it("caps an oversized command and flags the truncation", () => {
    const observation = buildShellObservation({
      ts: "2026-08-21T00:00:00Z",
      host: "claude",
      toolName: "Bash",
      command: "rm ".concat("x".repeat(SHELL_OBSERVATION_COMMAND_CAP + 500)),
      verdict: "allow",
      code: "shell-op-unclassifiable",
      dests: [],
    });
    expect(observation.command).toHaveLength(SHELL_OBSERVATION_COMMAND_CAP);
    expect(observation.commandTruncated).toBe(true);
  });

  it("dedupes and sorts dest kinds", () => {
    const observation = buildShellObservation({
      ts: "2026-08-21T00:00:00Z",
      host: "claude",
      toolName: "Bash",
      command: "rm a && rmdir b && rm c",
      verdict: "deny",
      code: "scope-not-ready",
      dests: [
        { kind: "rmdir", path: "b" },
        { kind: "rm", path: "a" },
        { kind: "rm", path: "c" },
      ],
    });
    expect(observation.destKinds).toEqual(["rm", "rmdir"]);
  });

  it("appends JSONL under the project root", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-shell-observe-"));
    const observation = buildShellObservation({
      ts: "2026-08-21T00:00:00Z",
      host: "claude",
      toolName: "Bash",
      command: "git reset --hard",
      verdict: "allow",
      code: "shell-op-unclassifiable",
      dests: [],
    });
    expect(appendShellObservation(root, observation)).toBe(true);
    expect(appendShellObservation(root, observation)).toBe(true);
    const lines = readFileSync(shellObservationPath(root), "utf8").trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0] ?? "{}")).toMatchObject({
      schemaVersion: 1,
      command: "git reset --hard",
      unrecognized: true,
    });
  });

  it("never lets a write failure change the verdict", () => {
    // A path that cannot be written (projectRoot does not exist) must not throw
    // and must not alter enforcement.
    const observation = buildShellObservation({
      ts: "2026-08-21T00:00:00Z",
      host: "claude",
      toolName: "Bash",
      command: "rm x",
      verdict: "allow",
      code: "shell-op-unclassifiable",
      dests: [],
    });
    expect(() =>
      appendShellObservation(join(tmpdir(), "deft-observe-missing-root-xyz"), observation),
    ).not.toThrow();
  });
});
