import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadStoryWriteFenceFromPath } from "../policy/write-fence.js";
import { SCOPE_NOT_READY_PROMOTE_THEN_ACTIVATE } from "../scope/transition-hint.js";
import { applyWorktreeOccupancy } from "../session/occupancy.js";
import { writeWorkerAuthAssignment } from "../swarm/worker-auth-assignment.js";
import {
  ACTIVE_SCOPE_PIN_ENV,
  commitTargetMayBeDirectiveProject,
  decideHook,
  evaluateProspectiveScopeCover,
  type HookPolicySeams,
} from "./index.js";

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
type Cohort = { primary: string; wtA: string; wtB: string; wtC: string };

function git(cwd: string, args: readonly string[]): string {
  return execFileSync("git", [...args], { cwd, encoding: "utf8" });
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

function initRepo(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  temps.push(root);
  git(root, ["init", "-q"]);
  git(root, ["config", "user.email", "t@t.local"]);
  git(root, ["config", "user.name", "T"]);
  git(root, ["commit", "--allow-empty", "-q", "-m", "init"]);
  return root;
}

/** wt-a / wt-b registered for a-story / b-story; wt-c is an unregistered linked worktree. */
function cohort(registered = true, names = { a: "story-a", b: "story-b", c: "story-c" }): Cohort {
  const primary = initRepo("hook-6233-");
  const nest = join(primary, ".deft-scratch", "worktrees");
  mkdirSync(nest, { recursive: true });
  const wtA = join(nest, names.a);
  const wtB = join(nest, names.b);
  const wtC = join(nest, names.c);
  for (const wt of [wtA, wtB, wtC]) git(primary, ["worktree", "add", "--detach", "-q", wt]);
  for (const root of [primary, wtA, wtB, wtC]) seedBriefs(root);
  // Launch records the shared derivation: the filename stem when plan.id is absent.
  if (registered) {
    register(primary, wtA, "a-story");
    register(primary, wtB, "b-story");
  }
  return { primary, wtA, wtB, wtC };
}

function corruptIndex(primary: string): void {
  const store = join(primary, ".git", "deft-worker-auth");
  mkdirSync(store, { recursive: true });
  writeFileSync(join(store, "index.json"), "{ not json", "utf8");
}

describe("registered linked worktree story binding (#6233)", { timeout: 60_000 }, () => {
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

/**
 * #6278 / #6247 acceptance fixture: the commit gate judges the checkout a commit
 * names, on that checkout's index and worktree story binding. A real repository
 * with registered linked worktrees, two active briefs in each, and no pin. The
 * PowerShell-tool attempt of comment 6858441886 is outside the hook matcher, so
 * it has no fixture here (#6291 covers it in the dispatch preamble).
 */
describe("commit gate judges the checkout the commit names (#6278 / #6247)", {
  timeout: 120_000,
}, () => {
  const FORMS = "git -C <absolute path> commit";

  function commit(projectRoot: string, command: string, environ: NodeJS.ProcessEnv = {}) {
    return decideHook(
      {
        host: "claude",
        event: "tool.before",
        projectRoot,
        payload: { tool_name: "Bash", tool_input: { command } },
        environ: { DEFT_SESSION_ID: "owner", ...environ },
      },
      liveScopeSeams(),
    );
  }

  function stage(root: string, rel: string): void {
    const abs = join(root, ...rel.split("/"));
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, "export {};\n", "utf8");
    git(root, ["add", "--", rel]);
  }

  function unstageAll(root: string): void {
    git(root, ["reset", "-q"]);
  }

  /** MSYS `/c/...` form of a Windows drive path; the native path elsewhere. */
  function msys(path: string): string {
    if (process.platform !== "win32") return path;
    const match = /^([A-Za-z]):[\\/](.*)$/.exec(path);
    if (match === null) return path;
    return `/${(match[1] ?? "").toLowerCase()}/${(match[2] ?? "").replace(/\\/g, "/")}`;
  }

  function namedForms(wt: string, msg: string): string[] {
    return [
      `cd "${wt}" && git commit -F "${msg}"`,
      `git -C "${wt}" commit -F ${msys(msg)}`,
      `cd ${msys(wt)} && git commit -F ${msys(msg)}`,
    ];
  }

  it("judges the field-report attempts on the named worktree's index, not the hook root's", () => {
    const { primary, wtA, wtB } = cohort();
    const msg = join(primary, "msg.txt");
    // The hook root is a sibling worktree with nothing staged, as in comment 6858441886.
    for (const hookRoot of [wtB, primary]) {
      stage(wtA, "packages/b/out.ts");
      for (const command of namedForms(wtA, msg)) {
        const out = commit(hookRoot, command);
        expect(out, command).toMatchObject({
          verdict: "deny",
          code: "prospective-scope-cover-deny",
        });
        expect(out.message).toContain("packages/b/out.ts");
        expect(out.message).toMatch(/outside governing file_scope/);
        expect(out.message).toContain("effectiveRoot=");
      }
      unstageAll(wtA);
      stage(wtA, "packages/a/in.ts");
      for (const command of namedForms(wtA, msg)) {
        const inScope = commit(hookRoot, command);
        expect(inScope.code, command).not.toBe("prospective-scope-cover-deny");
        expect(inScope.verdict, command).toBe("allow");
      }
      unstageAll(wtA);
    }
  });

  it("binds a plain commit to the hook root's own registered worktree (#6247)", () => {
    const { wtA } = cohort();
    stage(wtA, "packages/a/in.ts");
    expect(commit(wtA, "git commit -m x").verdict).toBe("allow");
    unstageAll(wtA);
    stage(wtA, "packages/b/out.ts");
    expect(commit(wtA, "git commit -m x")).toMatchObject({
      verdict: "deny",
      code: "prospective-scope-cover-deny",
    });
  });

  it("refuses relative, repeated and variable targets whatever the indexes hold", () => {
    const { primary, wtA, wtB } = cohort();
    stage(wtA, "packages/b/out.ts");
    stage(primary, "packages/a/in.ts");
    for (const command of [
      "git -C . commit -m x",
      "cd .deft-scratch/worktrees/story-a && git commit -m x",
      `cd "${wtA}" && cd "${wtB}" && git commit -m x`,
      "cd $WT && git commit -m x",
      `true || cd "${wtA}" && git commit -m x`,
      `{ cd "${wtA}"; } && git commit -m x`,
      `GIT_INDEX_FILE="${join(wtA, "index")}" git commit -m x`,
      `GIT_DIR="${join(primary, ".git")}" git commit -m x`,
      `git --git-dir="${join(primary, ".git")}" commit -m x`,
    ]) {
      const out = commit(primary, command);
      expect(out, command).toMatchObject({
        verdict: "deny",
        code: "prospective-scope-cover-deny",
      });
      expect(out.message).toMatch(/cannot be resolved to one checkout/);
      expect(out.message).toContain(FORMS);
    }
    // Absolute `git -C` is sole chdir authority; prior `cd` is ignored (#7273).
    // Empty wtB index → allow (no out-of-scope staged paths on the named checkout).
    expect(commit(primary, `cd "${wtA}" && git -C "${wtB}" commit -m x`).verdict).toBe("allow");
  });

  it("resolves a quoted path with spaces and a forward-slash drive path", () => {
    const { primary, wtA } = cohort(true, { a: "story a", b: "story b", c: "story c" });
    stage(wtA, "packages/a/in.ts");
    for (const command of [
      `cd "${wtA}" && git commit -m x`,
      `git -C '${wtA}' commit -m x`,
      `git -C "${wtA.replace(/\\/g, "/")}" commit -m x`,
    ]) {
      expect(commit(primary, command).verdict, command).toBe("allow");
    }
    unstageAll(wtA);
    stage(wtA, "packages/b/out.ts");
    const out = commit(primary, `cd "${wtA}" && git commit -m x`);
    expect(out).toMatchObject({ verdict: "deny", code: "prospective-scope-cover-deny" });
    expect(out.message).toContain("packages/b/out.ts");
  });

  it("denies a foreign Directive project, a missing directory and a non-repository target", () => {
    const { primary } = cohort();
    const foreign = initRepo("hook-6278-foreign-");
    seedBriefs(foreign);
    mkdirSync(join(foreign, ".deft"));
    stage(foreign, "packages/a/in.ts");
    const foreignOut = commit(primary, `git -C "${foreign}" commit -m x`);
    expect(foreignOut).toMatchObject({ verdict: "deny", code: "foreign-repository-deny" });
    expect(foreignOut.message).toMatch(/different Git repository/);
    expect(foreignOut.message).toContain("commit from a Directive session in that project");

    const missing = commit(primary, `git -C "${join(primary, "missing")}" commit -m x`);
    expect(missing).toMatchObject({ verdict: "deny", code: "prospective-scope-cover-deny" });
    expect(missing.message).toMatch(/does not exist/);

    const plain = mkdtempSync(join(tmpdir(), "hook-6278-plain-"));
    temps.push(plain);
    const notRepo = commit(primary, `cd "${plain}" && git commit -m x`);
    expect(notRepo).toMatchObject({ verdict: "deny", code: "prospective-scope-cover-deny" });
    expect(notRepo.message).toMatch(/not a checkout/);
  });

  it("returns no commit decision for a foreign repository that is not a Directive project (#6871)", () => {
    const { primary } = cohort();
    const foreign = initRepo("hook-6871-plain-repo-");
    // Out-of-scope paths for every story here: the gate must not judge them.
    stage(foreign, "packages/z/out.ts");
    for (const command of [
      `git -C "${foreign}" commit -m x`,
      `cd "${foreign}" && git commit -m x`,
      `git -C "${msys(foreign)}" commit -m x`,
    ]) {
      const out = commit(primary, command);
      expect(out.code, command).not.toBe("foreign-repository-deny");
      expect(out.code, command).not.toBe("prospective-scope-cover-deny");
      expect(out.verdict, command).toBe("allow");
    }
    // An `xbrief` file (not a folder) makes the marker probe report ENOTDIR: absent.
    writeFileSync(join(foreign, "xbrief"), "not a folder\n", "utf8");
    expect(commit(primary, `git -C "${foreign}" commit -m x`).verdict).toBe("allow");
  });

  it("keeps foreign-repository-deny for each Directive marker and a separate clone (#6871)", () => {
    const { primary } = cohort();
    const markers: readonly (readonly string[])[] = [
      [".deft"],
      ["xbrief", "PROJECT-DEFINITION.xbrief.json"],
      ["vbrief", "PROJECT-DEFINITION.vbrief.json"],
    ];
    for (const marker of markers) {
      const foreign = initRepo("hook-6871-marked-repo-");
      const abs = join(foreign, ...marker);
      if (marker.length === 1) mkdirSync(abs);
      else {
        mkdirSync(dirname(abs), { recursive: true });
        writeFileSync(abs, "{}\n", "utf8");
      }
      for (const command of [
        `git -C "${foreign}" commit -m x`,
        `cd "${foreign}" && git commit -m x`,
      ]) {
        const out = commit(primary, command);
        expect(out, `${marker.join("/")}: ${command}`).toMatchObject({
          verdict: "deny",
          code: "foreign-repository-deny",
        });
        expect(out.message).toContain("commit from a Directive session in that project");
      }
    }
    const definition = join(primary, "xbrief", "PROJECT-DEFINITION.xbrief.json");
    writeFileSync(definition, "{}\n", "utf8");
    git(primary, ["add", "--", "xbrief/PROJECT-DEFINITION.xbrief.json"]);
    git(primary, ["commit", "-q", "-m", "definition"]);
    const clone = mkdtempSync(join(tmpdir(), "hook-6871-clone-"));
    temps.push(clone);
    git(tmpdir(), ["clone", "-q", primary, clone]);
    const cloneOut = commit(primary, `git -C "${clone}" commit -m x`);
    expect(cloneOut).toMatchObject({ verdict: "deny", code: "foreign-repository-deny" });
  });

  it("treats a marker probe error other than not-found as present (#6871)", () => {
    const fail = (code: string) => () => {
      throw Object.assign(new Error(code), { code });
    };
    expect(commitTargetMayBeDirectiveProject("/r", fail("ENOENT"))).toBe(false);
    expect(commitTargetMayBeDirectiveProject("/r", fail("ENOTDIR"))).toBe(false);
    expect(commitTargetMayBeDirectiveProject("/r", fail("EACCES"))).toBe(true);
    expect(commitTargetMayBeDirectiveProject("/r", fail("EIO"))).toBe(true);
    expect(commitTargetMayBeDirectiveProject("/r", () => ({}))).toBe(true);
  });

  it("denies with the resolver's reason on a corrupt record or a conflicting pin", () => {
    const { primary, wtA } = cohort();
    stage(wtA, "packages/a/in.ts");
    const conflict = commit(primary, `git -C "${wtA}" commit -m x`, {
      [ACTIVE_SCOPE_PIN_ENV]: "xbrief/active/b-story.xbrief.json",
    });
    expect(conflict).toMatchObject({ verdict: "deny", code: "prospective-scope-cover-deny" });
    expect(conflict.message).toContain("(env_pin_conflict)");
    expect(conflict.message).toContain(`clear ${ACTIVE_SCOPE_PIN_ENV}`);
    expect(conflict.message.match(/Repair:/g)).toHaveLength(1);

    corruptIndex(primary);
    const corrupt = commit(primary, `cd "${wtA}" && git commit -m x`);
    expect(corrupt).toMatchObject({ verdict: "deny", code: "prospective-scope-cover-deny" });
    expect(corrupt.message).toContain("(registry_corruption)");
    expect(corrupt.message).not.toContain("Multiple active xBRIEF artifacts");
  });

  it("keeps today's selection for an unregistered linked worktree and the main worktree", () => {
    const { primary, wtC } = cohort();
    const pin = { [ACTIVE_SCOPE_PIN_ENV]: "xbrief/active/a-story.xbrief.json" };
    for (const [hookRoot, command] of [
      [primary, `git -C "${wtC}" commit -m x`],
      [primary, "git commit -m x"],
    ] as const) {
      const root = command.startsWith("git -C") ? wtC : primary;
      stage(root, "packages/a/in.ts");
      const unpinned = commit(hookRoot, command);
      expect(unpinned, command).toMatchObject({
        verdict: "deny",
        code: "prospective-scope-cover-deny",
      });
      expect(unpinned.message).toContain("Multiple active xBRIEF artifacts");
      expect(unpinned.message).not.toContain("Worktree story binding");
      expect(commit(hookRoot, command, pin).verdict, command).toBe("allow");
      unstageAll(root);
    }
    // The main worktree never reads the registry, so a corrupt record leaves it as it was.
    corruptIndex(primary);
    stage(primary, "packages/a/in.ts");
    expect(commit(primary, "git commit -m x", pin).verdict).toBe("allow");
  });

  it("passes an empty or lifecycle-only index on the target root, as before", () => {
    const { primary, wtA } = cohort();
    corruptIndex(primary);
    expect(commit(primary, `git -C "${wtA}" commit -m x`).verdict).toBe("allow");
    git(wtA, ["add", "--", "xbrief/active/a-story.xbrief.json"]);
    expect(commit(primary, `git -C "${wtA}" commit -m x`).verdict).toBe("allow");
  });
});

describe("prospective scope-cover uses the one-PR mint fence (#6361)", () => {
  const scopePath = "/project/xbrief/active/one-pr.xbrief.json";
  const ready = () => ({ ready: true, path: scopePath, message: "OK active scope" });

  it("covers staged paths inside a mint-admitted file_scope and refuses the rest", () => {
    const covered = evaluateProspectiveScopeCover({
      projectRoot: "/project",
      stagedRelPaths: ["src/a.ts"],
      inspectScope: ready,
      resolveStoryBinding: () => ({ kind: "none" }),
      loadStoryWriteFence: () => ({
        fileScope: ["src/a.ts"],
        denyPaths: [],
        onePrMint: { admitted: true },
      }),
    });
    expect(covered).toMatchObject({ ok: true, scopePath });
    const outside = evaluateProspectiveScopeCover({
      projectRoot: "/project",
      stagedRelPaths: ["src/b.ts"],
      inspectScope: ready,
      resolveStoryBinding: () => ({ kind: "none" }),
      loadStoryWriteFence: () => ({
        fileScope: ["src/a.ts"],
        denyPaths: [],
        onePrMint: { admitted: true },
      }),
    });
    expect(outside).toMatchObject({ ok: false, uncovered: ["src/b.ts"] });
  });

  it("names the mint reject reason and scope:record-approved-scope when the mint does not admit", () => {
    const denied = evaluateProspectiveScopeCover({
      projectRoot: "/project",
      stagedRelPaths: ["src/a.ts"],
      inspectScope: ready,
      resolveStoryBinding: () => ({ kind: "none" }),
      loadStoryWriteFence: () => ({
        fileScope: [],
        denyPaths: [],
        onePrMint: { admitted: false, reason: "no same-PR approved-scope record" },
      }),
    });
    expect(denied.ok).toBe(false);
    expect(denied.message).toContain("no same-PR approved-scope record");
    expect(denied.message).toContain("scope:record-approved-scope");
    expect(denied.message).not.toMatch(/scope:promote|scope:activate/);
  });
});
