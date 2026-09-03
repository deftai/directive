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
import { isInRepoShellWritePath } from "./shell-write-targets.js";

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

/**
 * The swarm layout: a linked worktree under `<primary>/.deft-scratch/worktrees/`.
 * Relative to the primary every file in it reads as an assist-scratch path, and
 * it is inside the payload root so the #2885 outside-root skip does not apply.
 */
function nestedWorktreeFixture(): { primary: string; nested: string } {
  const base = mkdtempSync(join(tmpdir(), "hook-3794-nested-"));
  temps.push(base);
  const primary = join(base, "primary");
  initRepo(primary);
  const nested = join(primary, ".deft-scratch", "worktrees", "story");
  mkdirSync(join(primary, ".deft-scratch", "worktrees"), { recursive: true });
  git(primary, ["worktree", "add", "--detach", "-q", nested]);
  return { primary, nested };
}

/** Ready only for `readyRoot`; every other tree reports no active scope. */
function scopeSeams(readyRoot: string | null): {
  scopeRoots: string[];
  seams: HookPolicySeams;
} {
  const scopeRoots: string[] = [];
  return {
    scopeRoots,
    seams: {
      verifyRitual: () => ({ ...READY_RITUAL, boundSessionId: "owner" }),
      inspectScope: (root) => {
        scopeRoots.push(resolve(root));
        if (readyRoot !== null && resolve(root) === resolve(readyRoot)) return READY_SCOPE;
        return { ready: false, path: null, message: "no active scope xBRIEF" };
      },
    },
  };
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
    expect(failed).toEqual({ root: payload, foreign: false, candidate: null, refusal: null });
    expect(
      admitEffectiveHookRoot(payload, null, () => ({ code: 1, stdout: "", stderr: "" })),
    ).toEqual({ root: payload, foreign: false, candidate: null, refusal: null });
  });

  it("falls back when payloadRoot is not a Git repository, so containment never applied", () => {
    const payload = resolve("/tmp/payload-root");
    const root = mkdtempSync(join(tmpdir(), "hook-3794-common-fail-"));
    temps.push(root);
    const admission = admitEffectiveHookRoot(payload, join(root, "src", "a.ts"), (_cwd, args) => {
      if (args.includes("--show-toplevel")) {
        return { code: 0, stdout: "/tmp/other-repo", stderr: "" };
      }
      // Neither root can answer --git-common-dir: payloadRoot is not a repo.
      return { code: 1, stdout: "", stderr: "" };
    });
    expect(admission.foreign).toBe(false);
    expect(admission.refusal).toBeNull();
    expect(resolve(admission.root)).toBe(payload);
    expect(resolve(admission.candidate ?? "")).toBe(resolve("/tmp/other-repo"));
  });

  it("fails closed when payloadRoot is a repository but target identity is unreadable", () => {
    const { primary } = linkedFixture();
    const other = mkdtempSync(join(tmpdir(), "hook-3794-unproven-"));
    temps.push(other);
    const admission = admitEffectiveHookRoot(primary, join(other, "src", "a.ts"), (cwd, args) => {
      if (args.includes("--show-toplevel")) {
        return { code: 0, stdout: other, stderr: "" };
      }
      // payloadRoot answers; the resolved target does not.
      if (args.includes("--git-common-dir")) {
        return resolve(cwd) === resolve(primary)
          ? defaultGitRunner(cwd, args)
          : { code: 128, stdout: "", stderr: "fatal: unreadable" };
      }
      return defaultGitRunner(cwd, args);
    });
    expect(admission.foreign).toBe(true);
    expect(admission.refusal).toBe("unproven-identity");
    expect(resolve(admission.root)).toBe(resolve(primary));
  });

  it("reports a proven separate repository as foreign-repository", () => {
    const { primary, foreign } = linkedFixture();
    const admission = admitEffectiveHookRoot(
      primary,
      join(foreign, "src", "app.ts"),
      defaultGitRunner,
    );
    expect(admission.refusal).toBe("foreign-repository");
  });
});

