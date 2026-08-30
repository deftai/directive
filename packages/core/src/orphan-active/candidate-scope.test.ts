import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
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

/** `-z` output as `GitRunner` hands it back: NUL-delimited, latin1-decoded. */
function nulPaths(...paths: readonly string[]): GitRunResult {
  return ok(Buffer.from(paths.map((p) => `${p}\0`).join(""), "utf8").toString("latin1"));
}

function baseRoutes(root: string): Record<string, GitRunResult> {
  return {
    "rev-parse --show-toplevel": ok(root),
    "rev-parse --verify -q origin/master": ok("sha"),
    "merge-base --is-ancestor HEAD origin/master": fail(),
    "merge-base HEAD origin/master": ok("basesha"),
    "diff --name-only -z basesha": ok(""),
    "ls-files --others --exclude-standard -z": ok(""),
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

  it("does not throw for a path whose directory does not exist", () => {
    // Deletions in the candidate diff no longer exist on disk.
    const root = makeRoot();
    const gone = join(root, "absent-dir", "story.xbrief.json");
    expect(normalizeScopePath(gone)).toBe(normalizeScopePath(gone));
    expect(normalizeScopePath(gone).endsWith("story.xbrief.json")).toBe(true);
  });

  it("resolves an equivalent spelling of the same real directory", () => {
    // Same directory reached through a . / .. detour: the canonicalized form
    // is what makes a symlinked checkout root compare equal to git's.
    const root = makeRoot();
    const direct = join(root, "story.xbrief.json");
    const detour = join(root, "sub", "..", "story.xbrief.json");
    mkdirSync(join(root, "sub"), { recursive: true });
    expect(normalizeScopePath(detour)).toBe(normalizeScopePath(direct));
  });

  it("folds decomposed and precomposed Unicode to one form", () => {
    // git precomposes; some filesystems hand readdir the decomposed name.
    const root = makeRoot();
    const precomposed = join(root, "xbrief", "active", "caf\u00e9.xbrief.json");
    const decomposed = join(root, "xbrief", "active", "cafe\u0301.xbrief.json");
    expect(precomposed).not.toBe(decomposed);
    expect(normalizeScopePath(decomposed)).toBe(normalizeScopePath(precomposed));
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
        "diff --name-only -z basesha": nulPaths("xbrief/active/tracked.xbrief.json"),
        "ls-files --others --exclude-standard -z": nulPaths("xbrief/active/new.xbrief.json"),
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

  it("keeps a brief whose name git would C-quote inside the candidate scope", () => {
    // A newline-delimited read returns the quoted display form, which would drop
    // this brief out of scope and let an orphan the PR touched evade the gate.
    const root = makeRoot();
    const name = "2026-08-29-caf\u00e9-brief.xbrief.json";
    const scope = resolveCandidateScope(root, join(root, "xbrief", "active"), {
      baseRef: "origin/master",
      runGit: gitStub({
        ...baseRoutes(root),
        "diff --name-only -z basesha": nulPaths(`xbrief/active/${name}`),
      }),
    });
    expect(scope.kind).toBe("diff");
    if (scope.kind !== "diff") throw new Error("expected diff");
    expect(scope.paths.has(normalizeScopePath(join(root, "xbrief", "active", name)))).toBe(true);
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
      runGit: gitStub({ ...baseRoutes(root), "diff --name-only -z basesha": fail() }),
    });
    expect(scope.kind).toBe("sweep");
    if (scope.kind !== "sweep") throw new Error("expected sweep");
    expect(scope.reason).toContain("could not diff active/");
  });

  it("sweeps repo-wide when untracked briefs cannot be listed", () => {
    const root = makeRoot();
    const scope = resolveCandidateScope(root, join(root, "xbrief", "active"), {
      baseRef: "origin/master",
      runGit: gitStub({ ...baseRoutes(root), "ls-files --others --exclude-standard -z": fail() }),
    });
    expect(scope.kind).toBe("sweep");
    if (scope.kind !== "sweep") throw new Error("expected sweep");
    expect(scope.reason).toContain("untracked");
  });

  it("keeps the candidate diff when the worktree root spelling differs by Unicode form", () => {
    // git reports the precomposed root; the checkout path arrives decomposed.
    const precomposed = resolve(tmpdir(), "deft-caf\u00e9-root");
    const decomposed = resolve(tmpdir(), "deft-cafe\u0301-root");
    expect(precomposed).not.toBe(decomposed);
    const scope = resolveCandidateScope(decomposed, join(decomposed, "xbrief", "active"), {
      baseRef: "origin/master",
      runGit: gitStub({
        ...baseRoutes(precomposed),
        "diff --name-only -z basesha": nulPaths("xbrief/active/story.xbrief.json"),
      }),
    });
    expect(scope.kind).toBe("diff");
    if (scope.kind !== "diff") throw new Error("expected diff");
    expect(
      scope.paths.has(
        normalizeScopePath(join(precomposed, "xbrief", "active", "story.xbrief.json")),
      ),
    ).toBe(true);
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
