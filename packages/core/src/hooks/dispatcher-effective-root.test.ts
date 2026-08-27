import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { defaultGitRunner } from "../session/git.js";
import { applyWorktreeOccupancy } from "../session/occupancy.js";
import {
  admitEffectiveHookRoot,
  decideHook,
  formatHookRootNote,
  type HookPolicySeams,
} from "./index.js";

const temps: string[] = [];
afterEach(() => {
  for (const t of temps.splice(0)) rmSync(t, { recursive: true, force: true });
});

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

const READY_SCOPE = {
  ready: true,
  path: "/project/xbrief/active/story.xbrief.json",
  message: "OK active scope",
};

function git(cwd: string, args: readonly string[]): void {
  execFileSync("git", [...args], { cwd, encoding: "utf8" });
}

function initRepo(dir: string): void {
  mkdirSync(dir, { recursive: true });
  git(dir, ["init", "-q"]);
  git(dir, ["config", "user.email", "t@t.dev"]);
  git(dir, ["config", "user.name", "t"]);
  git(dir, ["commit", "--allow-empty", "-q", "-m", "base"]);
}

function linkedFixture(): { primary: string; wtA: string; wtB: string; foreign: string } {
  const base = mkdtempSync(join(tmpdir(), "hook-3794-"));
  temps.push(base);
  const primary = join(base, "primary");
  const wtA = join(base, "wt-a");
  const wtB = join(base, "wt-b");
  const foreign = join(base, "foreign");
  initRepo(primary);
  git(primary, ["worktree", "add", "--detach", "-q", wtA]);
  git(primary, ["worktree", "add", "--detach", "-q", wtB]);
  initRepo(foreign);
  return { primary, wtA, wtB, foreign };
}

function recordingSeams(sessionId?: string): {
  ritualRoots: string[];
  scopeRoots: string[];
  seams: HookPolicySeams;
} {
  const ritualRoots: string[] = [];
  const scopeRoots: string[] = [];
  return {
    ritualRoots,
    scopeRoots,
    seams: {
      verifyRitual: (root) => {
        ritualRoots.push(resolve(root));
        return sessionId === undefined
          ? READY_RITUAL
          : { ...READY_RITUAL, boundSessionId: sessionId };
      },
      inspectScope: (root) => {
        scopeRoots.push(resolve(root));
        return READY_SCOPE;
      },
    },
  };
}

describe("effectiveRoot admission (#3794)", () => {
  it("admits a linked worktree and refuses a foreign repository", () => {
    const { primary, wtA, foreign } = linkedFixture();
    const admitted = admitEffectiveHookRoot(primary, join(wtA, "src", "app.ts"), defaultGitRunner);
    expect(admitted.foreign).toBe(false);
    expect(resolve(admitted.root)).toBe(resolve(wtA));

    const refused = admitEffectiveHookRoot(
      primary,
      join(foreign, "src", "app.ts"),
      defaultGitRunner,
    );
    expect(refused.foreign).toBe(true);
    expect(resolve(refused.root)).toBe(resolve(primary));
    expect(resolve(refused.candidate ?? "")).toBe(resolve(foreign));
  });

  it("falls back to payloadRoot when git cannot express a toplevel", () => {
    const payload = resolve("/tmp/payload-root");
    const failed = admitEffectiveHookRoot(payload, "/tmp/payload-root/src/a.ts", () => ({
      code: 1,
      stdout: "",
      stderr: "",
    }));
    expect(failed).toEqual({ root: payload, foreign: false, candidate: null });
    expect(
      admitEffectiveHookRoot(payload, null, () => ({ code: 1, stdout: "", stderr: "" })),
    ).toEqual({ root: payload, foreign: false, candidate: null });
  });

  it("refuses a resolved distinct toplevel when git-common-dir lookup fails", () => {
    const payload = resolve("/tmp/payload-root");
    const root = mkdtempSync(join(tmpdir(), "hook-3794-common-fail-"));
    temps.push(root);
    const admission = admitEffectiveHookRoot(payload, join(root, "src", "a.ts"), (_cwd, args) => {
      if (args.includes("--show-toplevel")) {
        return { code: 0, stdout: "/tmp/other-repo", stderr: "" };
      }
      return { code: 1, stdout: "", stderr: "" };
    });
    expect(admission.foreign).toBe(true);
    expect(resolve(admission.root)).toBe(payload);
  });
});