describe("direct-write occupancy/ritual follow the target worktree (#3794)", () => {
  it("refuses a foreign-repository target even when the payload lease matches", () => {
    const { primary, foreign } = linkedFixture();
    applyWorktreeOccupancy(primary, {
      primaryClaimException: "operator-default-branch",
      sessionId: "owner",
      intent: "mutation",
    });
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
    applyWorktreeOccupancy(primary, {
      primaryClaimException: "operator-default-branch",
      sessionId: "primary-owner",
      intent: "mutation",
    });
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
    expect(scopeRoots).toEqual([resolve(wtA)]);
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
    expect(scopeRoots).toEqual([resolve(wtA)]);
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

  it("refuses ApplyPatch when declared path and patch body land in different worktrees", () => {
    const { primary, wtA, wtB } = linkedFixture();
    const { ritualRoots, seams } = recordingSeams("owner");
    const decision = decideHook(
      {
        host: "grok",
        event: "tool.before",
        projectRoot: primary,
        payload: {
          tool_name: "ApplyPatch",
          tool_input: {
            path: join(wtA, "src", "a.ts"),
            patch:
              "*** Begin Patch\n*** Update File: " +
              join(wtB, "src", "b.ts") +
              "\n+x\n*** End Patch",
          },
        },
        environ: { DEFT_SESSION_ID: "owner" },
      },
      seams,
    );
    expect(decision).toMatchObject({ verdict: "deny", code: "foreign-repository-deny" });
    expect(decision.message).toContain("span more than one Git worktree");
    expect(ritualRoots).toEqual([]);
  });

  it("refuses an ApplyPatch whose `Move to` destination lands in another worktree", () => {
    const { primary, wtA, wtB } = linkedFixture();
    const { ritualRoots, seams } = recordingSeams("owner");
    const decision = decideHook(
      {
        host: "grok",
        event: "tool.before",
        projectRoot: primary,
        payload: {
          tool_name: "ApplyPatch",
          tool_input: {
            path: join(wtA, "src", "a.ts"),
            patch:
              "*** Begin Patch\n*** Update File: " +
              join(wtA, "src", "a.ts") +
              "\n*** Move to: " +
              join(wtB, "src", "a.ts") +
              "\n+x\n*** End Patch",
          },
        },
        environ: { DEFT_SESSION_ID: "owner" },
      },
      seams,
    );
    expect(decision).toMatchObject({ verdict: "deny", code: "foreign-repository-deny" });
    expect(decision.message).toContain("span more than one Git worktree");
    expect(ritualRoots).toEqual([]);
  });

  it("refuses an ApplyPatch whose `Move to` destination leaves the repository", () => {
    const { primary, wtA, foreign } = linkedFixture();
    const { ritualRoots, seams } = recordingSeams("owner");
    const decision = decideHook(
      {
        host: "grok",
        event: "tool.before",
        projectRoot: primary,
        payload: {
          tool_name: "ApplyPatch",
          tool_input: {
            path: join(wtA, "src", "a.ts"),
            patch:
              "*** Begin Patch\n*** Update File: " +
              join(wtA, "src", "a.ts") +
              "\n*** Move to: " +
              join(foreign, "src", "a.ts") +
              "\n+x\n*** End Patch",
          },
        },
        environ: { DEFT_SESSION_ID: "owner" },
      },
      seams,
    );
    expect(decision).toMatchObject({ verdict: "deny", code: "foreign-repository-deny" });
    expect(decision.message).toContain("different Git repository");
    expect(ritualRoots).toEqual([]);
  });

  it("admits ApplyPatch when declared path and patch body share a worktree", () => {
    const { primary, wtA } = linkedFixture();
    applyWorktreeOccupancy(wtA, { sessionId: "wt-owner", intent: "mutation" });
    const { ritualRoots, seams } = recordingSeams("wt-owner");
    const decision = decideHook(
      {
        host: "grok",
        event: "tool.before",
        projectRoot: primary,
        payload: {
          tool_name: "ApplyPatch",
          tool_input: {
            path: join(wtA, "src", "a.ts"),
            patch:
              "*** Begin Patch\n*** Update File: " +
              join(wtA, "src", "b.ts") +
              "\n+x\n*** End Patch",
          },
        },
        environ: { DEFT_SESSION_ID: "wt-owner" },
      },
      seams,
    );
    expect(decision).toMatchObject({ verdict: "allow", code: "write-ready" });
    expect(ritualRoots).toEqual([resolve(wtA)]);
  });
});

describe("active scope follows the write target worktree (#3794 commit 2)", () => {
  it("denies a nested-worktree write when only the primary has an active scope", () => {
    const { primary, nested } = nestedWorktreeFixture();
    const { scopeRoots, seams } = scopeSeams(primary);
    const decision = decideHook(
      {
        host: "grok",
        event: "tool.before",
        projectRoot: primary,
        payload: { toolName: "Write", file_path: join(nested, "packages", "core", "a.ts") },
        environ: { DEFT_SESSION_ID: "owner" },
      },
      seams,
    );
    expect(decision).toMatchObject({ verdict: "deny", code: "scope-not-ready" });
    expect(scopeRoots).toEqual([resolve(nested)]);
  });

  it("names the tree the recovery must run in when the two roots differ", () => {
    const { primary, nested } = nestedWorktreeFixture();
    const { seams } = scopeSeams(primary);
    const decision = decideHook(
      {
        host: "grok",
        event: "tool.before",
        projectRoot: primary,
        payload: { toolName: "Write", file_path: join(nested, "packages", "core", "a.ts") },
        environ: { DEFT_SESSION_ID: "owner" },
      },
      seams,
    );
    expect(decision.code).toBe("scope-not-ready");
    // Both concrete paths, and which of them scope:activate has to run in.
    expect(decision.message).toContain(`Active scope was read from ${resolve(nested)}`);
    expect(decision.message).toContain(`rather than in ${resolve(primary)}`);
    expect(decision.message).toContain(formatHookRootNote(resolve(primary), resolve(nested)));
  });

  it("omits the extra root sentence when both roots are the same tree", () => {
    const { primary } = nestedWorktreeFixture();
    const { seams } = scopeSeams(null);
    const decision = decideHook(
      {
        host: "grok",
        event: "tool.before",
        projectRoot: primary,
        payload: { toolName: "Write", file_path: join(primary, "packages", "core", "a.ts") },
        environ: { DEFT_SESSION_ID: "owner" },
      },
      seams,
    );
    expect(decision.code).toBe("scope-not-ready");
    expect(decision.message).not.toContain("Active scope was read from");
    expect(decision.message).toContain(formatHookRootNote(resolve(primary), resolve(primary)));
  });

  it("allows a nested-worktree write against that worktree's own active scope", () => {
    const { primary, nested } = nestedWorktreeFixture();
    const { scopeRoots, seams } = scopeSeams(nested);
    const decision = decideHook(
      {
        host: "grok",
        event: "tool.before",
        projectRoot: primary,
        payload: { toolName: "Write", file_path: join(nested, "packages", "core", "a.ts") },
        environ: { DEFT_SESSION_ID: "owner" },
      },
      seams,
    );
    expect(decision).toMatchObject({ verdict: "allow", code: "write-ready" });
    expect(scopeRoots).toEqual([resolve(nested)]);
  });

  it("exempts a proposed-lifecycle write inside the worktree that hosts it", () => {
    const { primary, nested } = nestedWorktreeFixture();
    const { seams } = scopeSeams(null);
    const decision = decideHook(
      {
        host: "grok",
        event: "tool.before",
        projectRoot: primary,
        payload: {
          toolName: "Write",
          file_path: join(nested, "xbrief", "proposed", "story.xbrief.json"),
        },
        environ: { DEFT_SESSION_ID: "owner" },
      },
      seams,
    );
    expect(decision).toMatchObject({ verdict: "allow", code: "write-propose-ready" });
  });

  it("keeps the #2885 outside-root skip measured from payloadRoot", () => {
    const { primary, wtA } = linkedFixture();
    const { seams } = scopeSeams(null);
    const decision = decideHook(
      {
        host: "grok",
        event: "tool.before",
        projectRoot: primary,
        payload: { toolName: "Write", file_path: join(wtA, "packages", "core", "a.ts") },
        environ: { DEFT_SESSION_ID: "owner" },
      },
      seams,
    );
    // wtA is a sibling of the payload root, so the carve-out still skips the deny.
    expect(decision).toMatchObject({ verdict: "allow", code: "write-ready" });
  });
});

describe("assist-scratch reclassification (#3794 commit 2)", () => {
  const assistEnv = { DEFT_SESSION_ID: "owner", DEFT_SESSION_POSTURE: "assist" };

  it("no longer treats worktree product files as assist scratch", () => {
    const { primary, nested } = nestedWorktreeFixture();
    const { scopeRoots, seams } = scopeSeams(null);
    const decision = decideHook(
      {
        host: "grok",
        event: "tool.before",
        projectRoot: primary,
        payload: { toolName: "Write", file_path: join(nested, "packages", "core", "a.ts") },
        environ: assistEnv,
      },
      seams,
    );
    expect(decision.code).not.toBe("write-assist-scratch-ready");
    expect(decision).toMatchObject({ verdict: "deny", code: "scope-not-ready" });
    expect(scopeRoots).toEqual([resolve(nested)]);
  });

  it("still allows genuine scratch inside the worktree", () => {
    const { primary, nested } = nestedWorktreeFixture();
    const { scopeRoots, seams } = scopeSeams(null);
    const decision = decideHook(
      {
        host: "grok",
        event: "tool.before",
        projectRoot: primary,
        payload: { toolName: "Write", file_path: join(nested, ".deft-scratch", "notes.md") },
        environ: assistEnv,
      },
      seams,
    );
    expect(decision).toMatchObject({ verdict: "allow", code: "write-assist-scratch-ready" });
    expect(scopeRoots).toEqual([]);
  });

  it("still allows genuine scratch in the primary checkout", () => {
    const { primary } = nestedWorktreeFixture();
    const { seams } = scopeSeams(null);
    const decision = decideHook(
      {
        host: "grok",
        event: "tool.before",
        projectRoot: primary,
        payload: { toolName: "Write", file_path: join(primary, ".deft-scratch", "notes.md") },
        environ: assistEnv,
      },
      seams,
    );
    expect(decision).toMatchObject({ verdict: "allow", code: "write-assist-scratch-ready" });
  });
});

describe("story file_scope relativises against the write target worktree (#3794 commit 2)", () => {
  function fenceSeams(readyRoot: string): {
    fenceRoots: string[];
    seams: HookPolicySeams;
  } {
    const fenceRoots: string[] = [];
    const base = scopeSeams(readyRoot);
    return {
      fenceRoots,
      seams: {
        ...base.seams,
        loadStoryWriteFence: (root) => {
          fenceRoots.push(resolve(root));
          return { fileScope: ["packages/**"], denyPaths: [] };
        },
      },
    };
  }

  it("matches an in-fence worktree path instead of its payload-relative prefix", () => {
    const { primary, nested } = nestedWorktreeFixture();
    const { fenceRoots, seams } = fenceSeams(nested);
    const decision = decideHook(
      {
        host: "grok",
        event: "tool.before",
        projectRoot: primary,
        payload: { toolName: "Write", file_path: join(nested, "packages", "core", "a.ts") },
        environ: { DEFT_SESSION_ID: "owner" },
      },
      seams,
    );
    expect(decision).toMatchObject({ verdict: "allow", code: "write-ready" });
    expect(fenceRoots).toEqual([resolve(nested)]);
  });

  it("still denies an out-of-fence worktree path, naming the tree it relativised against", () => {
    const { primary, nested } = nestedWorktreeFixture();
    const { seams } = fenceSeams(nested);
    const decision = decideHook(
      {
        host: "grok",
        event: "tool.before",
        projectRoot: primary,
        payload: { toolName: "Write", file_path: join(nested, "docs", "note.md") },
        environ: { DEFT_SESSION_ID: "owner" },
      },
      seams,
    );
    expect(decision.verdict).toBe("deny");
    expect(decision.message).toContain(formatHookRootNote(resolve(primary), resolve(nested)));
  });

  it("leaves a same-root fence deny unannotated", () => {
    const { primary } = nestedWorktreeFixture();
    const { seams } = fenceSeams(primary);
    const decision = decideHook(
      {
        host: "grok",
        event: "tool.before",
        projectRoot: primary,
        payload: { toolName: "Write", file_path: join(primary, "docs", "note.md") },
        environ: { DEFT_SESSION_ID: "owner" },
      },
      seams,
    );
    expect(decision.verdict).toBe("deny");
    expect(decision.message).not.toContain("payloadRoot=");
  });
});

/** A directory inside no Git working tree, for the no-toplevel fallback (#4013). */
function outsideDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "hook-4013-outside-"));
  temps.push(dir);
  return dir;
}

