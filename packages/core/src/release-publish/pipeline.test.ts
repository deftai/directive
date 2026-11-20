import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HumanOriginGrant } from "../authz/types.js";
import { EXIT_OK, EXIT_VIOLATION } from "../release/constants.js";
import { emit, runPublish } from "./pipeline.js";
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
  const RUN = { grantId: "grant-run-6875" };

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function grant(id: string, surfaces: string[]): HumanOriginGrant {
    return { ...operatorPublishGrant(), id, scope: { ...operatorPublishGrant().scope, surfaces } };
  }

  /** Draft on the first view, public after the edit; the remote tag peels to `tree`. */
  function seams(opts: { tree?: string; fetchFails?: boolean; grants: HumanOriginGrant[] }) {
    const calls: string[][] = [];
    let viewCalls = 0;
    return {
      calls,
      whichGh: () => "/usr/bin/gh",
      closedVerbEnv: {} as Record<string, string>,
      closedVerbGrants: opts.grants,
      spendGrant: () => null,
      spawnText: (_cmd: string, args: readonly string[]) => {
        calls.push([...args]);
        if (args.includes("fetch")) {
          return opts.fetchFails
            ? { status: 1, stdout: "", stderr: "no such tag" }
            : { status: 0, stdout: "", stderr: "" };
        }
        if (args.includes("rev-parse")) {
          return { status: 0, stdout: `${opts.tree ?? T}\n`, stderr: "" };
        }
        if (args.includes("--paginate")) {
          viewCalls += 1;
          const draft = viewCalls === 1;
          return {
            status: 0,
            stdout: JSON.stringify([{ id: 42, draft, tag_name: "v0.21.0", html_url: "u" }]),
            stderr: "",
          };
        }
        return { status: 0, stdout: "{}", stderr: "" };
      },
    };
  }

  const edited = (calls: string[][]): boolean => calls.some((a) => a.includes("PATCH"));
  const stderrText = (spy: { mock: { calls: unknown[][] } }): string =>
    spy.mock.calls.map((c) => String(c[0])).join("");

  it("flips with the run's grant for <version>@<tree the remote tag peels to>", () => {
    const spy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const s = seams({ grants: [grant(RUN.grantId, [`0.21.0@${T}`])] });
    expect(runPublish(baseConfig, s, RUN)).toBe(EXIT_OK);
    expect(edited(s.calls)).toBe(true);
    const fetch = s.calls.find((a) => a.includes("fetch")) ?? [];
    expect(fetch).toContain("--no-tags");
    expect(fetch).toContain("refs/tags/v0.21.0");
    expect(s.calls.some((a) => a.includes("FETCH_HEAD^{tree}"))).toBe(true);
    expect(stderrText(spy)).toContain(`grant=${RUN.grantId}`);
  });

  it("refuses a version-only grant under the run and names the bound mint target", () => {
    const spy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const s = seams({ grants: [grant(RUN.grantId, ["0.21.0", "v0.21.0"])] });
    expect(runPublish(baseConfig, s, RUN)).toBe(EXIT_VIOLATION);
    expect(edited(s.calls)).toBe(false);
    expect(stderrText(spy)).toContain(`--target 0.21.0@${T}`);
  });

  it("refuses when the tag peels to another tree, even with an empty-surface grant active", () => {
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const s = seams({
      tree: "x".repeat(40),
      grants: [grant(RUN.grantId, [`0.21.0@${T}`]), grant("broad", [])],
    });
    expect(runPublish(baseConfig, s, RUN)).toBe(EXIT_VIOLATION);
    expect(edited(s.calls)).toBe(false);
  });

  it("refuses when the remote tag cannot be read", () => {
    const spy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const s = seams({ fetchFails: true, grants: [grant(RUN.grantId, [`0.21.0@${T}`])] });
    expect(runPublish(baseConfig, s, RUN)).toBe(EXIT_VIOLATION);
    expect(edited(s.calls)).toBe(false);
    expect(stderrText(spy)).toContain("git fetch of remote tag v0.21.0 failed");
  });

  it("keeps the DEFT_ALLOW_RELEASE_PUBLISH break-glass bypass", () => {
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const s = { ...seams({ grants: [] }), closedVerbEnv: allowEnv };
    expect(runPublish(baseConfig, s, RUN)).toBe(EXIT_OK);
    expect(edited(s.calls)).toBe(true);
  });
});
