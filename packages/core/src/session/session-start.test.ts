import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ResolveUserMdResult } from "../user-config/resolve-user-md.js";
import type { GitRunResult } from "./git.js";
import { ritualStatePath, runSessionStart, type SessionStartOptions } from "./session-start.js";

const temps: string[] = [];
afterEach(() => {
  for (const t of temps) rmSync(t, { recursive: true, force: true });
  temps.length = 0;
});

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "session-start-usermd-"));
  temps.push(root);
  return root;
}

/** Fake git runner: HEAD + toplevel resolve; everything else is a benign no-op. */
function fakeGit(root: string): (root: string, args: readonly string[]) => GitRunResult {
  return (_root, args) => {
    if (args[0] === "rev-parse" && args.includes("HEAD")) {
      return { code: 0, stdout: "deadbeef", stderr: "" };
    }
    if (args[0] === "rev-parse" && args.includes("--show-toplevel")) {
      return { code: 0, stdout: root, stderr: "" };
    }
    // No upstream / default branch -> defaultBranchSync returns a benign warning.
    return { code: 1, stdout: "", stderr: "" };
  };
}

function baseOptions(
  root: string,
  resolveUserMd: SessionStartOptions["resolveUserMd"],
): SessionStartOptions {
  return {
    writeHistory: false,
    runGit: fakeGit(root),
    verifyTools: () => ({ exitCode: 0 }),
    runTriageWelcome: () => ({ exitCode: 0 }),
    resolveUserMd,
  };
}

function userMdResult(overrides: Partial<ResolveUserMdResult>): ResolveUserMdResult {
  return {
    path: "/home/x/.config/deft/USER.md",
    rung: "platform-config",
    found: true,
    diagnostic: "USER.md resolved from platform config dir: /home/x/.config/deft/USER.md",
    searched: [],
    ...overrides,
  };
}

describe("runSessionStart — USER.md auto-resolution (#2271)", () => {
  it("resolves USER.md automatically and surfaces the path in output + payload", () => {
    const root = tempRoot();
    const resolved = userMdResult({
      path: join(root, ".deft", "USER.md"),
      rung: "workspace-local",
      found: true,
      diagnostic: "USER.md resolved from workspace-local config",
    });
    const result = runSessionStart(
      root,
      baseOptions(root, () => resolved),
    );
    expect(result.code).toBe(0);
    expect(result.lines.join("\n")).toContain("USER.md resolved (workspace-local)");
    expect(result.lines.join("\n")).toContain(join(root, ".deft", "USER.md"));
    const payload = result.payload as { user_md: ResolveUserMdResult };
    expect(payload.user_md.rung).toBe("workspace-local");
    expect(payload.user_md.found).toBe(true);
    expect(payload.user_md.path).toBe(join(root, ".deft", "USER.md"));
  });

  it("records which USER.md path was used in the alignment ritual step", () => {
    const root = tempRoot();
    const resolved = userMdResult({ path: "/opt/deft/USER.md", rung: "env-override" });
    const result = runSessionStart(
      root,
      baseOptions(root, () => resolved),
    );
    expect(result.code).toBe(0);
    const parsed: unknown = JSON.parse(readFileSync(ritualStatePath(root), "utf8"));
    // JSON.parse can return a top-level null without throwing; guard before any
    // property access so a malformed payload fails loud, not with a TypeError.
    expect(parsed).not.toBeNull();
    expect(typeof parsed).toBe("object");
    const state = parsed as { quick_steps: { alignment: { message: string } } };
    expect(state.quick_steps.alignment.message).toContain("Deft Directive active");
    expect(state.quick_steps.alignment.message).toContain("USER.md resolved (env-override)");
    expect(state.quick_steps.alignment.message).toContain("/opt/deft/USER.md");
  });

  it("degrades to a clear diagnostic (not a crash) when USER.md is absent everywhere", () => {
    const root = tempRoot();
    const resolved = userMdResult({
      path: "/home/x/.config/deft/USER.md",
      rung: "default",
      found: false,
      diagnostic: "no USER.md found; using defaults (searched: a, b)",
    });
    const result = runSessionStart(
      root,
      baseOptions(root, () => resolved),
    );
    expect(result.code).toBe(0);
    expect(result.lines.join("\n")).toContain("no USER.md found; using defaults");
    const payload = result.payload as { user_md: ResolveUserMdResult };
    expect(payload.user_md.found).toBe(false);
    expect(payload.user_md.rung).toBe("default");
  });

  it("uses the shared resolver by default (no seam) without throwing", () => {
    const root = tempRoot();
    const result = runSessionStart(root, {
      writeHistory: false,
      runGit: fakeGit(root),
      verifyTools: () => ({ exitCode: 0 }),
      runTriageWelcome: () => ({ exitCode: 0 }),
    });
    expect(result.code).toBe(0);
    const payload = result.payload as { user_md: ResolveUserMdResult };
    expect(payload.user_md).toBeDefined();
    expect(typeof payload.user_md.path).toBe("string");
  });
});
