import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { GitRunner, GitRunResult } from "../session/git.js";
import {
  normalizeScopePath,
  resolveCandidateBaseRef,
  resolveCandidateScope,
} from "./candidate-scope.js";

const temps: string[] = [];
afterAll(() => {
  for (const t of temps) {
    rmSync(t, { recursive: true, force: true });
  }
});

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "deft-candidate-scope-"));
  temps.push(root);
  return root;
}

function ok(stdout = ""): GitRunResult {
  return { code: 0, stdout, stderr: "" };
}

function fail(stderr = "no"): GitRunResult {
  return { code: 1, stdout: "", stderr };
}

/** Longest-prefix stub keyed on the joined git argv. */
function gitStub(routes: Record<string, GitRunResult>): GitRunner {
  return (_cwd, args) => {
    const key = args.join(" ");
    const match = Object.keys(routes)
      .filter((prefix) => key.startsWith(prefix))
      .sort((a, b) => b.length - a.length)[0];
    return match === undefined ? fail(`unstubbed: ${key}`) : (routes[match] as GitRunResult);
  };
}

function baseRoutes(root: string): Record<string, GitRunResult> {
  return {
    "rev-parse --show-toplevel": ok(root),
    "rev-parse --verify -q origin/master": ok("sha"),
    "merge-base --is-ancestor HEAD origin/master": fail(),
    "merge-base HEAD origin/master": ok("basesha"),
    "diff --name-only basesha": ok(""),
    "ls-files --others --exclude-standard": ok(""),
  };
}

describe("normalizeScopePath (#3893)", () => {
  it("returns an absolute path that compares equal across separators", () => {
    const root = makeRoot();
    const a = normalizeScopePath(join(root, "xbrief", "active", "s.xbrief.json"));
    const b = normalizeScopePath(`${root}/xbrief/active/s.xbrief.json`);
    expect(a).toBe(b);
    expect(resolve(a)).toBe(a);
  });
});

describe("resolveCandidateBaseRef (#3893)", () => {
  it("accepts an explicit ref that resolves", () => {
    const root = makeRoot();
    const runGit = gitStub({ "rev-parse --verify -q release": ok("sha") });
    expect(resolveCandidateBaseRef(root, "release", runGit)).toBe("release");
  });

  it("returns null for an explicit ref that does not resolve", () => {
    const root = makeRoot();
    expect(resolveCandidateBaseRef(root, "origin/nope", gitStub({}))).toBeNull();
  });

  it("prefers origin/<deliveryBranch> over the local branch", () => {
    const root = makeRoot();
    const runGit = gitStub({
      "rev-parse --verify -q origin/master": ok("sha"),
      "rev-parse --verify -q master": ok("sha"),
    });
    expect(resolveCandidateBaseRef(root, null, runGit)).toBe("origin/master");
  });
});

