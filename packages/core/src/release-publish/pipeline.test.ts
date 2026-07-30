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
});
