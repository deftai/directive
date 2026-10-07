import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadStoryWriteFenceFromPath } from "../policy/write-fence.js";
import { SCOPE_NOT_READY_PROMOTE_THEN_ACTIVATE } from "../scope/transition-hint.js";
import { applyWorktreeOccupancy } from "../session/occupancy.js";
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
