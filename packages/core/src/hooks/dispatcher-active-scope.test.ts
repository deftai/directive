import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
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
