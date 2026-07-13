import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ResolveUserMdResult } from "../user-config/resolve-user-md.js";
import { ritualStatePath } from "./ritual-sentinel.js";
import { READ_ONLY_POSTURE, READ_ONLY_RESULT_MESSAGE, runSessionStart } from "./session-start.js";

const temps: string[] = [];
afterEach(() => {
  for (const t of temps) rmSync(t, { recursive: true, force: true });
  temps.length = 0;
});

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "session-read-only-"));
  temps.push(root);
  return root;
}

function userMdResult(overrides: Partial<ResolveUserMdResult> = {}): ResolveUserMdResult {
  return {
    path: "/home/x/.config/deft/USER.md",
    rung: "platform-config",
    found: true,
    diagnostic: "USER.md resolved from platform config dir",
    searched: [],
    ...overrides,
  };
}

describe("runSessionStart read-only posture (#2176)", () => {
  it("records alignment only and writes no ritual-state", () => {
    const root = tempRoot();
    const result = runSessionStart(root, {
      posture: READ_ONLY_POSTURE,
      resolveUserMd: () => userMdResult({ path: "/opt/USER.md", rung: "env-override" }),
    });
    expect(result.code).toBe(0);
    expect(result.payload.posture).toBe(READ_ONLY_POSTURE);
    expect(result.payload.state_path).toBeNull();
    expect(result.payload.message).toBe(READ_ONLY_RESULT_MESSAGE);
    expect(existsSync(ritualStatePath(root))).toBe(false);
    expect(result.lines.join("\n")).toContain("Deft Directive active");
    expect(result.lines.join("\n")).toContain("USER.md resolved (env-override)");
    expect(result.lines.join("\n")).not.toContain("[deft policy]");
    expect(result.lines.join("\n")).not.toContain("[welcome]");
  });

  it("mutation posture still writes ritual-state by default", () => {
    const root = tempRoot();
    const result = runSessionStart(root, {
      writeHistory: false,
      resolveUserMd: () => userMdResult(),
      verifyTools: () => ({ exitCode: 0 }),
      runTriageWelcome: () => ({ exitCode: 0 }),
      runGit: (_r, args) => {
        if (args[0] === "rev-parse" && args.includes("HEAD")) {
          return { code: 0, stdout: "abc123", stderr: "" };
        }
        if (args[0] === "rev-parse" && args.includes("--show-toplevel")) {
          return { code: 0, stdout: root, stderr: "" };
        }
        return { code: 1, stdout: "", stderr: "" };
      },
    });
    expect(result.code).toBe(0);
    expect(result.payload.posture).toBeUndefined();
    expect(existsSync(ritualStatePath(root))).toBe(true);
  });
});
