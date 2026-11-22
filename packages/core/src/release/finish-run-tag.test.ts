import { afterEach, describe, expect, it, vi } from "vitest";
import type { HumanOriginGrant } from "../authz/types.js";
import { releaseLine } from "../changelog/release-line.js";
import { EXIT_CONFIG_ERROR, EXIT_OK, EXIT_VIOLATION } from "./constants.js";
import { readRunTagState, runFinish } from "./finish.js";
import type { ReleaseConfig, ReleaseSeams, SpawnResult } from "./types.js";

const ok = (stdout = ""): SpawnResult => ({ status: 0, stdout, stderr: "" });
const fail = (stderr = "boom"): SpawnResult => ({ status: 1, stdout: "", stderr });

const V = "1.2.0";
const TAG = `v${V}`;
const M = "a".repeat(40);
const OTHER = "e".repeat(40);
const TAG_OBJECT = "f".repeat(40);
const B = "b".repeat(40);
const T = "c".repeat(40);
const RUN_GRANT = "grant-run-6877";
const RELEASED = `## [Unreleased]\n\n${releaseLine(V)}\n\n### Added\n\n## [${V}] - 2026-11-22\n\n- shipped\n`;

function grant(surfaces: string[]): HumanOriginGrant {
  return {
    schemaVersion: 1,
    id: RUN_GRANT,
    origin: {
      kind: "operator-cli",
      actor: "operator",
      mintedAt: "2026-11-22T00:00:00Z",
      mintedVia: "deft authz:grant",
      eventRef: "template:release-publish",
    },
    scope: {
      planRef: null,
      repo: null,
      branch: null,
      worktree: null,
      surfaces,
      operations: ["release-publish"],
      storyIds: [],
      issueIds: [],
      cohortId: null,
    },
    semantics: { expiresAt: null, singleUse: false, usedAt: null, revokedAt: null },
  };
}

function config(): ReleaseConfig {
  return {
    version: V,
    repo: "o/r",
    baseBranch: "master",
    projectRoot: "/p",
    dryRun: false,
    skipTag: false,
    skipRelease: true,
    allowDirty: false,
    draft: true,
    skipCi: false,
    skipBuild: false,
    summary: null,
    allowVbriefDrift: false,
    allowCoverageDebtIssue: null,
    allowSkipCiIssue: null,
    runBinding: { grantId: RUN_GRANT, expectedBase: B },
  };
}

interface TagWorld {
  /** Commit the local tag peels to; null when there is no local tag. */
  local?: string | null;
  /** ls-remote rows for the tag on origin. */
  remote?: string;
  parent?: string;
  grants?: HumanOriginGrant[];
}

/** A run-bound finish whose git answers come from the tag world. */
function seams(world: TagWorld = {}): ReleaseSeams & { calls: string[][]; err: string[] } {
  const calls: string[][] = [];
  const err: string[] = [];
  vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
    err.push(String(chunk));
    return true;
  });
  return {
    calls,
    err,
    findMergedReleasePr: () => ({ ok: true, number: 7, mergeCommit: M }),
    checkTagAvailable: () => [true, "ok"],
    namedMergeGateFn: (() => ({ ok: true })) as unknown as ReleaseSeams["namedMergeGateFn"],
    closedVerbEnv: {},
    closedVerbGrants: world.grants ?? [grant([`${V}@${T}`])],
    spawnText: (_c, a) => {
      calls.push([...a]);
      if (a.includes("rev-list")) return ok(`${M} ${world.parent ?? B}\n`);
      if (a.includes("tag") && a.includes("-l")) return ok(world.local ? `${TAG}\n` : "");
      if (a.includes("rev-parse")) {
        if (a.some((x) => x.includes("^{commit}"))) return ok(`${world.local ?? ""}\n`);
        return ok(`${T}\n`);
      }
      if (a.includes("ls-remote")) return ok(world.remote ?? "");
      if (a.includes("diff")) return ok("M\tCHANGELOG.md\nM\tROADMAP.md\n");
      if (a.includes("show")) return ok(RELEASED);
      if (a.includes("ls-tree")) return ok("");
      return ok();
    },
  };
}

const created = (calls: string[][]): boolean => calls.some((a) => a.includes("-a"));
const pushed = (calls: string[][]): boolean => calls.some((a) => a.includes("push"));
const annotated = (commit: string): string =>
  `${TAG_OBJECT}\trefs/tags/${TAG}\n${commit}\trefs/tags/${TAG}^{}\n`;

afterEach(() => {
  vi.restoreAllMocks();
});

