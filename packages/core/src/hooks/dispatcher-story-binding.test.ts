/**
 * #6379 acceptance fixture: a real repository with an origin remote, two
 * active briefs on the fetched default branch, and linked worktrees. The commit
 * hook reads `file_scope` through the production merge-base loader; the story
 * comes from the record that `swarm:pre-dispatch` begin writes. No
 * `DEFT_ACTIVE_SCOPE` is set anywhere.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearWriteFenceMemosForTests } from "../policy/write-fence.js";
import { swarmPreDispatch } from "../swarm/pre-dispatch.js";
import { writeWorkerAuthAssignment } from "../swarm/worker-auth-assignment.js";
import { decideHook, type HookPolicySeams } from "./index.js";
import { resolveWorktreeStoryBinding } from "./scope.js";

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
beforeEach(() => {
  vi.stubEnv("DEFT_BASE_REF", "");
  vi.stubEnv("GITHUB_BASE_REF", "");
  vi.stubEnv("DEFT_ACTIVE_SCOPE", "");
  clearWriteFenceMemosForTests();
});
afterEach(() => {
  vi.unstubAllEnvs();
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
  boundSessionId: "owner",
};

/** Production fence loader (merge base); no loadStoryWriteFence seam. */
function seams(): HookPolicySeams {
  return {
    verifyRitual: () => READY_RITUAL,
    sessionStart: () => ({ code: 0, stdout: "", stderr: "" }),
    runningInsideDeftRepo: () => true,
    realpathLifecycleExecutionRoot: (path) => resolve(path),
  };
}

function git(cwd: string, args: readonly string[]): string {
  return execFileSync("git", [...args], { cwd, encoding: "utf8" });
}

function put(root: string, rel: string, text: string): void {
  const abs = join(root, ...rel.split("/"));
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, text, "utf8");
}

