import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HumanOriginGrant } from "../authz/types.js";
import { EXIT_OK, EXIT_VIOLATION } from "../release/constants.js";
import { emit, publishRepoTagTree, runPublish } from "./pipeline.js";
import type { PublishConfig } from "./types.js";

const baseConfig: PublishConfig = {
  version: "0.21.0",
  repo: "deftai/directive",
  projectRoot: ".",
  dryRun: false,
};

/** Bypass closed-verb gate in legacy publish path tests (#1095). */
const allowEnv = { DEFT_ALLOW_RELEASE_PUBLISH: "1" } as const;

function withBypass<T extends object>(seams: T): T & { closedVerbEnv: typeof allowEnv } {
  return { ...seams, closedVerbEnv: allowEnv };
}

function operatorPublishGrant(): HumanOriginGrant {
  return {
    schemaVersion: 1,
    id: "grant-publish-test",
    origin: {
      kind: "operator-cli",
      actor: "operator",
      mintedAt: "2026-07-30T00:00:00Z",
      mintedVia: "deft authz:grant",
      eventRef: "template:release-publish",
    },
    scope: {
      planRef: null,
      repo: null,
      branch: null,
      worktree: null,
      surfaces: ["0.21.0", "v0.21.0"],
      operations: ["release-publish"],
      storyIds: [],
      issueIds: [],
      cohortId: null,
    },
    semantics: {
      expiresAt: null,
      singleUse: false,
      usedAt: null,
      revokedAt: null,
    },
  };
}

describe("emit", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("writes publish prefix to stderr", () => {
    const spy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    emit("View v0.21.0", "OK");
    expect(spy).toHaveBeenCalledWith("[publish] View v0.21.0... OK\n");
  });
});

