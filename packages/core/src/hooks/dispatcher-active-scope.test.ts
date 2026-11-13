import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadStoryWriteFenceFromPath } from "../policy/write-fence.js";
import { SCOPE_NOT_READY_PROMOTE_THEN_ACTIVATE } from "../scope/transition-hint.js";
import { applyWorktreeOccupancy } from "../session/occupancy.js";
import { writeWorkerAuthAssignment } from "../swarm/worker-auth-assignment.js";
import { ACTIVE_SCOPE_PIN_ENV, decideHook, type HookPolicySeams } from "./index.js";

const originFreshness = vi.hoisted(() => ({
  evaluate: vi.fn((_payload: unknown, _options?: { readonly skip?: boolean }) => ({
    ok: true,
    message: "origin freshness skipped",
  })),
}));
vi.mock("../vbrief-reconcile/origin-freshness.js", () => ({
  evaluateOriginFreshness: originFreshness.evaluate,
}));

const temps: string[] = [];
afterEach(() => {
  for (const root of temps.splice(0)) rmSync(root, { recursive: true, force: true });
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

const runningPlacement = {
  status: "running",
  metadata: {
    intended_placement: {
      schema: "deft.scope.intended_placement.v1",
      files: ["src/new-module.ts"],
      module_boundary: "new focused module",
    },
  },
};

function liveScopeSeams(): HookPolicySeams {
  return {
    verifyRitual: () => ({ ...READY_RITUAL, boundSessionId: "owner" }),
    sessionStart: () => ({ code: 0, stdout: "", stderr: "" }),
    runningInsideDeftRepo: () => true,
    realpathLifecycleExecutionRoot: (path) => resolve(path),
    // #4007 pin selection uses a path-backed fence seam. These fixtures are not
    // git repos; merge-base authority is covered by write-fence / scope-provenance
    // tests. Production dispatcher defaults to loadStoryWriteFenceFromMergeBase.
    loadStoryWriteFence: (_root, scopePath) => loadStoryWriteFenceFromPath(scopePath),
  };
}

function project(): string {
  const root = mkdtempSync(join(tmpdir(), "hook-active-scope-"));
  temps.push(root);
  mkdirSync(join(root, ".deft"), { recursive: true });
  applyWorktreeOccupancy(root, { sessionId: "owner", intent: "mutation" });
  return root;
}

function writeRunning(root: string, name: string, fileScope: readonly string[]): string {
  const active = join(root, "xbrief", "active");
  mkdirSync(active, { recursive: true });
  const path = join(active, name);
  writeFileSync(
    path,
    JSON.stringify({
      plan: {
        ...runningPlacement,
        metadata: {
          ...runningPlacement.metadata,
          swarm: { file_scope: [...fileScope] },
        },
      },
    }),
    "utf8",
  );
  return path;
}

describe("dispatcher shared-active story fence (#4007)", () => {
  it("denies a write when two eligible briefs share active/ and no pin is set", () => {
    const root = project();
    writeRunning(root, "a-story.xbrief.json", ["packages/a/**"]);
    writeRunning(root, "b-story.xbrief.json", ["packages/b/**", "src/ui/__tests__/fonts.test.ts"]);

    const decision = decideHook(
      {
        host: "grok",
        event: "tool.before",
        projectRoot: root,
        payload: {
          toolName: "Write",
          file_path: join(root, "src", "ui", "__tests__", "fonts.test.ts"),
        },
        environ: { DEFT_SESSION_ID: "owner" },
      },
      liveScopeSeams(),
    );

    expect(decision).toMatchObject({ verdict: "deny", code: "scope-not-ready" });
    expect(decision.message).toContain("Multiple active xBRIEF artifacts");
    expect(decision.message).toContain(ACTIVE_SCOPE_PIN_ENV);
    expect(decision.message).toMatch(/Parent\/operator:/);
    expect(decision.message).toMatch(/Dispatched worker:/);
    expect(decision.message).toContain("scope:block");
    expect(decision.message).toContain("scope:complete");
    expect(decision.message).toContain("scope:stamp-evidence");
    expect(decision.message).toMatch(/does not clear this Write\/spawn deny/);
    // Deduped: proposedPathHint must not re-print undifferentiated Set DEFT_ACTIVE_SCOPE.
    expect(decision.message).not.toMatch(/Recovery: set DEFT_ACTIVE_SCOPE/);
    const workerSection = decision.message.split("Dispatched worker:")[1] ?? "";
    expect(workerSection).not.toMatch(
      /pin DEFT_ACTIVE_SCOPE|set DEFT_ACTIVE_SCOPE|Set DEFT_ACTIVE_SCOPE/,
    );
  });

  it("names scope:unblock on a zero-eligible blocked deny and omits activate (#4840)", () => {
    const root = project();
    const active = join(root, "xbrief", "active");
    mkdirSync(active, { recursive: true });
    writeFileSync(
      join(active, "a-story.xbrief.json"),
      JSON.stringify({ plan: { ...runningPlacement, status: "blocked" } }),
      "utf8",
    );
    writeFileSync(
      join(active, "b-story.xbrief.json"),
      JSON.stringify({ plan: { ...runningPlacement, status: "blocked" } }),
      "utf8",
    );
    const decision = decideHook(
      {
        host: "grok",
        event: "tool.before",
        projectRoot: root,
        payload: {
          toolName: "Write",
          file_path: join(root, "src", "ui", "__tests__", "fonts.test.ts"),
        },
        environ: { DEFT_SESSION_ID: "owner" },
      },
      liveScopeSeams(),
    );
    expect(decision).toMatchObject({ verdict: "deny", code: "scope-not-ready" });
    expect(decision.message).toContain("scope:unblock");
    expect(decision.message).not.toMatch(/scope:promote|then `deft scope:activate/);
  });

  it("allows a bound story path that first-wins would have refused", () => {
    const root = project();
    writeRunning(root, "a-story.xbrief.json", ["packages/a/**"]);
    const storyB = writeRunning(root, "b-story.xbrief.json", [
      "src/ui/fonts.css",
      "src/ui/__tests__/fonts.test.ts",
    ]);

    const deniedAsA = decideHook(
      {
        host: "grok",
        event: "tool.before",
        projectRoot: root,
        payload: {
          toolName: "Write",
          file_path: join(root, "src", "ui", "__tests__", "fonts.test.ts"),
        },
        environ: {
          DEFT_SESSION_ID: "owner",
          [ACTIVE_SCOPE_PIN_ENV]: "xbrief/active/a-story.xbrief.json",
        },
      },
      liveScopeSeams(),
    );
    expect(deniedAsA).toMatchObject({ verdict: "deny", code: "runtime-policy-deny-path" });
    expect(deniedAsA.message).toMatch(/story file_scope/);

    const allowedAsB = decideHook(
      {
        host: "grok",
        event: "tool.before",
        projectRoot: root,
        payload: {
          toolName: "Write",
          file_path: join(root, "src", "ui", "__tests__", "fonts.test.ts"),
        },
        environ: {
          DEFT_SESSION_ID: "owner",
          [ACTIVE_SCOPE_PIN_ENV]: "xbrief/active/b-story.xbrief.json",
        },
      },
      liveScopeSeams(),
    );
    expect(allowedAsB).toMatchObject({ verdict: "allow", code: "write-ready" });
    expect(allowedAsB.scopePath).toBe(storyB);
  });

  it("does not over-permit a sibling story path when the pin is bound", () => {
    const root = project();
    writeRunning(root, "a-story.xbrief.json", ["packages/a/**"]);
    writeRunning(root, "b-story.xbrief.json", ["packages/b/**"]);

    const decision = decideHook(
      {
        host: "grok",
        event: "tool.before",
        projectRoot: root,
        payload: {
          toolName: "Write",
          file_path: join(root, "packages", "a", "index.ts"),
        },
        environ: {
          DEFT_SESSION_ID: "owner",
          [ACTIVE_SCOPE_PIN_ENV]: "xbrief/active/b-story.xbrief.json",
        },
      },
      liveScopeSeams(),
    );
    expect(decision).toMatchObject({ verdict: "deny", code: "runtime-policy-deny-path" });
    expect(decision.message).toMatch(/story file_scope/);
  });
});

describe("spawn multiple-eligible recovery (#4880 Prefer-A B')", () => {
  it("does not emit promote-then-activate; leads with parent pin language", () => {
    const root = project();
    execFileSync("git", ["init", "-q"], { cwd: root, encoding: "utf8" });
    execFileSync("git", ["config", "user.email", "t@t.local"], { cwd: root, encoding: "utf8" });
    execFileSync("git", ["config", "user.name", "T"], { cwd: root, encoding: "utf8" });
    execFileSync("git", ["commit", "--allow-empty", "-q", "-m", "init"], {
      cwd: root,
      encoding: "utf8",
    });
    const dest = join(root, "wt");
    execFileSync("git", ["worktree", "add", "--detach", dest, "HEAD"], {
      cwd: root,
      encoding: "utf8",
    });

    const labeled =
      "Multiple active xBRIEF artifacts are eligible (a-story.xbrief.json, b-story.xbrief.json). " +
      "The write fence cannot bind the first-sorted story (#4007). " +
      "Parent/operator: pin DEFT_ACTIVE_SCOPE to the dispatched story before spawn " +
      "(or demote/complete competitors). " +
      "Dispatched worker: report the eligible brief names upward; do not set host process env.";
    const inspectScope = vi.fn(() => ({
      ready: false,
      path: null,
      message: labeled,
      denyKind: "multiple-eligible" as const,
    }));
    const decision = decideHook(
      {
        host: "grok",
        event: "tool.before",
        projectRoot: root,
        payload: {
          toolName: "spawn_subagent",
          tool_input: { cwd: dest, prompt: "implement story" },
        },
        environ: { DEFT_SESSION_ID: "owner" },
      },
      {
        ...liveScopeSeams(),
        inspectScope,
        realpathLifecycleExecutionRoot: (path) => resolve(path),
      },
    );
    expect(decision).toMatchObject({ verdict: "deny", code: "spawn-not-ready" });
    expect(decision.message).toContain("Parent/operator:");
    expect(decision.message).toContain("DEFT_ACTIVE_SCOPE");
    expect(decision.message).not.toContain(SCOPE_NOT_READY_PROMOTE_THEN_ACTIVATE);
    expect(decision.message).not.toMatch(/scope:promote -- .* then .*scope:activate/);
  });
});

/**
 * #6233 acceptance fixture: a real repository with two linked worktrees under
 * `.deft-scratch/worktrees/`, each registered for a different story through
 * writeWorkerAuthAssignment, and no DEFT_ACTIVE_SCOPE pin.
 */
describe("registered linked worktree story binding (#6233)", { timeout: 60_000 }, () => {
  type Cohort = { primary: string; wtA: string; wtB: string; wtC: string };

  function git(cwd: string, args: readonly string[]): void {
    execFileSync("git", [...args], { cwd, encoding: "utf8" });
  }

  function seedBriefs(root: string): void {
    writeRunning(root, "a-story.xbrief.json", ["packages/a/**"]);
    writeRunning(root, "b-story.xbrief.json", ["packages/b/**"]);
  }

  function register(primary: string, worktree: string, storyId: string): void {
    const written = writeWorkerAuthAssignment({
      projectRoot: primary,
      worktreePath: worktree,
      dispatchId: `dispatch-${storyId}`,
      storyId,
      githubAuthMode: "host-gh",
      expectedPrincipal: { kind: "user", login: "worker" },
      credentialDeliveryId: null,
    });
    expect(written.ok).toBe(true);
  }

  /** wt-a / wt-b registered for a-story / b-story; wt-c is an unregistered linked worktree. */
  function cohort(registered = true): Cohort {
    const primary = mkdtempSync(join(tmpdir(), "hook-6233-"));
    temps.push(primary);
    git(primary, ["init", "-q"]);
    git(primary, ["config", "user.email", "t@t.local"]);
    git(primary, ["config", "user.name", "T"]);
    git(primary, ["commit", "--allow-empty", "-q", "-m", "init"]);
    const nest = join(primary, ".deft-scratch", "worktrees");
    mkdirSync(nest, { recursive: true });
    const wtA = join(nest, "story-a");
    const wtB = join(nest, "story-b");
    const wtC = join(nest, "story-c");
    for (const wt of [wtA, wtB, wtC]) git(primary, ["worktree", "add", "--detach", "-q", wt]);
    for (const root of [primary, wtA, wtB, wtC]) seedBriefs(root);
    // Launch records the shared derivation: the filename stem when plan.id is absent.
    if (registered) {
      register(primary, wtA, "a-story");
      register(primary, wtB, "b-story");
    }
    return { primary, wtA, wtB, wtC };
  }

  function write(primary: string, target: string, environ: NodeJS.ProcessEnv = {}) {
    return decideHook(
      {
        host: "claude",
        event: "tool.before",
        projectRoot: primary,
        payload: { toolName: "Write", file_path: target },
        environ: { DEFT_SESSION_ID: "owner", ...environ },
      },
      liveScopeSeams(),
    );
  }

  function corruptIndex(primary: string): void {
    const store = join(primary, ".git", "deft-worker-auth");
    mkdirSync(store, { recursive: true });
    writeFileSync(join(store, "index.json"), "{ not json", "utf8");
  }

  it("admits each worker's in-scope product write and refuses out of scope, with no env pin", () => {
    const { primary, wtA, wtB } = cohort();
    const inA = write(primary, join(wtA, "packages", "a", "index.ts"));
    expect(inA).toMatchObject({ verdict: "allow", code: "write-ready" });
    expect(resolve(inA.scopePath ?? "")).toBe(
      resolve(wtA, "xbrief", "active", "a-story.xbrief.json"),
    );
    const outA = write(primary, join(wtA, "packages", "b", "index.ts"));
    expect(outA).toMatchObject({ verdict: "deny", code: "runtime-policy-deny-path" });
    expect(outA.message).toMatch(/story file_scope/);

    const inB = write(primary, join(wtB, "packages", "b", "index.ts"));
    expect(inB).toMatchObject({ verdict: "allow", code: "write-ready" });
    expect(resolve(inB.scopePath ?? "")).toBe(
      resolve(wtB, "xbrief", "active", "b-story.xbrief.json"),
    );
    const outB = write(primary, join(wtB, "packages", "a", "index.ts"));
    expect(outB).toMatchObject({ verdict: "deny", code: "runtime-policy-deny-path" });
  });

  it("refuses the same writes as multiple-eligible when the worktrees are not registered", () => {
    const { primary, wtA, wtB } = cohort(false);
    for (const target of [
      join(wtA, "packages", "a", "index.ts"),
      join(wtB, "packages", "b", "index.ts"),
    ]) {
      const decision = write(primary, target);
      expect(decision).toMatchObject({ verdict: "deny", code: "scope-not-ready" });
      expect(decision.message).toContain("Multiple active xBRIEF artifacts");
    }
  });

  it("tests a lifecycle-brief edit separately from a product write", () => {
    const { primary, wtA } = cohort();
    const product = write(primary, join(wtA, "packages", "a", "index.ts"));
    expect(product).toMatchObject({ verdict: "allow", code: "write-ready" });
    const briefEdit = decideHook(
      {
        host: "claude",
        event: "tool.before",
        projectRoot: primary,
        payload: {
          toolName: "Edit",
          file_path: join(wtA, "xbrief", "active", "a-story.xbrief.json"),
          old_string: '"running"',
          new_string: '"running"',
        },
        environ: { DEFT_SESSION_ID: "owner" },
      },
      liveScopeSeams(),
    );
    // The lifecycle edit binds the same story, then meets that story's fence on its
    // own path: the brief is outside file_scope, as with an agreeing env pin.
    expect(briefEdit).toMatchObject({ verdict: "deny", code: "runtime-policy-deny-path" });
    expect(briefEdit.message).toContain("xbrief/active/a-story.xbrief.json");
    expect(briefEdit.message).toMatch(/story file_scope/);
    expect(briefEdit.message).not.toContain("Multiple active xBRIEF artifacts");
  });

  it("refuses with the reader failure kind and one repair step on a corrupt index", () => {
    const { primary, wtA, wtC } = cohort();
    const baselineMain = write(primary, join(primary, "packages", "a", "index.ts"));
    const baselineMainPinned = write(primary, join(primary, "packages", "a", "index.ts"), {
      [ACTIVE_SCOPE_PIN_ENV]: "xbrief/active/a-story.xbrief.json",
    });
    corruptIndex(primary);

    // Registered linked worktree.
    const registered = write(primary, join(wtA, "packages", "a", "index.ts"));
    expect(registered).toMatchObject({ verdict: "deny", code: "scope-not-ready" });
    expect(registered.message).toContain("(registry_corruption)");
    expect(registered.message.match(/Repair:/g)).toHaveLength(1);
    expect(registered.message).not.toContain("Multiple active xBRIEF artifacts");

    // Unregistered linked worktree: membership is unknowable, so it refuses too.
    const unregistered = write(primary, join(wtC, "packages", "a", "index.ts"), {
      [ACTIVE_SCOPE_PIN_ENV]: "xbrief/active/a-story.xbrief.json",
    });
    expect(unregistered).toMatchObject({ verdict: "deny", code: "scope-not-ready" });
    expect(unregistered.message).toContain("(registry_corruption)");

    // Main worktree: the registry is never read, so the verdict is unchanged.
    const main = write(primary, join(primary, "packages", "a", "index.ts"));
    expect({ verdict: main.verdict, code: main.code }).toEqual({
      verdict: baselineMain.verdict,
      code: baselineMain.code,
    });
    expect(main.message).not.toContain("Worktree story binding");
    const mainPinned = write(primary, join(primary, "packages", "a", "index.ts"), {
      [ACTIVE_SCOPE_PIN_ENV]: "xbrief/active/a-story.xbrief.json",
    });
    expect(mainPinned).toMatchObject({ verdict: baselineMainPinned.verdict, code: "write-ready" });
  });

  it("refuses an env pin that names a different story and admits one that agrees", () => {
    const { primary, wtA } = cohort();
    const conflict = write(primary, join(wtA, "packages", "a", "index.ts"), {
      [ACTIVE_SCOPE_PIN_ENV]: "xbrief/active/b-story.xbrief.json",
    });
    expect(conflict).toMatchObject({ verdict: "deny", code: "scope-not-ready" });
    expect(conflict.message).toContain("(env_pin_conflict)");
    expect(conflict.message.match(/Repair:/g)).toHaveLength(1);
    const agrees = write(primary, join(wtA, "packages", "a", "index.ts"), {
      [ACTIVE_SCOPE_PIN_ENV]: "xbrief/active/a-story.xbrief.json",
    });
    expect(agrees).toMatchObject({ verdict: "allow", code: "write-ready" });
  });

  it("refuses a missing or ineligible assigned story without falling through to single-eligible", () => {
    const { primary, wtA, wtC } = cohort();
    // wt-c keeps one eligible brief only; its record names a story that is not active.
    rmSync(join(wtC, "xbrief", "active", "b-story.xbrief.json"));
    register(primary, wtC, "gone-story");
    const missing = write(primary, join(wtC, "packages", "a", "index.ts"));
    expect(missing).toMatchObject({ verdict: "deny", code: "scope-not-ready" });
    expect(missing.message).toContain("(assigned_story_missing)");

    writeFileSync(
      join(wtA, "xbrief", "active", "a-story.xbrief.json"),
      JSON.stringify({ plan: { ...runningPlacement, status: "blocked" } }),
      "utf8",
    );
    const ineligible = write(primary, join(wtA, "packages", "a", "index.ts"));
    expect(ineligible).toMatchObject({ verdict: "deny", code: "scope-not-ready" });
    expect(ineligible.message).toContain("(assigned_story_ineligible)");
  });
});
