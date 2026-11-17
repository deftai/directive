/**
 * #6480 acceptance fixture: a bound linked worktree whose story brief moves
 * from active/ to completed/ as lands-with-product (`scope:complete --in-pr`).
 * Real repository with an origin remote; the story comes from the record that
 * `swarm:pre-dispatch` begin writes, and the fence is read through the
 * production merge-base loader. No `DEFT_ACTIVE_SCOPE` is set.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearWriteFenceMemosForTests } from "../policy/write-fence.js";
import { LANDS_WITH_PRODUCT } from "../scope/lifecycle-write.js";
import { swarmPreDispatch } from "../swarm/pre-dispatch.js";
import { decideHook, type HookPolicySeams } from "./index.js";

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
  vi.stubEnv("DEFT_SESSION_SLASH_VERB", "");
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

function plan(
  planId: string,
  issue: number,
  fileScope: readonly string[],
): Record<string, unknown> {
  return {
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
  };
}

function briefText(body: Record<string, unknown>): string {
  return `${JSON.stringify({ xBRIEFInfo: { version: "0.8" }, plan: body }, null, 2)}\n`;
}

const BRIEF_A = "xbrief/active/a-story.xbrief.json";
const BRIEF_B = "xbrief/active/b-story.xbrief.json";
const DONE_A = "xbrief/completed/a-story.xbrief.json";
const DONE_B = "xbrief/completed/b-story.xbrief.json";
const SCOPE_A = ["packages/a/**"];
const SCOPE_B = ["packages/b/**"];

interface Fixture {
  readonly primary: string;
  readonly wtA: string;
}

/** origin/master holds both briefs; wt-a is a story branch from it. */
function fixture(): Fixture {
  const base = mkdtempSync(join(tmpdir(), "hook-6480-"));
  temps.push(base);
  const origin = join(base, "origin.git");
  const primary = join(base, "primary");
  mkdirSync(primary);
  git(base, ["init", "-q", "--bare", origin]);
  git(primary, ["init", "-q", "-b", "master"]);
  git(primary, ["config", "user.email", "t@t.local"]);
  git(primary, ["config", "user.name", "T"]);
  put(primary, BRIEF_A, briefText(plan("plan-a", 101, SCOPE_A)));
  put(primary, BRIEF_B, briefText(plan("plan-b", 102, SCOPE_B)));
  put(primary, "packages/a/shared.ts", "base\n");
  put(primary, "packages/b/y.ts", "base\n");
  put(primary, ".gitignore", ".deft-scratch/\n.deft/\n");
  git(primary, ["add", "-A"]);
  git(primary, ["commit", "-q", "-m", "seed"]);
  git(primary, ["remote", "add", "origin", origin]);
  git(primary, ["push", "-q", "-u", "origin", "master"]);
  const path = join(primary, ".deft-scratch", "worktrees", "a");
  mkdirSync(dirname(path), { recursive: true });
  git(primary, ["worktree", "add", "-q", "-b", "story-a", path, "origin/master"]);
  git(path, ["config", "user.email", "t@t.local"]);
  git(path, ["config", "user.name", "T"]);
  const result = swarmPreDispatch({ projectRoot: primary, scopeId: "plan-a", targetId: path });
  expect(result.exitCode).toBe(0);
  return { primary, wtA: path };
}

/** `scope:complete --in-pr` shape: the active file goes, a stamped completed copy appears. */
function completeInPr(
  root: string,
  activeRel: string,
  completedRel: string,
  body: Record<string, unknown>,
): void {
  rmSync(join(root, ...activeRel.split("/")));
  put(
    root,
    completedRel,
    briefText({
      ...body,
      status: "completed",
      metadata: {
        ...(body.metadata as Record<string, unknown>),
        lifecycleWrite: {
          action: "complete",
          writtenAt: "2026-11-17T00:00:00Z",
          completionDisposition: LANDS_WITH_PRODUCT,
        },
      },
    }),
  );
}

function commit(f: Fixture, environ: Record<string, string> = {}) {
  clearWriteFenceMemosForTests();
  return decideHook(
    {
      host: "claude",
      event: "tool.before",
      projectRoot: f.primary,
      payload: { tool_name: "Bash", tool_input: { command: `git -C "${f.wtA}" commit -m x` } },
      environ: { DEFT_SESSION_ID: "owner", ...environ },
    },
    seams(),
  );
}

function stage(wt: string, rel: string, text = "export {};\n"): void {
  put(wt, rel, text);
  git(wt, ["add", "--", rel]);
}