function brief(planId: string, issue: number, fileScope: readonly string[]): string {
  return `${JSON.stringify(
    {
      xBRIEFInfo: { version: "0.8" },
      plan: {
        id: planId,
        status: "running",
        narratives: { Origin: `Ingested from https://github.com/o/r/issues/${issue}` },
        metadata: {
          intended_placement: {
            schema: "deft.scope.intended_placement.v1",
            files: ["src/new-module.ts"],
            module_boundary: "new focused module",
          },
          swarm: { file_scope: [...fileScope] },
        },
      },
    },
    null,
    2,
  )}\n`;
}

const BRIEF_A = "xbrief/active/a-story.xbrief.json";
const BRIEF_B = "xbrief/active/b-story.xbrief.json";

interface Fixture {
  readonly primary: string;
  readonly wtA: string;
  readonly wtB: string;
  readonly wtC: string;
}

/** origin/master holds both briefs; wt-a / wt-b / wt-c are story branches from it. */
function fixture(): Fixture {
  const base = mkdtempSync(join(tmpdir(), "hook-6379-"));
  temps.push(base);
  const origin = join(base, "origin.git");
  const primary = join(base, "primary");
  mkdirSync(primary);
  git(base, ["init", "-q", "--bare", origin]);
  git(primary, ["init", "-q", "-b", "master"]);
  git(primary, ["config", "user.email", "t@t.local"]);
  git(primary, ["config", "user.name", "T"]);
  put(primary, BRIEF_A, brief("plan-a", 101, ["packages/a/**"]));
  put(primary, BRIEF_B, brief("plan-b", 102, ["packages/b/**"]));
  put(primary, "packages/a/shared.ts", "base\n");
  put(primary, "packages/b/y.ts", "base\n");
  put(primary, ".gitignore", ".deft-scratch/\n.deft/\n");
  git(primary, ["add", "-A"]);
  git(primary, ["commit", "-q", "-m", "seed"]);
  git(primary, ["remote", "add", "origin", origin]);
  git(primary, ["push", "-q", "-u", "origin", "master"]);
  const nest = join(primary, ".deft-scratch", "worktrees");
  mkdirSync(nest, { recursive: true });
  const wt = (name: string): string => {
    const path = join(nest, name);
    git(primary, ["worktree", "add", "-q", "-b", `story-${name}`, path, "origin/master"]);
    git(path, ["config", "user.email", "t@t.local"]);
    git(path, ["config", "user.name", "T"]);
    return path;
  };
  return { primary, wtA: wt("a"), wtB: wt("b"), wtC: wt("c") };
}

function commit(f: Fixture, wt: string) {
  clearWriteFenceMemosForTests();
  return decideHook(
    {
      host: "claude",
      event: "tool.before",
      projectRoot: f.primary,
      payload: { tool_name: "Bash", tool_input: { command: `git -C "${wt}" commit -m x` } },
      environ: { DEFT_SESSION_ID: "owner" },
    },
    seams(),
  );
}

function begin(f: Fixture, scopeId: string, wt: string) {
  const result = swarmPreDispatch({ projectRoot: f.primary, scopeId, targetId: wt });
  expect(result.exitCode).toBe(0);
  expect(result.storyBinding).toContain("-> ");
  return result;
}

function stage(wt: string, rel: string, text = "export {};\n"): void {
  put(wt, rel, text);
  git(wt, ["add", "--", rel]);
}

/** Advance origin/master: changes in packages/b and a new packages/c file. */
function advanceMaster(f: Fixture, shared?: string): void {
  if (shared !== undefined) put(f.primary, "packages/a/shared.ts", shared);
  put(f.primary, "packages/b/y.ts", "master\n");
  put(f.primary, "packages/c/z.ts", "new on master\n");
  git(f.primary, ["add", "-A"]);
  git(f.primary, ["commit", "-q", "-m", "master moves"]);
  git(f.primary, ["push", "-q", "origin", "master"]);
}

describe("resolveWorktreeStoryBinding read order (#6379 item 4)", () => {
  function project(): string {
    const root = mkdtempSync(join(tmpdir(), "hook-6379-resolver-"));
    temps.push(root);
    put(root, BRIEF_A, brief("plan-a", 101, ["packages/a/**"]));
    put(root, BRIEF_B, brief("plan-b", 102, ["packages/b/**"]));
    return root;
  }
  const noAssignment = () => ({ ok: true as const, assignment: null, commonDir: "/common" });
  const linked = () => true;
  const eligible = () => ({ ok: true, message: "ok" });

  it("refuses a malformed record and names pre-dispatch begin as the one repair", () => {
    const out = resolveWorktreeStoryBinding(project(), {
      isLinkedWorktree: linked,
      isEligible: eligible,
      readWorkerAuthAssignment: noAssignment,
      readStoryBindingRecord: () => ({
        ok: false,
        failureKind: "malformed_assignment",
        detail: "story-binding record is malformed",
      }),
    });
    expect(out).toMatchObject({ kind: "refuse", failureKind: "malformed_assignment" });
    if (out.kind !== "refuse") throw new Error("expected refuse");
    expect(out.message.match(/Repair:/g)).toHaveLength(1);
    expect(out.message).toContain("swarm:pre-dispatch");
  });

  it("applies the assignment checks to a record: pin conflict and missing story", () => {
    const root = project();
    const record = (storyId: string) => () => ({
      ok: true as const,
      record: { schema_version: 1, story_id: storyId, worktree_path: root, attempt_ids: ["a"] },
      commonDir: "/common",
    });
    const base = {
      isLinkedWorktree: linked,
      isEligible: eligible,
      readWorkerAuthAssignment: noAssignment,
    };
    const conflict = resolveWorktreeStoryBinding(root, {
      ...base,
      readStoryBindingRecord: record("plan-a"),
      env: { DEFT_ACTIVE_SCOPE: BRIEF_B },
    });
    expect(conflict).toMatchObject({ kind: "refuse", failureKind: "env_pin_conflict" });
    if (conflict.kind !== "refuse") throw new Error("expected refuse");
    expect(conflict.message).toContain("worktree story-binding record");
    const missing = resolveWorktreeStoryBinding(root, {
      ...base,
      readStoryBindingRecord: record("plan-gone"),
    });
    expect(missing).toMatchObject({ kind: "refuse", failureKind: "assigned_story_missing" });
    const bound = resolveWorktreeStoryBinding(root, {
      ...base,
      readStoryBindingRecord: record("plan-b"),
      env: {},
    });
    expect(bound).toMatchObject({ kind: "bound", storyId: "plan-b" });
  });
});

describe("story-binding record selects the story at the commit hook (#6379)", {
  timeout: 300_000,
}, () => {
  it("admits an in-scope commit after begin, with no DEFT_ACTIVE_SCOPE, and refuses out of scope", () => {
    const f = fixture();
    stage(f.wtA, "packages/a/new.ts");
    // Unregistered linked worktree: refused, and the repair names pre-dispatch begin.
    const before = commit(f, f.wtA);
    expect(before).toMatchObject({ verdict: "deny", code: "prospective-scope-cover-deny" });
    expect(before.message).toContain("Multiple active xBRIEF artifacts");
    expect(before.message).toContain("swarm:pre-dispatch -- --scope-id <story>");
    expect(before.message.indexOf("swarm:pre-dispatch")).toBeLessThan(
      before.message.indexOf("pin DEFT_ACTIVE_SCOPE"),
    );

    begin(f, "plan-a", f.wtA);
    expect(commit(f, f.wtA).verdict).toBe("allow");
    stage(f.wtA, "packages/b/out.ts");
    const out = commit(f, f.wtA);
    expect(out).toMatchObject({ verdict: "deny", code: "prospective-scope-cover-deny" });
    expect(out.message).toContain("packages/b/out.ts");
    expect(out.message).toMatch(/outside governing file_scope/);
  });

  it("selects the worker-auth assignment's story over a story-binding record", () => {
    const f = fixture();
    begin(f, "plan-a", f.wtC);
    const written = writeWorkerAuthAssignment({
      projectRoot: f.primary,
      worktreePath: f.wtC,
      dispatchId: "dispatch-b",
      storyId: "plan-b",
      githubAuthMode: "host-gh",
      expectedPrincipal: { kind: "user", login: "worker" },
      credentialDeliveryId: null,
    });
    expect(written.ok).toBe(true);
    const binding = resolveWorktreeStoryBinding(f.wtC);
    expect(binding).toMatchObject({ kind: "bound", storyId: "plan-b" });
    stage(f.wtC, "packages/b/in.ts");
    expect(commit(f, f.wtC).verdict).toBe("allow");
  });

  it("keeps the record while a second scope id of the same story still runs", () => {
    const f = fixture();
    begin(f, "plan-a", f.wtA);
    begin(f, "101", f.wtA);
    stage(f.wtA, "packages/a/new.ts");
    const first = swarmPreDispatch({
      projectRoot: f.primary,
      scopeId: "plan-a",
      targetId: f.wtA,
      action: "complete",
    });
    expect(first.exitCode).toBe(0);
    expect(resolveWorktreeStoryBinding(f.wtA)).toMatchObject({ kind: "bound", storyId: "plan-a" });
    expect(commit(f, f.wtA).verdict).toBe("allow");

    const second = swarmPreDispatch({
      projectRoot: f.primary,
      scopeId: "101",
      targetId: f.wtA,
      action: "complete",
    });
    expect(second.exitCode).toBe(0);
    expect(resolveWorktreeStoryBinding(f.wtA)).toEqual({ kind: "none" });
    expect(commit(f, f.wtA).verdict).toBe("deny");
  });

  it("refuses a path that only the worktree copy's edited file_scope covers", () => {
    const f = fixture();
    begin(f, "plan-a", f.wtA);
    put(f.wtA, BRIEF_A, brief("plan-a", 101, ["packages/a/**", "packages/b/**"]));
    git(f.wtA, ["add", "--", BRIEF_A]);
    stage(f.wtA, "packages/b/y.ts", "widened\n");
    const out = commit(f, f.wtA);
    expect(out).toMatchObject({ verdict: "deny", code: "prospective-scope-cover-deny" });
    expect(out.message).toContain("packages/b/y.ts");
  });

  it("admits a merge of the fetched default branch with a conflict resolved inside file_scope", () => {
    const f = fixture();
    begin(f, "plan-a", f.wtA);
    put(f.wtA, "packages/a/shared.ts", "story\n");
    git(f.wtA, ["commit", "-q", "-am", "story change"]);
    advanceMaster(f, "master\n");
    expect(() => git(f.wtA, ["merge", "-q", "origin/master"])).toThrow();
    put(f.wtA, "packages/a/shared.ts", "story and master\n");
    git(f.wtA, ["add", "--", "packages/a/shared.ts"]);
    const merged = commit(f, f.wtA);
    expect(merged.verdict).toBe("allow");

    // Every other staged path is checked as today.
    stage(f.wtA, "packages/b/y.ts", "changed during the merge\n");
    const changed = commit(f, f.wtA);
    expect(changed).toMatchObject({ verdict: "deny", code: "prospective-scope-cover-deny" });
    expect(changed.message).toContain("packages/b/y.ts");
    expect(changed.message).not.toContain("packages/c/z.ts");
  });

  it("refuses a merge of a commit that is not an ancestor of the fetched delivery ref", () => {
    const f = fixture();
    begin(f, "plan-a", f.wtA);
    git(f.primary, ["checkout", "-q", "-b", "side"]);
    put(f.primary, "packages/b/y.ts", "side\n");
    git(f.primary, ["commit", "-q", "-am", "side"]);
    git(f.wtA, ["merge", "-q", "--no-commit", "--no-ff", "side"]);
    const out = commit(f, f.wtA);
    expect(out).toMatchObject({ verdict: "deny", code: "prospective-scope-cover-deny" });
    expect(out.message).toContain("packages/b/y.ts");
  });

  it("refuses a merge whose staged path has the MERGE_HEAD blob and a different mode", () => {
    const f = fixture();
    begin(f, "plan-a", f.wtA);
    advanceMaster(f);
    git(f.wtA, ["merge", "-q", "--no-commit", "--no-ff", "origin/master"]);
    expect(commit(f, f.wtA).verdict).toBe("allow");
    git(f.wtA, ["update-index", "--chmod=+x", "packages/b/y.ts"]);
    const out = commit(f, f.wtA);
    expect(out).toMatchObject({ verdict: "deny", code: "prospective-scope-cover-deny" });
    expect(out.message).toContain("packages/b/y.ts");
    expect(readFileSync(join(f.wtA, "packages", "b", "y.ts"), "utf8")).toBe("master\n");
  });
});
