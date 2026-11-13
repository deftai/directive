/**
 * #6189 Prefer-A Bound fixture matrix (a)-(h): the active story write fence
 * governs the repository, not host memory or temp scratch.
 *
 * Limb 1: outside-root targets skip the path layer in runtimeAuthorityForDirectWrite.
 * Limb 4: project scopes.edits=false still denies an outside-root Write.
 * Limb 5: #5656 positive-allow is skipped only for a non-empty, fully classified
 * harvest whose every target is outside fenceRoot.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { DEFAULT_RUNTIME_AUTHORITY_POLICY } from "../policy/runtime-authority.js";
import {
  decideHook,
  type HookDispatchInput,
  type HookPolicySeams,
  isOutsideProjectRootWrite,
  POSITIVE_GOVERNING_ALLOW_REQUIRED,
} from "./index.js";

const temps: string[] = [];
const sharedTemps: string[] = [];
afterEach(() => {
  for (const t of temps.splice(0)) rmSync(t, { recursive: true, force: true });
});
afterAll(() => {
  for (const t of sharedTemps.splice(0)) rmSync(t, { recursive: true, force: true });
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

const READY_SCOPE = {
  ready: true,
  path: "/project/xbrief/active/story.xbrief.json",
  message: "OK active scope",
};

const NOT_READY_SCOPE = {
  ready: false,
  path: null,
  message: "No active xBRIEF artifact was found under xbrief/active/",
};

const OUTSIDE_ABS = "/home/user/.claude/projects/slug/memory/note.md";
const STORY_SCOPE = { fileScope: ["src/**"], denyPaths: [] };
const EMPTY_STORY_SCOPE = { fileScope: [], denyPaths: [] };
const ENV = { DEFT_SESSION_ID: "owner" };

/** Ready story, non-empty file_scope `src/**`, project runtimeAuthority disabled. */
function seams(overrides: Partial<HookPolicySeams> = {}): HookPolicySeams {
  return {
    verifyRitual: () => READY_RITUAL,
    inspectScope: () => READY_SCOPE,
    sessionStart: () => ({ code: 0, stdout: "", stderr: "" }),
    runningInsideDeftRepo: () => true,
    realpathLifecycleExecutionRoot: (path) => resolve(path),
    // Merge-base loader returns no fence when no scope is selected.
    loadStoryWriteFence: (_root, scopePath) =>
      scopePath === null ? EMPTY_STORY_SCOPE : STORY_SCOPE,
    ...overrides,
  };
}

/** Project runtimeAuthority enabled with scopes.edits=false (limb 4). */
const EDITS_OFF = {
  ...DEFAULT_RUNTIME_AUTHORITY_POLICY,
  enabled: true,
  scopes: { edits: false, push: false, merge: false },
};

function write(projectRoot: string, filePath: string, tool = "Write"): HookDispatchInput {
  return {
    host: "claude",
    event: "tool.before",
    projectRoot,
    payload: { tool_name: tool, cwd: projectRoot, tool_input: { file_path: filePath } },
    environ: ENV,
  };
}

function applyPatch(projectRoot: string, body: string, path?: string): HookDispatchInput {
  return {
    host: "cursor",
    event: "tool.before",
    projectRoot,
    payload: {
      tool_name: "ApplyPatch",
      tool_input: { ...(path === undefined ? {} : { path }), patch: body },
    },
    environ: ENV,
  };
}

function twoFilePatch(first: string, second: string): string {
  return `*** Begin Patch\n*** Add File: ${first}\n+a\n*** Add File: ${second}\n+b\n*** End Patch`;
}