/**
 * Characterization of the published no-toplevel case (#4013). The fallback is
 * deliberate (#3794), so these lock current behaviour rather than propose a
 * narrowing: content/docs/hook-root-admission.md.
 */
describe("no-toplevel targets keep payloadRoot gating (#4013)", () => {
  it("admits a target with no Git toplevel against payloadRoot and names no candidate", () => {
    const { primary } = linkedFixture();
    const admission = admitEffectiveHookRoot(
      primary,
      join(outsideDir(), "nested", "note.md"),
      defaultGitRunner,
    );
    expect(resolve(admission.root)).toBe(resolve(primary));
    expect(admission.foreign).toBe(false);
    expect(admission.candidate).toBeNull();
    expect(admission.refusal).toBeNull();
  });

  it("denies a no-toplevel direct write under a foreign payload-root lease", () => {
    const { primary } = linkedFixture();
    applyWorktreeOccupancy(primary, {
      primaryClaimException: "operator-default-branch",
      sessionId: "payload-owner",
      intent: "mutation",
    });
    const { ritualRoots, scopeRoots, seams } = recordingSeams("other");
    const decision = decideHook(
      {
        host: "grok",
        event: "tool.before",
        projectRoot: primary,
        payload: { toolName: "Write", file_path: join(outsideDir(), "note.md") },
        environ: { DEFT_SESSION_ID: "other" },
      },
      seams,
    );
    expect(decision).toMatchObject({ verdict: "deny", code: "occupancy-occupied" });
    expect(decision.message).toContain("Worktree occupied by session payload-owner");
    // Both roots are the payload root: admission contributed no candidate.
    expect(decision.message).toContain(formatHookRootNote(resolve(primary), resolve(primary)));
    // Ritual resolves through the payload root; scope is not reached on a lease deny.
    expect(ritualRoots).toEqual([resolve(primary)]);
    expect(scopeRoots).toEqual([]);
  });

  it("allows the same target for the payload root's own owner and skips the scope deny", () => {
    const { primary } = linkedFixture();
    applyWorktreeOccupancy(primary, {
      primaryClaimException: "operator-default-branch",
      sessionId: "owner",
      intent: "mutation",
    });
    const { scopeRoots, seams } = scopeSeams(null);
    const decision = decideHook(
      {
        host: "grok",
        event: "tool.before",
        projectRoot: primary,
        payload: { toolName: "Write", file_path: join(outsideDir(), "note.md") },
        environ: { DEFT_SESSION_ID: "owner" },
      },
      seams,
    );
    expect(decision).toMatchObject({ verdict: "allow", code: "write-ready" });
    // Active scope is inspected against the payload root, and its not-ready deny
    // is skipped by the #2885 outside-root carve-out rather than never asked.
    expect(scopeRoots).toEqual([resolve(primary)]);
    expect(decision.scopePath).toBeNull();
  });

  it("never reaches root admission for a generic server-prefixed MCP name", () => {
    const { primary } = linkedFixture();
    applyWorktreeOccupancy(primary, {
      primaryClaimException: "operator-default-branch",
      sessionId: "payload-owner",
      intent: "mutation",
    });
    const target = join(outsideDir(), "note.md");
    const { ritualRoots, scopeRoots, seams } = recordingSeams("other");
    const mcp = decideHook(
      {
        host: "grok",
        event: "tool.before",
        projectRoot: primary,
        payload: { toolName: "tasks__search_replace", file_path: target },
        environ: { DEFT_SESSION_ID: "other" },
      },
      seams,
    );
    expect(mcp).toMatchObject({ verdict: "allow", code: "shell-op-unclassifiable" });
    expect(ritualRoots).toEqual([]);
    expect(scopeRoots).toEqual([]);

    // The bare direct-write spelling of the same tool does consult admission.
    const bare = decideHook(
      {
        host: "grok",
        event: "tool.before",
        projectRoot: primary,
        payload: { toolName: "search_replace", file_path: target },
        environ: { DEFT_SESSION_ID: "other" },
      },
      seams,
    );
    expect(bare).toMatchObject({ verdict: "deny", code: "occupancy-occupied" });
    expect(ritualRoots).toEqual([resolve(primary)]);
  });

  it("excludes an out-of-repo shell write dest from the reissue path", () => {
    const { primary } = linkedFixture();
    applyWorktreeOccupancy(primary, {
      primaryClaimException: "operator-default-branch",
      sessionId: "payload-owner",
      intent: "mutation",
    });
    const outsideDest = join(outsideDir(), "note.md");
    expect(isInRepoShellWritePath(resolve(primary), outsideDest)).toBe(false);
    const { ritualRoots, scopeRoots, seams } = recordingSeams("other");
    const outsideWrite = decideHook(
      {
        host: "grok",
        event: "tool.before",
        projectRoot: primary,
        payload: {
          tool_name: "run_terminal_command",
          tool_input: { command: `Set-Content -Path ${outsideDest} -Value x` },
        },
        environ: { DEFT_SESSION_ID: "other" },
      },
      seams,
    );
    expect(outsideWrite.verdict).toBe("allow");
    expect(ritualRoots).toEqual([]);
    expect(scopeRoots).toEqual([]);

    // Same command, in-repo dest: reissued into the mutation gates and denied.
    // The dest is absolute because a relative one would resolve against the test
    // process cwd, not the payload root — the #4023 canonicalization limitation.
    const inRepoWrite = decideHook(
      {
        host: "grok",
        event: "tool.before",
        projectRoot: primary,
        payload: {
          tool_name: "run_terminal_command",
          tool_input: {
            command: `Set-Content -Path ${join(primary, "src", "app.ts")} -Value x`,
          },
        },
        environ: { DEFT_SESSION_ID: "other" },
      },
      seams,
    );
    expect(inRepoWrite).toMatchObject({ verdict: "deny", code: "occupancy-occupied" });
    expect(ritualRoots).toEqual([resolve(primary)]);
  });

  it("keeps worktree-span when a no-toplevel member joins a linked-worktree member", () => {
    const { primary, wtA } = linkedFixture();
    const { ritualRoots, seams } = recordingSeams("owner");
    const decision = decideHook(
      {
        host: "grok",
        event: "tool.before",
        projectRoot: primary,
        payload: {
          tool_name: "ApplyPatch",
          tool_input: {
            path: join(wtA, "src", "a.ts"),
            patch:
              "*** Begin Patch\n*** Update File: " +
              join(outsideDir(), "note.md") +
              "\n+x\n*** End Patch",
          },
        },
        environ: { DEFT_SESSION_ID: "owner" },
      },
      seams,
    );
    expect(decision).toMatchObject({ verdict: "deny", code: "foreign-repository-deny" });
    expect(decision.message).toContain("span more than one Git worktree");
    expect(ritualRoots).toEqual([]);
  });

  it("collapses a no-toplevel member onto the payload root it already contributes", () => {
    const { primary } = linkedFixture();
    applyWorktreeOccupancy(primary, {
      primaryClaimException: "operator-default-branch",
      sessionId: "owner",
      intent: "mutation",
    });
    const { ritualRoots, seams } = recordingSeams("owner");
    const decision = decideHook(
      {
        host: "grok",
        event: "tool.before",
        projectRoot: primary,
        payload: {
          tool_name: "ApplyPatch",
          tool_input: {
            path: join(primary, "src", "a.ts"),
            patch:
              "*** Begin Patch\n*** Update File: " +
              join(outsideDir(), "note.md") +
              "\n+x\n*** End Patch",
          },
        },
        environ: { DEFT_SESSION_ID: "owner" },
      },
      seams,
    );
    expect(decision).toMatchObject({ verdict: "allow", code: "write-ready" });
    expect(ritualRoots).toEqual([resolve(primary)]);
  });
});