describe("worktree story binding after an in-PR completion move (#6480)", {
  timeout: 300_000,
}, () => {
  it("admits the completing commit and every later commit and write, inside the merge-base fence", () => {
    const f = fixture();
    stage(f.wtA, "packages/a/fix.ts");
    completeInPr(f.wtA, BRIEF_A, DONE_A, plan("plan-a", 101, SCOPE_A));
    git(f.wtA, ["add", "-A"]);
    const completing = commit(f);
    expect(completing.verdict).toBe("allow");
    git(f.wtA, ["commit", "-q", "-m", "fix + complete in PR"]);

    // Review fix after the move is committed on the branch.
    stage(f.wtA, "packages/a/fix.ts", "export const fixed = 2;\n");
    const later = commit(f);
    expect(later.verdict).toBe("allow");
    expect(later.message).not.toContain("scope:activate");

    // The fence is still the merge-base blob of the old active path.
    stage(f.wtA, "packages/b/out.ts");
    const outside = commit(f);
    expect(outside).toMatchObject({ verdict: "deny", code: "prospective-scope-cover-deny" });
    expect(outside.message).toContain("packages/b/out.ts");
    expect(outside.message).toMatch(/outside governing file_scope/);
    git(f.wtA, ["reset", "-q", "--", "packages/b/out.ts"]);

    clearWriteFenceMemosForTests();
    const write = decideHook(
      {
        host: "claude",
        event: "tool.before",
        projectRoot: f.wtA,
        payload: {
          tool_name: "Write",
          tool_input: { file_path: join(f.wtA, "packages", "a", "more.ts"), content: "x\n" },
        },
        environ: { DEFT_SESSION_ID: "owner" },
      },
      seams(),
    );
    expect(write.verdict, write.message).toBe("allow");
    expect(write.message).not.toContain("scope:activate");
  });

  it("follows the assigned story when two briefs move, never the other story's fence", () => {
    const f = fixture();
    completeInPr(f.wtA, BRIEF_B, DONE_B, plan("plan-b", 102, SCOPE_B));
    completeInPr(f.wtA, BRIEF_A, DONE_A, plan("plan-a", 101, SCOPE_A));
    stage(f.wtA, "packages/a/fix.ts");
    git(f.wtA, ["add", "-A"]);
    expect(commit(f).verdict).toBe("allow");
    stage(f.wtA, "packages/b/theirs.ts");
    const theirs = commit(f);
    expect(theirs).toMatchObject({ verdict: "deny", code: "prospective-scope-cover-deny" });
    expect(theirs.message).toContain("packages/b/theirs.ts");
  });

  it("keeps the implement intent ceiling on the commit path", () => {
    const f = fixture();
    stage(f.wtA, "packages/a/fix.ts");
    completeInPr(f.wtA, BRIEF_A, DONE_A, plan("plan-a", 101, SCOPE_A));
    git(f.wtA, ["add", "-A"]);
    const out = commit(f, { DEFT_SESSION_SLASH_VERB: "triage" });
    expect(out).toMatchObject({ verdict: "deny", code: "prospective-scope-cover-deny" });
    expect(out.message).toContain("Prospective scope-cover denied (#6480)");
    expect(commit(f).verdict).toBe("allow");
  });

  it("refuses as today when the completion is already inside the merge base", () => {
    const f = fixture();
    completeInPr(f.primary, BRIEF_A, DONE_A, plan("plan-a", 101, SCOPE_A));
    git(f.primary, ["add", "-A"]);
    git(f.primary, ["commit", "-q", "-m", "completed on master"]);
    git(f.primary, ["push", "-q", "origin", "master"]);
    git(f.wtA, ["fetch", "-q", "origin"]);
    git(f.wtA, ["merge", "-q", "origin/master"]);
    stage(f.wtA, "packages/a/late.ts");
    const out = commit(f);
    expect(out).toMatchObject({ verdict: "deny", code: "prospective-scope-cover-deny" });
    expect(out.message).toContain("assigned_story_missing");
  });

  it("refuses as today when the assigned brief is gone with no lands-with-product move", () => {
    const f = fixture();
    rmSync(join(f.wtA, ...BRIEF_A.split("/")));
    stage(f.wtA, "packages/a/fix.ts");
    git(f.wtA, ["add", "-A"]);
    const out = commit(f);
    expect(out).toMatchObject({ verdict: "deny", code: "prospective-scope-cover-deny" });
    expect(out.message).toContain("assigned_story_missing");
    expect(out.message).toContain("scope:activate");
  });
});