describe("#6189 (a) absolute outside-root target, ready story with file_scope", () => {
  it.each(["Write", "Edit"])("allows %s through the path fence", (tool) => {
    const decision = decideHook(write("/project", OUTSIDE_ABS, tool), seams());
    expect(decision).toMatchObject({ verdict: "allow", code: "write-ready" });
  });

  it("still denies an in-repo file_scope miss (control)", () => {
    const decision = decideHook(write("/project", "/project/docs/readme.md"), seams());
    expect(decision).toMatchObject({ verdict: "deny", code: "runtime-policy-deny-path" });
    expect(decision.message).toContain("story file_scope");
  });

  it("allows an in-repo file_scope hit (control)", () => {
    const decision = decideHook(write("/project", "/project/src/a.ts"), seams());
    expect(decision).toMatchObject({ verdict: "allow", code: "write-ready" });
  });
});

describe("#6189 (b) lexical ../ outside-root target", () => {
  it("allows a ../ relative target through the path fence", () => {
    expect(isOutsideProjectRootWrite("/project", "../scratch/note.md")).toBe(true);
    const decision = decideHook(write("/project", "../scratch/note.md"), seams());
    expect(decision).toMatchObject({ verdict: "allow", code: "write-ready" });
  });

  it("keeps an in-repo ..-prefixed filename fenced", () => {
    expect(isOutsideProjectRootWrite("/project", "..notes/x.md")).toBe(false);
    const decision = decideHook(write("/project", "/project/..notes/x.md"), seams());
    expect(decision).toMatchObject({ verdict: "deny", code: "runtime-policy-deny-path" });
    expect(decision.message).toContain("story file_scope");
  });
});

describe("#6189 (c) mixed harvest", () => {
  const inRepoMiss = "/project/docs/b.md";

  it.each([
    ["outside first", OUTSIDE_ABS, inRepoMiss],
    ["in-repo first", inRepoMiss, OUTSIDE_ABS],
  ])("skips the outside member and still denies the in-repo miss (%s)", (_label, a, b) => {
    const decision = decideHook(applyPatch("/project", twoFilePatch(a, b)), seams());
    expect(decision).toMatchObject({ verdict: "deny", code: "runtime-policy-deny-path" });
    expect(decision.message).toContain("docs/b.md");
    expect(decision.message).toContain("story file_scope");
  });

  it("allows outside plus an in-repo file_scope hit", () => {
    const body = twoFilePatch(OUTSIDE_ABS, "/project/src/a.ts");
    const decision = decideHook(applyPatch("/project", body), seams());
    expect(decision).toMatchObject({ verdict: "allow", code: "write-ready" });
  });
});

describe("#6189 (d) symlink that re-enters the project", () => {
  it("keeps a lexically outside alias of an in-repo file fenced", () => {
    const projectDir = mkdtempSync(join(tmpdir(), "hook-6189-proj-"));
    const outsideDir = mkdtempSync(join(tmpdir(), "hook-6189-out-"));
    temps.push(projectDir, outsideDir);
    mkdirSync(join(projectDir, "docs"), { recursive: true });
    writeFileSync(join(projectDir, "docs", "inside.md"), "inside", "utf8");
    // Junctions need no elevation on win32; POSIX uses a dir symlink.
    symlinkSync(
      join(projectDir, "docs"),
      join(outsideDir, "alias"),
      process.platform === "win32" ? "junction" : "dir",
    );
    const aliased = join(outsideDir, "alias", "inside.md");
    expect(isOutsideProjectRootWrite(projectDir, aliased)).toBe(false);

    const decision = decideHook(write(projectDir, aliased), seams());
    expect(decision).toMatchObject({ verdict: "deny", code: "runtime-policy-deny-path" });
    expect(decision.message).toContain("story file_scope");
  });
});

describe("#6189 (e) project scopes.edits=false (limb 4)", () => {
  it("still denies an outside-root Write with runtime-policy-deny-scope", () => {
    const decision = decideHook(
      write("/project", OUTSIDE_ABS),
      seams({ loadRuntimeAuthority: () => EDITS_OFF }),
    );
    expect(decision).toMatchObject({ verdict: "deny", code: "runtime-policy-deny-scope" });
    expect(decision.message).toContain("scopes.edits is false");
  });

  it("does not let project allowPaths deny an outside-root Write", () => {
    const decision = decideHook(
      write("/project", OUTSIDE_ABS),
      seams({
        loadRuntimeAuthority: () => ({
          ...DEFAULT_RUNTIME_AUTHORITY_POLICY,
          enabled: true,
          allowPaths: ["src/**"],
          denyPaths: ["**/memory/**"],
        }),
      }),
    );
    expect(decision).toMatchObject({ verdict: "allow", code: "write-ready" });
  });
});