describe("direct-write occupancy/ritual follow the target worktree (#3794)", () => {
  it("refuses a foreign-repository target even when the payload lease matches", () => {
    const { primary, foreign } = linkedFixture();
    applyWorktreeOccupancy(primary, { sessionId: "owner", intent: "mutation" });
    const { ritualRoots, seams } = recordingSeams("owner");
    const decision = decideHook(
      {
        host: "grok",
        event: "tool.before",
        projectRoot: primary,
        payload: { toolName: "Write", file_path: join(foreign, "src", "app.ts") },
        environ: { DEFT_SESSION_ID: "owner" },
      },
      seams,
    );
    expect(decision).toMatchObject({ verdict: "deny", code: "foreign-repository-deny" });
    expect(decision.message).toContain("different Git repository");
    expect(ritualRoots).toEqual([]);
  });

  it("does not block a worktree write for an unrelated primary lease", () => {
    const { primary, wtA } = linkedFixture();
    applyWorktreeOccupancy(primary, { sessionId: "primary-owner", intent: "mutation" });
    const { ritualRoots, scopeRoots, seams } = recordingSeams("wt-owner");
    const decision = decideHook(
      {
        host: "grok",
        event: "tool.before",
        projectRoot: primary,
        payload: { toolName: "Write", file_path: join(wtA, "src", "app.ts") },
        environ: { DEFT_SESSION_ID: "wt-owner" },
      },
      seams,
    );
    expect(decision).toMatchObject({ verdict: "allow", code: "write-ready" });
    expect(ritualRoots).toEqual([resolve(wtA)]);
    expect(scopeRoots).toEqual([resolve(primary)]);
  });

  it("denies a foreign target-worktree lease and names both roots", () => {
    const { primary, wtA } = linkedFixture();
    applyWorktreeOccupancy(wtA, { sessionId: "wt-owner", intent: "mutation" });
    const { ritualRoots, scopeRoots, seams } = recordingSeams("other");
    const decision = decideHook(
      {
        host: "grok",
        event: "tool.before",
        projectRoot: primary,
        payload: { toolName: "Edit", file_path: join(wtA, "src", "app.ts") },
        environ: { DEFT_SESSION_ID: "other" },
      },
      seams,
    );
    expect(decision).toMatchObject({ verdict: "deny", code: "occupancy-occupied" });
    expect(decision.message).toContain("Worktree occupied by session wt-owner");
    expect(decision.message.toLowerCase()).toContain(resolve(primary).toLowerCase());
    expect(decision.message.toLowerCase()).toContain(resolve(wtA).toLowerCase());
    expect(decision.message).toContain("payloadRoot=");
    expect(decision.message).toContain("effectiveRoot=");
    expect(formatHookRootNote(resolve(primary), resolve(wtA))).toContain("payloadRoot=");
    expect(ritualRoots).toEqual([resolve(wtA)]);
    expect(scopeRoots).toEqual([]);
  });

  it("allows a matching target-worktree lease and inspects ritual there", () => {
    const { primary, wtA } = linkedFixture();
    applyWorktreeOccupancy(wtA, { sessionId: "wt-owner", intent: "mutation" });
    const { ritualRoots, scopeRoots, seams } = recordingSeams("wt-owner");
    const decision = decideHook(
      {
        host: "grok",
        event: "tool.before",
        projectRoot: primary,
        payload: { toolName: "Write", file_path: join(wtA, "src", "app.ts") },
        environ: { DEFT_SESSION_ID: "wt-owner" },
      },
      seams,
    );
    expect(decision).toMatchObject({ verdict: "allow", code: "write-ready" });
    expect(ritualRoots).toEqual([resolve(wtA)]);
    expect(scopeRoots).toEqual([resolve(primary)]);
  });

  it("pins the kill-switch to payloadRoot, not the write-target worktree", () => {
    const { primary, wtA } = linkedFixture();
    writeFileSync(join(wtA, ".deft-directive-disable"), "off\n", "utf8");
    const { seams } = recordingSeams("wt-owner");
    const stillEnforcing = decideHook(
      {
        host: "grok",
        event: "tool.before",
        projectRoot: primary,
        payload: { toolName: "Write", file_path: join(wtA, "src", "app.ts") },
        environ: { DEFT_SESSION_ID: "wt-owner" },
      },
      seams,
    );
    expect(stillEnforcing.code).not.toBe("directive-disabled");

    writeFileSync(join(primary, ".deft-directive-disable"), "off\n", "utf8");
    const disabled = decideHook(
      {
        host: "grok",
        event: "tool.before",
        projectRoot: primary,
        payload: { toolName: "Write", file_path: join(wtA, "src", "app.ts") },
        environ: { DEFT_SESSION_ID: "wt-owner" },
      },
      seams,
    );
    expect(disabled).toMatchObject({ verdict: "allow", code: "directive-disabled" });
  });

  it("keeps occupancy and ritual on the same effectiveRoot", () => {
    const { primary, wtA } = linkedFixture();
    applyWorktreeOccupancy(wtA, { sessionId: "wt-owner", intent: "mutation" });
    const { ritualRoots, seams } = recordingSeams("wt-owner");
    decideHook(
      {
        host: "grok",
        event: "tool.before",
        projectRoot: primary,
        payload: { toolName: "Write", file_path: join(wtA, "src", "app.ts") },
        environ: { DEFT_SESSION_ID: "wt-owner" },
      },
      seams,
    );
    expect(ritualRoots).toEqual([resolve(wtA)]);
    expect(ritualRoots).not.toContain(resolve(primary));
  });
});