describe("runPublish", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("dry-run emits REST plan without gh calls", () => {
    const spy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const rc = runPublish({ ...baseConfig, dryRun: true });
    expect(rc).toBe(EXIT_OK);
    const out = spy.mock.calls.map((c) => String(c[0])).join("");
    expect(out).toContain("DRYRUN");
    expect(out).toContain("--paginate");
    expect(out).toContain("repos/deftai/directive/releases?per_page=100");
    expect(out).toContain("tag_name == v0.21.0");
    expect(out).toContain("-X PATCH");
    expect(out).toContain("draft=false");
    expect(out).not.toContain("release view");
    expect(out).not.toContain("/releases/tags/");
  });

  it("happy path draft to published", () => {
    const spy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    let viewCalls = 0;
    const seams = withBypass({
      whichGh: () => "/usr/bin/gh",
      spawnText: (_cmd: string, args: readonly string[]) => {
        if (args.includes("--paginate")) {
          viewCalls += 1;
          const draft = viewCalls === 1;
          return {
            status: 0,
            stdout: JSON.stringify([
              {
                id: 42,
                draft,
                tag_name: "v0.21.0",
                html_url: "https://example.com/r",
              },
            ]),
            stderr: "",
          };
        }
        return { status: 0, stdout: "{}", stderr: "" };
      },
    });
    const rc = runPublish(baseConfig, seams);
    expect(rc).toBe(EXIT_OK);
    const out = spy.mock.calls.map((c) => String(c[0])).join("");
    expect(out).toContain("draft found");
    expect(out).toContain("is now public");
    expect(out).toContain("published successfully");
  });

  it("not-found exits violation", () => {
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const seams = withBypass({
      whichGh: () => "/usr/bin/gh",
      spawnText: () => ({ status: 0, stdout: "[]", stderr: "" }),
    });
    expect(runPublish(baseConfig, seams)).toBe(EXIT_VIOLATION);
  });

  it("already published no-op", () => {
    const spy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const seams = withBypass({
      whichGh: () => "/usr/bin/gh",
      spawnText: () => ({
        status: 0,
        stdout: JSON.stringify([
          { id: 1, draft: false, tag_name: "v0.21.0", html_url: "https://example.com/r" },
        ]),
        stderr: "",
      }),
    });
    expect(runPublish(baseConfig, seams)).toBe(EXIT_OK);
    const out = spy.mock.calls.map((c) => String(c[0])).join("");
    expect(out).toContain("NOOP");
    expect(out).toContain("already published");
  });

  it("gh-error on view exits violation", () => {
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const seams = withBypass({
      whichGh: () => "/usr/bin/gh",
      spawnText: () => ({ status: 4, stdout: "", stderr: "auth required" }),
    });
    const rc = runPublish(baseConfig, seams);
    expect(rc).toBe(EXIT_VIOLATION);
  });

  it("edit failure exits violation", () => {
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    let n = 0;
    const seams = withBypass({
      whichGh: () => "/usr/bin/gh",
      spawnText: () => {
        n += 1;
        if (n === 1) {
          return {
            status: 0,
            stdout: JSON.stringify([
              { id: 7, draft: true, tag_name: "v0.21.0", html_url: "https://example.com/r" },
            ]),
            stderr: "",
          };
        }
        return { status: 1, stdout: "", stderr: "gh release edit failed: 404" };
      },
    });
    const rc = runPublish(baseConfig, seams);
    expect(rc).toBe(EXIT_VIOLATION);
  });

  it("post-edit verification mismatch exits violation", () => {
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const seams = withBypass({
      whichGh: () => "/usr/bin/gh",
      spawnText: (_cmd: string, args: readonly string[]) => {
        if (args.includes("--paginate")) {
          return {
            status: 0,
            stdout: JSON.stringify([
              { id: 9, draft: true, tag_name: "v0.21.0", html_url: "https://example.com/r" },
            ]),
            stderr: "",
          };
        }
        return { status: 0, stdout: "{}", stderr: "" };
      },
    });
    const rc = runPublish(baseConfig, seams);
    expect(rc).toBe(EXIT_VIOLATION);
  });

  it("uses no url fallback when payload url missing", () => {
    const spy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    let viewCalls = 0;
    const seams = withBypass({
      whichGh: () => "/usr/bin/gh",
      spawnText: (_cmd: string, args: readonly string[]) => {
        if (args.includes("--paginate")) {
          viewCalls += 1;
          const draft = viewCalls === 1;
          return {
            status: 0,
            stdout: JSON.stringify([{ id: 42, draft, tag_name: "v0.21.0" }]),
            stderr: "",
          };
        }
        return { status: 0, stdout: "{}", stderr: "" };
      },
    });
    runPublish(baseConfig, seams);
    const out = spy.mock.calls.map((c) => String(c[0])).join("");
    expect(out).toContain("<no url>");
  });

  it("fails closed without grant or DEFT_ALLOW_RELEASE_PUBLISH before draft→public", () => {
    const spy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    let edits = 0;
    const seams = {
      whichGh: () => "/usr/bin/gh",
      closedVerbEnv: {} as Record<string, string>,
      closedVerbGrants: [] as HumanOriginGrant[],
      spawnText: (_cmd: string, args: readonly string[]) => {
        if (args.includes("--paginate")) {
          return {
            status: 0,
            stdout: JSON.stringify([
              {
                id: 42,
                draft: true,
                tag_name: "v0.21.0",
                html_url: "https://example.com/r",
              },
            ]),
            stderr: "",
          };
        }
        edits += 1;
        return { status: 0, stdout: "{}", stderr: "" };
      },
    };
    const rc = runPublish(baseConfig, seams);
    expect(rc).toBe(EXIT_VIOLATION);
    expect(edits).toBe(0);
    const out = spy.mock.calls.map((c) => String(c[0])).join("");
    expect(out).toMatch(/closed-verb-deny|DEFT_ALLOW_RELEASE_PUBLISH|authz:grant/i);
  });

  it("names the searched project root on the [publish] deny line (#6864)", () => {
    const spy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const root = mkdtempSync(join(tmpdir(), "publish-deny-root-"));
    try {
      const seams = {
        whichGh: () => "/usr/bin/gh",
        closedVerbEnv: {} as Record<string, string>,
        closedVerbGrants: [] as HumanOriginGrant[],
        spawnText: (_cmd: string, args: readonly string[]) =>
          args.includes("--paginate")
            ? {
                status: 0,
                stdout: JSON.stringify([
                  { id: 42, draft: true, tag_name: "v0.21.0", html_url: "https://example.com/r" },
                ]),
                stderr: "",
              }
            : { status: 0, stdout: "{}", stderr: "" },
      };
      expect(runPublish({ ...baseConfig, projectRoot: root }, seams)).toBe(EXIT_VIOLATION);
      const deny = spy.mock.calls
        .map((c) => String(c[0]))
        .find((line) => line.startsWith("[publish] denied code="));
      expect(deny).toBeDefined();
      expect(deny).toContain(`projectRoot=${root}\n`);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("allows draft→public when matching operator-cli grant is present", () => {
    const spy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    let viewCalls = 0;
    const seams = {
      whichGh: () => "/usr/bin/gh",
      closedVerbEnv: {} as Record<string, string>,
      closedVerbGrants: [operatorPublishGrant()],
      spawnText: (_cmd: string, args: readonly string[]) => {
        if (args.includes("--paginate")) {
          viewCalls += 1;
          const draft = viewCalls === 1;
          return {
            status: 0,
            stdout: JSON.stringify([
              {
                id: 42,
                draft,
                tag_name: "v0.21.0",
                html_url: "https://example.com/r",
              },
            ]),
            stderr: "",
          };
        }
        return { status: 0, stdout: "{}", stderr: "" };
      },
    };
    const rc = runPublish(baseConfig, seams);
    expect(rc).toBe(EXIT_OK);
    const out = spy.mock.calls.map((c) => String(c[0])).join("");
    expect(out).toContain("closed-verb-allow");
    expect(out).toContain("published successfully");
  });

  it("fails closed when single-use grant spend returns null after publish (#4233)", () => {
    const spy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    let viewCalls = 0;
    const unusedSingleUse: HumanOriginGrant = {
      ...operatorPublishGrant(),
      id: "grant-publish-single",
      semantics: {
        expiresAt: null,
        singleUse: true,
        usedAt: null,
        revokedAt: null,
      },
    };
    const seams = {
      whichGh: () => "/usr/bin/gh",
      closedVerbEnv: {} as Record<string, string>,
      closedVerbGrants: [unusedSingleUse],
      spendGrant: () => null,
      // loadGrant is real; point projectRoot at a temp tree with the unused grant on disk.
      spawnText: (_cmd: string, args: readonly string[]) => {
        if (args.includes("--paginate")) {
          viewCalls += 1;
          const draft = viewCalls === 1;
          return {
            status: 0,
            stdout: JSON.stringify([
              {
                id: 42,
                draft,
                tag_name: "v0.21.0",
                html_url: "https://example.com/r",
              },
            ]),
            stderr: "",
          };
        }
        return { status: 0, stdout: "{}", stderr: "" };
      },
    };
    // Materialize grant so loadGrant sees unused single-use after mocked spend null.
    const root = mkdtempSync(join(tmpdir(), "publish-spend-"));
    try {
      const grantsDir = join(root, ".deft", "authz", "grants");
      mkdirSync(grantsDir, { recursive: true });
      writeFileSync(
        join(grantsDir, "grant-publish-single.json"),
        `${JSON.stringify(unusedSingleUse, null, 2)}\n`,
        "utf8",
      );
      const rc = runPublish({ ...baseConfig, projectRoot: root }, seams);
      expect(rc).toBe(EXIT_VIOLATION);
      const out = spy.mock.calls.map((c) => String(c[0])).join("");
      expect(out).toMatch(/usedAt write refused|was not spent/i);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("run-bound draft flip (#6875)", () => {
  const T = "t".repeat(40);
  const X = "x".repeat(40);
  const RUN = { grantId: "grant-run-6875" };
  const REF = "repos/deftai/directive/git/ref/tags/v0.21.0";

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function grant(id: string, surfaces: string[]): HumanOriginGrant {
    return { ...operatorPublishGrant(), id, scope: { ...operatorPublishGrant().scope, surfaces } };
  }

  /**
   * Draft on the first view, public after the edit. `trees` maps a repo to the
   * tree its tag v0.21.0 points to, read through REST (annotated tag by default).
   */
  function seams(opts: {
    grants: HumanOriginGrant[];
    trees?: Record<string, string>;
    lightweight?: boolean;
    refFails?: boolean;
  }) {
    const calls: string[][] = [];
    const trees = opts.trees ?? { "deftai/directive": T };
    let viewCalls = 0;
    const json = (value: unknown) => ({ status: 0, stdout: JSON.stringify(value), stderr: "" });
    return {
      calls,
      whichGh: () => "/usr/bin/gh",
      closedVerbEnv: {} as Record<string, string>,
      closedVerbGrants: opts.grants,
      spendGrant: () => null,
      spawnText: (_cmd: string, args: readonly string[]) => {
        calls.push([...args]);
        if (args.includes("--paginate")) {
          viewCalls += 1;
          const draft = viewCalls === 1;
          return json([{ id: 42, draft, tag_name: "v0.21.0", html_url: "u" }]);
        }
        const endpoint = args[1] ?? "";
        const repo = /^repos\/([^/]+\/[^/]+)\/git\//.exec(endpoint)?.[1] ?? "";
        if (endpoint.includes("/git/ref/tags/")) {
          if (opts.refFails) return { status: 1, stdout: "", stderr: "Not Found (HTTP 404)" };
          return json({
            object: opts.lightweight
              ? { type: "commit", sha: `commit-${repo}` }
              : { type: "tag", sha: `tagobj-${repo}` },
          });
        }
        if (endpoint.includes("/git/tags/")) {
          return json({ object: { type: "commit", sha: `commit-${repo}` } });
        }
        if (endpoint.includes("/git/commits/")) {
          return json({ tree: { sha: trees[repo] ?? "" } });
        }
        return { status: 0, stdout: "{}", stderr: "" };
      },
    };
  }

  const edited = (calls: string[][]): boolean => calls.some((a) => a.includes("PATCH"));
  const stderrText = (spy: { mock: { calls: unknown[][] } }): string =>
    spy.mock.calls.map((c) => String(c[0])).join("");

  it("flips with the run's grant for the tree the tag has on the publish repo", () => {
    const spy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const s = seams({ grants: [grant(RUN.grantId, [`0.21.0@${T}`])] });
    expect(runPublish(baseConfig, s, RUN)).toBe(EXIT_OK);
    expect(edited(s.calls)).toBe(true);
    const endpoints = s.calls.map((a) => a[1] ?? "");
    expect(endpoints).toContain(REF);
    expect(endpoints).toContain("repos/deftai/directive/git/tags/tagobj-deftai/directive");
    expect(endpoints).toContain("repos/deftai/directive/git/commits/commit-deftai/directive");
    expect(stderrText(spy)).toContain(`grant=${RUN.grantId}`);
  });

  it("never fetches locally or reads FETCH_HEAD or the origin remote", () => {
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const s = seams({ grants: [grant(RUN.grantId, [`0.21.0@${T}`])] });
    expect(runPublish(baseConfig, s, RUN)).toBe(EXIT_OK);
    const flat = s.calls.flat();
    expect(flat).not.toContain("fetch");
    expect(flat.some((a) => a.includes("FETCH_HEAD"))).toBe(false);
    expect(flat).not.toContain("origin");
  });

  it("reads a lightweight tag straight to its commit", () => {
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const s = seams({ lightweight: true, grants: [grant(RUN.grantId, [`0.21.0@${T}`])] });
    expect(runPublish(baseConfig, s, RUN)).toBe(EXIT_OK);
    expect(s.calls.some((a) => (a[1] ?? "").includes("/git/tags/"))).toBe(false);
  });

  it("refuses when the publish repo's tag points to another tree than the approved one", () => {
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    // The approved tree T exists only on another repo; the publish repo's tag has X.
    const s = seams({
      trees: { "other/fork": T, "deftai/directive": X },
      grants: [grant(RUN.grantId, [`0.21.0@${T}`])],
    });
    expect(runPublish(baseConfig, s, RUN)).toBe(EXIT_VIOLATION);
    expect(edited(s.calls)).toBe(false);
    expect(s.calls.every((a) => !(a[1] ?? "").startsWith("repos/other/fork/"))).toBe(true);
  });

  it("refuses a version-only grant under the run and names the bound mint target", () => {
    const spy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const s = seams({ grants: [grant(RUN.grantId, ["0.21.0", "v0.21.0"])] });
    expect(runPublish(baseConfig, s, RUN)).toBe(EXIT_VIOLATION);
    expect(edited(s.calls)).toBe(false);
    expect(stderrText(spy)).toContain(`--target 0.21.0@${T}`);
  });

  it("refuses another tree even with an empty-surface grant active", () => {
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const s = seams({
      trees: { "deftai/directive": X },
      grants: [grant(RUN.grantId, [`0.21.0@${T}`]), grant("broad", [])],
    });
    expect(runPublish(baseConfig, s, RUN)).toBe(EXIT_VIOLATION);
    expect(edited(s.calls)).toBe(false);
  });

  it("refuses when the tag cannot be read on the publish repo", () => {
    const spy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const s = seams({ refFails: true, grants: [grant(RUN.grantId, [`0.21.0@${T}`])] });
    expect(runPublish(baseConfig, s, RUN)).toBe(EXIT_VIOLATION);
    expect(edited(s.calls)).toBe(false);
    expect(stderrText(spy)).toContain(`gh api ${REF} failed`);
  });

  it("keeps the DEFT_ALLOW_RELEASE_PUBLISH break-glass bypass", () => {
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const s = { ...seams({ grants: [] }), closedVerbEnv: allowEnv };
    expect(runPublish(baseConfig, s, RUN)).toBe(EXIT_OK);
    expect(edited(s.calls)).toBe(true);
  });
});

describe("publishRepoTagTree (#6875)", () => {
  const ok = (value: unknown) => ({ status: 0, stdout: JSON.stringify(value), stderr: "" });

  function reader(answers: Record<string, ReturnType<typeof ok>>) {
    return {
      whichGh: () => "/usr/bin/gh",
      spawnText: (_cmd: string, args: readonly string[]) =>
        answers[args[1] ?? ""] ?? { status: 1, stdout: "", stderr: "unexpected" },
    };
  }

  it("refuses without gh, a non-object answer, a ref with no object, or a non-commit target", () => {
    expect(publishRepoTagTree("o/r", "v1", { whichGh: () => null }).ok).toBe(false);
    const ref = "repos/o/r/git/ref/tags/v1";
    expect(publishRepoTagTree("o/r", "v1", reader({ [ref]: ok([]) })).ok).toBe(false);
    expect(publishRepoTagTree("o/r", "v1", reader({ [ref]: ok({}) })).ok).toBe(false);
    const tree = publishRepoTagTree(
      "o/r",
      "v1",
      reader({ [ref]: ok({ object: { type: "tree", sha: "abc" } }) }),
    );
    expect(tree).toMatchObject({ ok: false });
    if (!tree.ok) expect(tree.reason).toContain("not a commit");
  });

  it("refuses an annotated tag with no object and a commit with no tree", () => {
    const ref = "repos/o/r/git/ref/tags/v1";
    const annotated = reader({
      [ref]: ok({ object: { type: "tag", sha: "t1" } }),
      "repos/o/r/git/tags/t1": ok({}),
    });
    expect(publishRepoTagTree("o/r", "v1", annotated).ok).toBe(false);
    const noTree = reader({
      [ref]: ok({ object: { type: "commit", sha: "c1" } }),
      "repos/o/r/git/commits/c1": ok({ tree: {} }),
    });
    expect(publishRepoTagTree("o/r", "v1", noTree).ok).toBe(false);
  });

  it("reports a gh spawn failure as a returned failure", () => {
    const throwing = {
      whichGh: () => "/usr/bin/gh",
      spawnText: () => {
        throw new Error("ENOENT");
      },
    };
    expect(publishRepoTagTree("o/r", "v1", throwing)).toEqual({
      ok: false,
      reason: "gh CLI not found on PATH",
    });
  });
});