describe("resolveCandidateScope (#3893)", () => {
  it("sweeps repo-wide outside a git worktree", () => {
    const root = makeRoot();
    const scope = resolveCandidateScope(root, join(root, "xbrief", "active"), {
      runGit: gitStub({}),
    });
    expect(scope.kind).toBe("sweep");
    if (scope.kind !== "sweep") throw new Error("expected sweep");
    expect(scope.reason).toContain("not a git worktree");
  });

  it("sweeps repo-wide when the requested base ref is missing", () => {
    const root = makeRoot();
    const scope = resolveCandidateScope(root, join(root, "xbrief", "active"), {
      baseRef: "origin/absent",
      runGit: gitStub({ "rev-parse --show-toplevel": ok(root) }),
    });
    expect(scope.kind).toBe("sweep");
    if (scope.kind !== "sweep") throw new Error("expected sweep");
    expect(scope.reason).toContain("origin/absent");
  });

  it("sweeps repo-wide when no delivery base ref resolves", () => {
    const root = makeRoot();
    const scope = resolveCandidateScope(root, join(root, "xbrief", "active"), {
      runGit: gitStub({ "rev-parse --show-toplevel": ok(root) }),
    });
    expect(scope.kind).toBe("sweep");
    if (scope.kind !== "sweep") throw new Error("expected sweep");
    expect(scope.reason).toContain("no delivery base ref found");
  });

  it("sweeps repo-wide when HEAD is on the delivery line", () => {
    const root = makeRoot();
    const scope = resolveCandidateScope(root, join(root, "xbrief", "active"), {
      baseRef: "origin/master",
      runGit: gitStub({
        ...baseRoutes(root),
        "merge-base --is-ancestor HEAD origin/master": ok(""),
      }),
    });
    expect(scope.kind).toBe("sweep");
    if (scope.kind !== "sweep") throw new Error("expected sweep");
    expect(scope.reason).toContain("delivery-tip check");
  });

  it("returns the candidate's changed and untracked briefs", () => {
    const root = makeRoot();
    const scope = resolveCandidateScope(root, join(root, "xbrief", "active"), {
      baseRef: "origin/master",
      runGit: gitStub({
        ...baseRoutes(root),
        "diff --name-only basesha": ok("xbrief/active/tracked.xbrief.json\n"),
        "ls-files --others --exclude-standard": ok("xbrief/active/new.xbrief.json"),
      }),
    });
    expect(scope.kind).toBe("diff");
    if (scope.kind !== "diff") throw new Error("expected diff");
    expect(scope.baseRef).toBe("origin/master");
    expect([...scope.paths].sort()).toEqual(
      [
        normalizeScopePath(join(root, "xbrief", "active", "new.xbrief.json")),
        normalizeScopePath(join(root, "xbrief", "active", "tracked.xbrief.json")),
      ].sort(),
    );
  });

  it("sweeps repo-wide when the merge base cannot be computed", () => {
    const root = makeRoot();
    const scope = resolveCandidateScope(root, join(root, "xbrief", "active"), {
      baseRef: "origin/master",
      runGit: gitStub({ ...baseRoutes(root), "merge-base HEAD origin/master": fail() }),
    });
    expect(scope.kind).toBe("sweep");
    if (scope.kind !== "sweep") throw new Error("expected sweep");
    expect(scope.reason).toContain("merge base");
  });

  it("sweeps repo-wide when the merge base is empty", () => {
    const root = makeRoot();
    const scope = resolveCandidateScope(root, join(root, "xbrief", "active"), {
      baseRef: "origin/master",
      runGit: gitStub({ ...baseRoutes(root), "merge-base HEAD origin/master": ok("  ") }),
    });
    expect(scope.kind).toBe("sweep");
    if (scope.kind !== "sweep") throw new Error("expected sweep");
    expect(scope.reason).toContain("empty");
  });

  it("sweeps repo-wide when the diff fails", () => {
    const root = makeRoot();
    const scope = resolveCandidateScope(root, join(root, "xbrief", "active"), {
      baseRef: "origin/master",
      runGit: gitStub({ ...baseRoutes(root), "diff --name-only basesha": fail() }),
    });
    expect(scope.kind).toBe("sweep");
    if (scope.kind !== "sweep") throw new Error("expected sweep");
    expect(scope.reason).toContain("could not diff active/");
  });

  it("sweeps repo-wide when untracked briefs cannot be listed", () => {
    const root = makeRoot();
    const scope = resolveCandidateScope(root, join(root, "xbrief", "active"), {
      baseRef: "origin/master",
      runGit: gitStub({ ...baseRoutes(root), "ls-files --others --exclude-standard": fail() }),
    });
    expect(scope.kind).toBe("sweep");
    if (scope.kind !== "sweep") throw new Error("expected sweep");
    expect(scope.reason).toContain("untracked");
  });

  it("sweeps repo-wide when active/ is outside the worktree", () => {
    const root = makeRoot();
    const outside = resolve(root, "..", "elsewhere", "active");
    const scope = resolveCandidateScope(root, outside, {
      baseRef: "origin/master",
      runGit: gitStub(baseRoutes(root)),
    });
    expect(scope.kind).toBe("sweep");
    if (scope.kind !== "sweep") throw new Error("expected sweep");
    expect(scope.reason).toContain("outside the git worktree");
  });

  it("uses the real git runner by default and sweeps outside a worktree", () => {
    const root = makeRoot();
    const scope = resolveCandidateScope(root, join(root, "xbrief", "active"));
    expect(scope.kind).toBe("sweep");
  });

  it("sweeps repo-wide when the worktree root is empty", () => {
    const root = makeRoot();
    const scope = resolveCandidateScope(root, join(root, "xbrief", "active"), {
      baseRef: "origin/master",
      runGit: gitStub({ "rev-parse --show-toplevel": ok("   ") }),
    });
    expect(scope.kind).toBe("sweep");
    if (scope.kind !== "sweep") throw new Error("expected sweep");
    expect(scope.reason).toContain("worktree root");
  });
});