describe("run-bound finish: the v<version> tag on --resume (#6877)", () => {
  it("clause 4: given a crash after the local tag on M and before its push, --resume pushes the tag and continues", () => {
    const s = seams({ local: M });
    expect(runFinish(config(), s)).toBe(EXIT_OK);
    expect(created(s.calls)).toBe(false);
    expect(pushed(s.calls)).toBe(true);
    expect(s.err.join("")).toContain("left only local");
    expect(s.err.join("")).toContain(`grant=${RUN_GRANT}`);
  });

  it("clause 4: the local-only tag is pushed only after the parent of M is checked against B", () => {
    const s = seams({ local: M, parent: OTHER });
    expect(runFinish(config(), s)).toBe(EXIT_VIOLATION);
    expect(pushed(s.calls)).toBe(false);
    expect(s.err.join("")).toContain("break-glass");
  });

  it("clause 4: the local-only tag is still pushed only under the run's grant", () => {
    const s = seams({ local: M, grants: [grant([V])] });
    expect(runFinish(config(), s)).toBe(EXIT_VIOLATION);
    expect(pushed(s.calls)).toBe(false);
  });

  it("clause 5: given a remote v<version> tag on a commit other than M, --resume stops", () => {
    const s = seams({ remote: annotated(OTHER) });
    expect(runFinish(config(), s)).toBe(EXIT_VIOLATION);
    expect(created(s.calls)).toBe(false);
    expect(pushed(s.calls)).toBe(false);
    expect(s.err.join("")).toContain("nothing overwritten");
  });

  it("clause 5: a remote lightweight v<version> tag on another commit also stops --resume", () => {
    const s = seams({ local: M, remote: `${OTHER}\trefs/tags/${TAG}\n` });
    expect(runFinish(config(), s)).toBe(EXIT_VIOLATION);
    expect(pushed(s.calls)).toBe(false);
  });

  it("a local tag on another commit stops and is not overwritten", () => {
    const s = seams({ local: OTHER });
    expect(runFinish(config(), s)).toBe(EXIT_VIOLATION);
    expect(created(s.calls)).toBe(false);
    expect(pushed(s.calls)).toBe(false);
  });

  it("a remote tag that peels to M is done: no new tag, no push", () => {
    const s = seams({ local: M, remote: annotated(M) });
    expect(runFinish(config(), s)).toBe(EXIT_OK);
    expect(created(s.calls)).toBe(false);
    expect(pushed(s.calls)).toBe(false);
  });

  it("with no tag yet, finish tags M and pushes as before", () => {
    const s = seams();
    expect(runFinish(config(), s)).toBe(EXIT_OK);
    expect(created(s.calls)).toBe(true);
    expect(pushed(s.calls)).toBe(true);
  });
});

describe("readRunTagState (#6877)", () => {
  const read = (answer: (a: readonly string[]) => SpawnResult) =>
    readRunTagState("/p", TAG, M, { spawnText: (_c, a) => answer(a) });

  it("reads absent, local-only, pushed and the stop states", () => {
    const world =
      (local: string | null, remote: string) =>
      (a: readonly string[]): SpawnResult => {
        if (a.includes("-l")) return ok(local === null ? "" : `${TAG}\n`);
        if (a.includes("rev-parse")) return ok(`${local ?? ""}\n`);
        return ok(remote);
      };
    expect(read(world(null, ""))).toEqual({ kind: "absent" });
    expect(read(world(M, ""))).toEqual({ kind: "local-only" });
    expect(read(world(null, annotated(M)))).toEqual({ kind: "pushed" });
    expect(read(world(M, `${M}\trefs/tags/${TAG}\n`))).toEqual({ kind: "pushed" });
    expect(read(world(null, annotated(OTHER))).kind).toBe("stop");
    expect(read(world(OTHER, "")).kind).toBe("stop");
  });

  it("reports git failures as config stops", () => {
    const failing = (verb: string) => (a: readonly string[]) =>
      a.includes(verb) ? fail() : a.includes("-l") ? ok(`${TAG}\n`) : ok(`${M}\n`);
    for (const verb of ["-l", "rev-parse", "ls-remote"]) {
      const state = read(failing(verb));
      expect(state).toMatchObject({ kind: "stop", config: true });
    }
  });

  it("finish returns a config error when the tag cannot be read", () => {
    const s = seams();
    const inner = s.spawnText;
    const broken: ReleaseSeams = {
      ...s,
      spawnText: (c, a, o) =>
        a.includes("ls-remote") ? fail("offline") : (inner?.(c, a, o) ?? ok()),
    };
    expect(runFinish(config(), broken)).toBe(EXIT_CONFIG_ERROR);
  });
});