describe("#6189 (f) #2885 scope-not-ready carve-out unchanged", () => {
  it("allows an outside-root Write when no scope is ready", () => {
    const decision = decideHook(
      write("/project", OUTSIDE_ABS),
      seams({ inspectScope: () => NOT_READY_SCOPE }),
    );
    expect(decision.verdict).toBe("allow");
    expect(decision.code).not.toBe("scope-not-ready");
  });

  it("denies an in-repo Write when no scope is ready", () => {
    const decision = decideHook(
      write("/project", "/project/src/a.ts"),
      seams({ inspectScope: () => NOT_READY_SCOPE }),
    );
    expect(decision).toMatchObject({ verdict: "deny", code: "scope-not-ready" });
  });
});

describe("#6189 (g) linked worktrees", () => {
  type Fixture = { primary: string; nested: string; sibling: string; outside: string };
  let fx: Fixture;

  function git(cwd: string, args: readonly string[]): void {
    execFileSync("git", [...args], { cwd, encoding: "utf8" });
  }

  beforeAll(() => {
    const base = mkdtempSync(join(tmpdir(), "hook-6189-wt-"));
    sharedTemps.push(base);
    const primary = join(base, "primary");
    mkdirSync(primary, { recursive: true });
    git(primary, ["init", "-q"]);
    git(primary, ["config", "user.email", "t@t.dev"]);
    git(primary, ["config", "user.name", "t"]);
    git(primary, ["commit", "--allow-empty", "-q", "-m", "base"]);
    const nested = join(primary, ".deft-scratch", "worktrees", "story");
    mkdirSync(join(primary, ".deft-scratch", "worktrees"), { recursive: true });
    git(primary, ["worktree", "add", "--detach", "-q", nested]);
    const sibling = join(base, "sibling");
    git(primary, ["worktree", "add", "--detach", "-q", sibling]);
    const outside = mkdtempSync(join(tmpdir(), "hook-6189-scratch-"));
    sharedTemps.push(outside);
    fx = { primary, nested, sibling, outside };
  }, 60_000);

  /** Ready story with file_scope `src/**` only in `readyRoot`. */
  function treeSeams(readyRoot: string): HookPolicySeams {
    return seams({
      inspectScope: (root) =>
        resolve(root) === resolve(readyRoot)
          ? { ...READY_SCOPE, path: join(readyRoot, "xbrief", "active", "story.xbrief.json") }
          : NOT_READY_SCOPE,
    });
  }

  it("allows an absolute host/temp Write from a worktree under the payload", () => {
    const decision = decideHook(
      write(fx.nested, join(fx.outside, "note.md")),
      treeSeams(fx.nested),
    );
    expect(decision).toMatchObject({ verdict: "allow", code: "write-ready" });
  });

  it("still denies an in-worktree file_scope miss", () => {
    const decision = decideHook(
      write(fx.nested, join(fx.nested, "packages", "a.ts")),
      treeSeams(fx.nested),
    );
    expect(decision).toMatchObject({ verdict: "deny", code: "runtime-policy-deny-path" });
    expect(decision.message).toContain("story file_scope");
  });

  it("still denies a miss in a nested worktree written from the primary", () => {
    const decision = decideHook(
      write(fx.primary, join(fx.nested, "packages", "a.ts")),
      treeSeams(fx.nested),
    );
    expect(decision).toMatchObject({ verdict: "deny", code: "runtime-policy-deny-path" });
    expect(decision.message).toContain("story file_scope");
  });

  it("anchors on fenceRoot: a sibling worktree outside the payload stays fenced", () => {
    // Outside payloadRoot, so a projectRoot anchor would skip the fence here.
    expect(isOutsideProjectRootWrite(fx.primary, join(fx.sibling, "packages", "a.ts"))).toBe(true);
    const decision = decideHook(
      write(fx.primary, join(fx.sibling, "packages", "a.ts")),
      treeSeams(fx.sibling),
    );
    expect(decision).toMatchObject({ verdict: "deny", code: "runtime-policy-deny-path" });
    expect(decision.message).toContain("story file_scope");
  });

  it("allows an in-worktree file_scope hit (control)", () => {
    const decision = decideHook(
      write(fx.nested, join(fx.nested, "src", "a.ts")),
      treeSeams(fx.nested),
    );
    expect(decision).toMatchObject({ verdict: "allow", code: "write-ready" });
  });
});

describe("#6189 (h) ready story with empty merge-base file_scope (activation-PR window)", () => {
  const emptyScope = (overrides: Partial<HookPolicySeams> = {}) =>
    seams({ loadStoryWriteFence: () => EMPTY_STORY_SCOPE, ...overrides });

  function expectPositiveAllowDeny(decision: ReturnType<typeof decideHook>): void {
    expect(decision).toMatchObject({ verdict: "deny", code: "scope-not-ready" });
    expect(decision.message).toContain(POSITIVE_GOVERNING_ALLOW_REQUIRED);
  }

  it("admits an absolute outside-root Write past #5656 positive-allow", () => {
    const decision = decideHook(write("/project", OUTSIDE_ABS), emptyScope());
    expect(decision).toMatchObject({ verdict: "allow", code: "write-ready" });
  });

  it("still denies an in-repo Write with the #5656 message", () => {
    expectPositiveAllowDeny(decideHook(write("/project", "/project/src/a.ts"), emptyScope()));
  });

  it("still denies a mixed outside + in-repo harvest with the #5656 message", () => {
    const body = twoFilePatch(OUTSIDE_ABS, "/project/src/a.ts");
    expectPositiveAllowDeny(decideHook(applyPatch("/project", body), emptyScope()));
  });

  it("still denies an outside-root Write under project scopes.edits=false", () => {
    const decision = decideHook(
      write("/project", OUTSIDE_ABS),
      emptyScope({ loadRuntimeAuthority: () => EDITS_OFF }),
    );
    expect(decision).toMatchObject({ verdict: "deny", code: "runtime-policy-deny-scope" });
  });

  it("still denies an empty Write harvest with the #5656 message", () => {
    const decision = decideHook(
      {
        host: "claude",
        event: "tool.before",
        projectRoot: "/project",
        payload: { tool_name: "Write", cwd: "/project", tool_input: { content: "x" } },
        environ: ENV,
      },
      emptyScope(),
    );
    expectPositiveAllowDeny(decision);
  });

  it("still denies an unclassified apply_patch body with the #5656 message", () => {
    // Declared path is outside the root, but the body names no mutation header.
    const decision = decideHook(
      applyPatch("/project", "not a patch body", OUTSIDE_ABS),
      emptyScope(),
    );
    expectPositiveAllowDeny(decision);
  });

  it("keeps the positive-allow requirement for implement-class spawn", () => {
    const decision = decideHook(
      {
        host: "claude",
        event: "tool.before",
        projectRoot: "/project",
        payload: {
          tool_name: "Task",
          tool_input: {
            subagent_type: "generalPurpose",
            isolation: "worktree",
            prompt: `implement the fix and write ${OUTSIDE_ABS}`,
          },
        },
        environ: {},
      },
      emptyScope(),
    );
    expect(decision).toMatchObject({ verdict: "deny", code: "spawn-not-ready" });
    expect(decision.message).toContain(POSITIVE_GOVERNING_ALLOW_REQUIRED);
  });
});
