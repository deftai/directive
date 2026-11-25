import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HumanOriginGrant } from "../authz/types.js";
import { EXIT_CONFIG_ERROR, EXIT_OK, EXIT_VIOLATION } from "./constants.js";
import { releaseCommitSubject } from "./git.js";
import {
  cmdReleaseRun,
  DEFT_SKIP_SELF_COMPLETE,
  findRunGrants,
  parseReleaseRunFlags,
  RELEASE_RUN_HELP,
  type ReleaseRunOptions,
  type ReleaseRunSeams,
  releaseRunChildEnv,
  releaseRunFinalLines,
  releaseRunMintArgv,
  runReleaseRun,
} from "./run.js";
import type { ReadinessResult } from "./run-readiness.js";
import {
  POST_PUBLISH_FIXTURE_JOB,
  PROMOTE_LATEST_JOB_PREFIX,
  type WorkflowJob,
  type WorkflowRun,
} from "./run-reconcile.js";
import { readReleaseRunRecord, releaseRunRecordPath, writeReleaseRunRecord } from "./run-record.js";
import type { ReleaseConfig, SpawnResult } from "./types.js";

const V = "1.2.0";
const B = "b".repeat(40);
const R = "c".repeat(40);
const T = "d".repeat(40);
const EXPIRES = "2026-11-22T06:00:00Z";
const NOW = new Date("2026-11-22T01:00:00Z");
const CHANGELOG_AT_R = `## [Unreleased]\n\n## [${V}] - 2026-11-22\n\n### Added\n- release:run\n`;

const ok = (stdout = ""): SpawnResult => ({ status: 0, stdout, stderr: "" });

function grant(
  id: string,
  op: string,
  surfaces: string[],
  mintedAt = "2026-11-22T01:00:30Z",
): HumanOriginGrant {
  return {
    schemaVersion: 1,
    id,
    origin: {
      kind: "operator-cli",
      actor: "operator",
      mintedAt,
      mintedVia: "deft authz:grant",
      eventRef: `template:${op}`,
    },
    scope: {
      planRef: null,
      repo: null,
      branch: null,
      worktree: null,
      surfaces,
      operations: [op as HumanOriginGrant["scope"]["operations"][number]],
      storyIds: [],
      issueIds: [],
      cohortId: null,
    },
    semantics: { expiresAt: null, singleUse: false, usedAt: null, revokedAt: null },
  };
}

const PUBLISH_RUN: WorkflowRun = {
  id: 10,
  event: "push",
  headBranch: `v${V}`,
  headSha: R,
  status: "completed",
  conclusion: "success",
  createdAt: "2026-11-22T02:00:00Z",
  url: "https://github.com/o/r/actions/runs/10",
};
const PROMOTE_RUN: WorkflowRun = {
  ...PUBLISH_RUN,
  id: 20,
  event: "workflow_dispatch",
  headBranch: "master",
  createdAt: "2026-11-22T02:30:00Z",
  url: "https://github.com/o/r/actions/runs/20",
};
const PUBLISH_JOBS: WorkflowJob[] = [
  { id: 11, name: POST_PUBLISH_FIXTURE_JOB, status: "completed", conclusion: "success" },
];
const PROMOTE_JOBS: WorkflowJob[] = [
  {
    id: 21,
    name: `${PROMOTE_LATEST_JOB_PREFIX} (#5852)`,
    status: "completed",
    conclusion: "success",
  },
];

const PUBLISH = grant("g-publish", "release-publish", [`${V}@${T}`, `v${V}@${T}`]);
const PROMOTE = grant("g-promote", "release-promote-latest", [V, `v${V}`]);

interface Harness {
  readonly seams: ReleaseRunSeams;
  readonly calls: string[];
  readonly verbs: Array<{ argv: readonly string[]; interactive: boolean }>;
  readonly configs: Record<string, ReleaseConfig>;
  readonly printed: () => string;
  grants: HumanOriginGrant[];
}

function harness(
  opts: {
    tty?: boolean;
    readinessOk?: boolean;
    parent?: string;
    committed?: boolean;
    subject?: string;
  } = {},
): Harness {
  const calls: string[] = [];
  const verbs: Array<{ argv: readonly string[]; interactive: boolean }> = [];
  const configs: Record<string, ReleaseConfig> = {};
  let out = "";
  let branch = "master";
  const world: {
    release: "draft" | "published";
    latest: string;
    dispatchRuns: WorkflowRun[];
  } = { release: "draft", latest: "1.1.0", dispatchRuns: [] };
  // HEAD is B until the local cut commits R on it.
  let committed = opts.committed ?? false;
  const h: Harness = {
    calls,
    verbs,
    configs,
    printed: () => out,
    grants: [],
    seams: {
      now: () => NOW,
      isTty: () => opts.tty ?? true,
      out: (text) => {
        out += text;
      },
      release: {
        spawnText: (_cmd, args) => {
          const a = args.slice(2);
          if (a[0] === "fetch") return ok();
          if (a[0] === "switch") {
            branch = String(a[2]);
            calls.push(`git switch ${branch} ${String(a[3])}`);
            return ok();
          }
          if (a[0] === "rev-parse") {
            if (a[1] === "--abbrev-ref") return ok(`${branch}\n`);
            if (a[1] === "origin/master") return ok(`${B}\n`);
            if (a[1] === "HEAD") return ok(`${committed ? R : B}\n`);
            if (a[1] === "HEAD^{tree}") return ok(`${T}\n`);
            if (a[1] === "HEAD^") return ok(`${committed ? (opts.parent ?? B) : "a".repeat(40)}\n`);
          }
          if (a[0] === "log") {
            return ok(`${opts.subject ?? (committed ? releaseCommitSubject(V) : "older")}\n`);
          }
          if (a[0] === "show") return ok(CHANGELOG_AT_R);
          return { status: 1, stdout: "", stderr: `unexpected git ${a.join(" ")}` };
        },
      },
      readiness: () => {
        calls.push("readiness");
        const result: ReadinessResult = {
          ok: opts.readinessOk ?? true,
          checks: [
            {
              name: "CI reuse rule (item 3)",
              status: "report",
              detail: "CI reuse is provisional: Step 5 evaluates the rule again",
            },
          ],
          ci: { kind: "full", reason: "latest attempt failed", tipSha: B },
        };
        return result;
      },
      runVerb: (argv, o) => {
        verbs.push({ argv, interactive: o.interactive });
        calls.push(`verb ${argv[0] ?? ""}`);
        if (argv[0] === "authz:grant") {
          h.grants.push(argv.includes("release-promote-latest") ? PROMOTE : PUBLISH);
        }
        return 0;
      },
      runNode: (args) => {
        calls.push(`node ${String(args[1])}`);
        return 0;
      },
      cut: (c) => {
        configs.cut = c;
        calls.push("cut");
        committed = true;
        return EXIT_OK;
      },
      pushAndOpenPr: () => {
        calls.push("push-pr");
        return { ok: true, reason: "opened https://github.com/o/r/pull/77" };
      },
      merge: {
        watch: () => {
          calls.push("pr:watch");
          return { verdict: "CLEAN", headSha: "h".repeat(40), failedChecks: [] };
        },
        readTip: () => ({ ok: true, sha: B }),
        readQueue: () => ({ ok: true, prs: [], total: 0 }),
        enqueueAndWait: (pr, repo, _root, beforeEnqueue) => {
          calls.push(`pr:wait-mergeable-and-merge --wait ${String(pr)} ${repo}`);
          const refused = beforeEnqueue("h".repeat(40));
          return refused === null ? { kind: "merged" } : { kind: "other", detail: refused };
        },
      },
      finish: (c) => {
        configs.finish = c;
        calls.push("finish");
        return EXIT_OK;
      },
      // #6878: GitHub and npm as the reconciliation reads them.
      reconcile: {
        readTagCommit: () => ({ ok: true, sha: R }),
        listRuns: (_repo, q) => ({
          ok: true,
          runs: q.event === "push" ? [PUBLISH_RUN] : world.dispatchRuns,
        }),
        listJobs: (_repo, id) => {
          if (id === PUBLISH_RUN.id) calls.push("publish-watch");
          return { ok: true, jobs: id === PUBLISH_RUN.id ? PUBLISH_JOBS : PROMOTE_JOBS };
        },
        readJobLog: () => ({ ok: true, text: `2026-11-22T02:31:00Z   INPUT_TAG: v${V}\n` }),
        readDistTags: () => ({ ok: true, tags: { maintainer: V, latest: world.latest } }),
        viewRelease: () => [world.release, null, ""],
        loadGrant: () => null,
        sleepMs: () => undefined,
        nowMs: () => NOW.getTime(),
      },
      flip: (c, id) => {
        configs.flip = c;
        calls.push(`flip ${id}`);
        world.release = "published";
        return EXIT_OK;
      },
      promote: () => {
        calls.push("promote");
        world.dispatchRuns = [PROMOTE_RUN];
        world.latest = V;
        return EXIT_OK;
      },
      listGrants: () => h.grants,
    },
  };
  return h;
}

function options(root: string, overrides: Partial<ReleaseRunOptions> = {}): ReleaseRunOptions {
  return {
    version: V,
    repo: "o/r",
    baseBranch: "master",
    projectRoot: root,
    expires: EXPIRES,
    promoteLatest: false,
    resume: false,
    summary: null,
    ...overrides,
  };
}

describe("deft release:run (#6876)", () => {
  const dirs: string[] = [];
  afterEach(() => {
    vi.restoreAllMocks();
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });
  function root(): string {
    const dir = mkdtempSync(join(tmpdir(), "w6876-run-"));
    dirs.push(dir);
    return dir;
  }

  it("#7327: releaseRunChildEnv stamps DEFT_SKIP_SELF_COMPLETE for session:start/setup children", () => {
    const env = releaseRunChildEnv({ PATH: "/bin", [DEFT_SKIP_SELF_COMPLETE]: "0" });
    expect(env[DEFT_SKIP_SELF_COMPLETE]).toBe("1");
    expect(env.PATH).toBe("/bin");
  });

  it("clause 1: runs every phase in order and ends with the pin PR, local-update and npm i -g commands", () => {
    const dir = root();
    const h = harness();
    expect(runReleaseRun(options(dir, { promoteLatest: true }), h.seams)).toBe(EXIT_OK);
    expect(h.calls).toEqual([
      "readiness",
      `git switch release/v${V} ${B}`,
      "verb session:start",
      "node --write-cut-context",
      "cut",
      "verb authz:grant",
      "verb authz:grant",
      "push-pr",
      "pr:watch",
      "pr:wait-mergeable-and-merge --wait 77 o/r",
      "finish",
      "node --clear-cut-context",
      "publish-watch",
      "flip g-publish",
      "promote",
    ]);
    expect(h.verbs[0]?.argv).toEqual(["session:start", "--primary-claim-exception=release-cut"]);
    expect(h.configs.cut?.stopBeforePush).toBe(true);
    expect(h.configs.cut?.ciReuseAtReadiness).toBe("full");
    expect(h.configs.finish?.runBinding).toEqual({ grantId: "g-publish", expectedBase: B });
    const printed = h.printed();
    for (const text of releaseRunFinalLines(V, "master", dir)) expect(printed).toContain(text);
    expect(printed).toContain(`pnpm update -w @deftai/directive-runtime@${V}`);
    expect(printed).toContain("pnpm install --frozen-lockfile");
    expect(printed).toContain(`task release:local-update -- ${V} --checkout ${dir}`);
    expect(printed).toContain(`npm i -g @deftai/directive@${V}`);
    const record = readReleaseRunRecord(dir, V);
    expect(record.kind).toBe("ok");
    if (record.kind === "ok") {
      expect(record.record).toMatchObject({
        cutBase: B,
        releaseCommit: R,
        releaseTree: T,
        pr: 77,
        grants: { releasePublish: "g-publish", promoteLatest: "g-promote" },
      });
      expect(record.record.completed).toHaveLength(10);
    }
  });

  it("clause 2: a failed readiness check refuses before any write", () => {
    const dir = root();
    const h = harness({ readinessOk: false });
    expect(runReleaseRun(options(dir), h.seams)).toBe(EXIT_VIOLATION);
    expect(h.calls).toEqual(["readiness"]);
    expect(existsSync(releaseRunRecordPath(dir, V))).toBe(false);
    expect(h.printed()).toContain("refused: a readiness check failed; nothing was written");
  });

  it("clause 3: approve shows version, B, T and the CHANGELOG section, then mints <version>@<T> with the operator's --expires on a TTY", () => {
    const dir = root();
    const h = harness();
    expect(runReleaseRun(options(dir), h.seams)).toBe(EXIT_OK);
    const printed = h.printed();
    expect(printed).toContain(`version: ${V}`);
    expect(printed).toContain(`B (cut base): ${B}`);
    expect(printed).toContain(`T (release tree): ${T}`);
    expect(printed).toContain("- release:run");
    const mints = h.verbs.filter((v) => v.argv[0] === "authz:grant");
    expect(mints).toEqual([
      { argv: releaseRunMintArgv("release-publish", `${V}@${T}`, EXPIRES), interactive: true },
    ]);
    expect(h.calls).not.toContain("promote");
    expect(printed).toContain("SKIP (no release-promote-latest grant; latest unchanged)");
  });

  it("clause 3: without a TTY it prints the mint commands and stops; --resume records the grant ids and continues", () => {
    const dir = root();
    const h = harness({ tty: false });
    expect(runReleaseRun(options(dir, { promoteLatest: true }), h.seams)).toBe(EXIT_VIOLATION);
    const printed = h.printed();
    expect(printed).toContain(
      `deft authz:grant -- --template release-publish --target ${V}@${T} --expires ${EXPIRES} --confirm`,
    );
    expect(printed).toContain(
      `deft authz:grant -- --template release-promote-latest --target ${V} --expires ${EXPIRES} --confirm`,
    );
    expect(printed).toContain(`deft release:run ${V} --resume`);
    expect(h.calls).not.toContain("push-pr");
    expect(h.verbs.some((v) => v.argv[0] === "authz:grant")).toBe(false);

    // Resume before the mint: still stops and names the command again.
    expect(runReleaseRun(options(dir, { resume: true, expires: null }), h.seams)).toBe(
      EXIT_VIOLATION,
    );
    expect(h.printed()).toContain("No matching grant minted since approve asked");

    h.grants.push(PUBLISH, PROMOTE);
    h.calls.length = 0;
    expect(runReleaseRun(options(dir, { resume: true, expires: null }), h.seams)).toBe(EXIT_OK);
    expect(h.calls[0]).toBe("push-pr");
    expect(h.calls).not.toContain("cut");
    expect(h.calls).toContain("promote");
    const record = readReleaseRunRecord(dir, V);
    expect(record.kind === "ok" && record.record.grants).toEqual({
      releasePublish: "g-publish",
      promoteLatest: "g-promote",
    });
  });

  it("clause 5: after the one mint no later phase reads stdin, so none can prompt", () => {
    const dir = root();
    const h = harness();
    expect(runReleaseRun(options(dir, { promoteLatest: true }), h.seams)).toBe(EXIT_OK);
    const interactive = h.verbs.filter((v) => v.interactive);
    expect(interactive.every((v) => v.argv[0] === "authz:grant")).toBe(true);
    const lastMint = h.calls.lastIndexOf("verb authz:grant");
    const lastMintVerb = h.verbs.map((v) => v.argv[0]).lastIndexOf("authz:grant");
    expect(lastMint).toBeGreaterThan(0);
    // The merge phase runs in-process (#6877) and spawns no verb that could prompt.
    expect(h.calls.indexOf("pr:watch")).toBeGreaterThan(lastMint);
    expect(h.verbs.slice(lastMintVerb + 1).every((v) => !v.interactive)).toBe(true);
  });

  it("stops at the phase that fails and names the run record", () => {
    const dir = root();
    const h = harness();
    const failing: ReleaseRunSeams = { ...h.seams, finish: () => EXIT_VIOLATION };
    expect(runReleaseRun(options(dir), failing)).toBe(EXIT_VIOLATION);
    expect(h.printed()).toContain(`stopped at finish; run record ${releaseRunRecordPath(dir, V)}`);
  });

  it("refuses a release commit whose parent is not the cut base", () => {
    const dir = root();
    const h = harness({ parent: "e".repeat(40) });
    expect(runReleaseRun(options(dir), h.seams)).toBe(EXIT_VIOLATION);
    expect(h.printed()).toContain("is not the cut base B=");
  });

  it("refuses a new run without --expires, over an existing record, or --resume without one", () => {
    const dir = root();
    const h = harness();
    expect(runReleaseRun(options(dir, { expires: null }), h.seams)).toBe(EXIT_CONFIG_ERROR);
    expect(runReleaseRun(options(dir, { resume: true }), h.seams)).toBe(EXIT_CONFIG_ERROR);
    expect(runReleaseRun(options(dir), { ...h.seams, cut: () => EXIT_VIOLATION })).toBe(
      EXIT_VIOLATION,
    );
    expect(runReleaseRun(options(dir), h.seams)).toBe(EXIT_CONFIG_ERROR);
    expect(h.printed()).toContain("pass --resume to continue it");
  });

  it("refuses an invalid run record", () => {
    const dir = root();
    const h = harness();
    expect(runReleaseRun(options(dir), { ...h.seams, cut: () => EXIT_VIOLATION })).toBe(
      EXIT_VIOLATION,
    );
    const record = readReleaseRunRecord(dir, V);
    if (record.kind !== "ok") throw new Error("record missing");
    writeReleaseRunRecord(dir, { ...record.record, schema: "bad" as never });
    expect(runReleaseRun(options(dir, { resume: true }), h.seams)).toBe(EXIT_CONFIG_ERROR);
    expect(h.printed()).toContain("is invalid");
    expect(readFileSync(releaseRunRecordPath(dir, V), "utf8")).toContain('"bad"');
  });
});

describe("findRunGrants (#6876)", () => {
  it("records only grants minted since approve asked, bound to <version>@<T>", () => {
    const base = {
      version: V,
      repo: "o/r",
      releaseTree: T,
      approveRequestedAt: "2026-11-22T01:00:00Z",
      promoteLatest: true,
    } as Parameters<typeof findRunGrants>[0];
    const old = grant("g-old", "release-publish", [`${V}@${T}`], "2026-11-21T00:00:00Z");
    const versionOnly = grant("g-version", "release-publish", [V, `v${V}`]);
    const otherTree = grant("g-other", "release-publish", [`${V}@${"9".repeat(40)}`]);
    expect(findRunGrants(base, ".", [old, versionOnly, otherTree])).toEqual({
      releasePublish: null,
      promoteLatest: null,
    });
    expect(findRunGrants(base, ".", [old, PUBLISH, PROMOTE])).toEqual({
      releasePublish: "g-publish",
      promoteLatest: "g-promote",
    });
    expect(findRunGrants({ ...base, approveRequestedAt: null }, ".", [PUBLISH])).toEqual({
      releasePublish: null,
      promoteLatest: null,
    });
  });
});

describe("release:run flags and entry (#6876)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("parses every flag form", () => {
    const flags = parseReleaseRunFlags([
      "--",
      "v1.2.0",
      "--expires",
      EXPIRES,
      "--promote-latest",
      "--resume",
      "--summary=one line",
      "--repo",
      "o/r",
      "--base-branch=main",
      "--project-root",
      "/p",
    ]);
    expect(flags).toMatchObject({
      version: V,
      expires: EXPIRES,
      promoteLatest: true,
      resume: true,
      summary: "one line",
      repo: "o/r",
      baseBranch: "main",
      projectRoot: "/p",
      unknown: [],
    });
    expect(parseReleaseRunFlags(["1.2.0", "2.0.0", "--x", "--summary=", "--repo"]).unknown).toEqual(
      ["2.0.0", "--x", "--summary= (empty value)", "--repo (missing value)"],
    );
  });

  it("prints help and refuses bad argv with exit 2", () => {
    const out = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    expect(cmdReleaseRun(["--help"])).toBe(EXIT_OK);
    expect(String(out.mock.calls[0]?.[0])).toBe(RELEASE_RUN_HELP);
    expect(cmdReleaseRun([])).toBe(EXIT_CONFIG_ERROR);
    expect(cmdReleaseRun(["1.2.0", "--bogus"])).toBe(EXIT_CONFIG_ERROR);
    expect(cmdReleaseRun(["not-a-version"])).toBe(EXIT_CONFIG_ERROR);
    const seams: ReleaseRunSeams = { now: () => NOW };
    expect(cmdReleaseRun([V, "--expires", "soon"], seams)).toBe(EXIT_CONFIG_ERROR);
    expect(cmdReleaseRun([V, "--expires", "2026-11-21T00:00:00Z"], seams)).toBe(EXIT_CONFIG_ERROR);
  });

  it("runs through cmdReleaseRun with the resolved root and repo", () => {
    const dir = mkdtempSync(join(tmpdir(), "w6876-cmd-"));
    try {
      const h = harness({ readinessOk: false });
      expect(
        cmdReleaseRun([V, "--expires", EXPIRES, "--repo", "o/r", "--project-root", dir], h.seams),
      ).toBe(EXIT_VIOLATION);
      expect(h.calls).toEqual(["readiness"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("release:run phase failures (#6876)", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });
  function root(): string {
    const dir = mkdtempSync(join(tmpdir(), "w6876-fail-"));
    dirs.push(dir);
    return dir;
  }
  function failingGit(h: Harness, match: (a: readonly string[]) => boolean): ReleaseRunSeams {
    const base = h.seams.release?.spawnText;
    return {
      ...h.seams,
      release: {
        spawnText: (cmd, args, o) =>
          match(args.slice(2))
            ? { status: 1, stdout: "", stderr: "git failed" }
            : (base?.(cmd, args, o) ?? ok()),
      },
    };
  }

  it("stops on each failing phase and keeps the run resumable", () => {
    const cases: Array<[string, (h: Harness) => ReleaseRunSeams, string]> = [
      ["fetch", (h) => failingGit(h, (a) => a[0] === "fetch"), "setup"],
      ["tip", (h) => failingGit(h, (a) => a[1] === "origin/master"), "setup"],
      ["switch", (h) => failingGit(h, (a) => a[0] === "switch"), "setup"],
      ["ritual", (h) => ({ ...h.seams, runVerb: () => 3 }), "setup"],
      ["marker", (h) => ({ ...h.seams, runNode: () => 1 }), "setup"],
      ["cut tree", (h) => failingGit(h, (a) => a[1] === "HEAD^{tree}"), "cut"],
      [
        "mint",
        (h) => ({
          ...h.seams,
          runVerb: (argv, o) => (argv[0] === "authz:grant" ? 1 : (h.seams.runVerb?.(argv, o) ?? 0)),
        }),
        "approve",
      ],
      [
        "push",
        (h) => ({ ...h.seams, pushAndOpenPr: () => ({ ok: false, reason: "no push" }) }),
        "push-pr",
      ],
      [
        "pr number",
        (h) => ({
          ...h.seams,
          pushAndOpenPr: () => ({ ok: true, reason: "opened the release PR" }),
        }),
        "push-pr",
      ],
      [
        "merge",
        (h) => ({
          ...h.seams,
          merge: {
            ...h.seams.merge,
            enqueueAndWait: () => ({ kind: "other", detail: "head-changed" }),
          },
        }),
        "merge",
      ],
      [
        "clear",
        (h) => ({ ...h.seams, runNode: (args) => (args[1] === "--clear-cut-context" ? 1 : 0) }),
        "finish",
      ],
      [
        "npm",
        (h) => ({
          ...h.seams,
          reconcile: { ...h.seams.reconcile, readTagCommit: () => ({ ok: false, reason: "boom" }) },
        }),
        "publish-watch",
      ],
      ["flip", (h) => ({ ...h.seams, flip: () => EXIT_VIOLATION }), "flip"],
      ["promote", (h) => ({ ...h.seams, promote: () => EXIT_VIOLATION }), "promote"],
    ];
    for (const [name, make, phase] of cases) {
      const dir = root();
      const h = harness();
      const code = runReleaseRun(options(dir, { promoteLatest: true }), make(h));
      expect(code, name).not.toBe(EXIT_OK);
      expect(h.printed(), name).toContain(`stopped at ${phase}`);
    }
  });

  it("resumes setup on the recorded release branch and refuses another branch", () => {
    const dir = root();
    const h = harness();
    expect(runReleaseRun(options(dir), { ...h.seams, runVerb: () => 3 })).toBe(EXIT_VIOLATION);
    h.calls.length = 0;
    expect(runReleaseRun(options(dir, { resume: true }), h.seams)).toBe(EXIT_OK);
    expect(h.calls.some((c) => c.startsWith("git switch"))).toBe(false);
    expect(h.calls).toContain("verb session:start");

    const other = root();
    const h2 = harness();
    expect(runReleaseRun(options(other), { ...h2.seams, runVerb: () => 3 })).toBe(EXIT_VIOLATION);
    const wrongBranch = failingGit(h2, (a) => a[1] === "--abbrev-ref");
    expect(runReleaseRun(options(other, { resume: true }), wrongBranch)).toBe(EXIT_VIOLATION);
    expect(h2.printed()).toContain(`is not on release/v${V}`);
  });
});

describe("release:run review fixes (#6876)", () => {
  const dirs: string[] = [];
  afterEach(() => {
    vi.restoreAllMocks();
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });
  function root(): string {
    const dir = mkdtempSync(join(tmpdir(), "w6876-fix-"));
    dirs.push(dir);
    return dir;
  }

  it("adopts a release commit on B that an earlier run made but did not record", () => {
    const dir = root();
    const h = harness();
    const base = h.seams.release?.spawnText;
    let failTree = true;
    const flaky: ReleaseRunSeams = {
      ...h.seams,
      release: {
        spawnText: (cmd, args, o) =>
          failTree && args.slice(2)[1] === "HEAD^{tree}"
            ? { status: 1, stdout: "", stderr: "interrupted" }
            : (base?.(cmd, args, o) ?? ok()),
      },
    };
    expect(runReleaseRun(options(dir), flaky)).toBe(EXIT_VIOLATION);
    const before = readReleaseRunRecord(dir, V);
    expect(before.kind === "ok" && before.record.releaseCommit).toBeNull();
    failTree = false;
    h.calls.length = 0;
    expect(runReleaseRun(options(dir, { resume: true }), flaky)).toBe(EXIT_OK);
    expect(h.calls).not.toContain("cut");
    expect(h.printed()).toContain("found the release commit on B from an earlier run");
  });

  it("stops without cutting when HEAD is neither B nor a release commit on B", () => {
    const dir = root();
    const h = harness({ committed: true, subject: "some other commit" });
    expect(runReleaseRun(options(dir), h.seams)).toBe(EXIT_VIOLATION);
    expect(h.calls).not.toContain("cut");
    expect(h.printed()).toContain("HEAD is neither the cut base B nor a release commit on B");
  });

  it("names the run's PR and repository on the merge phase (#6877)", () => {
    const dir = root();
    const h = harness();
    expect(runReleaseRun(options(dir), h.seams)).toBe(EXIT_OK);
    expect(h.calls).toContain("pr:wait-mergeable-and-merge --wait 77 o/r");
    const saved = readReleaseRunRecord(dir, V);
    expect(saved.kind === "ok" && saved.record.enqueue?.head).toBe("h".repeat(40));
  });

  it("keeps the merge phase re-run count across --resume (#6877)", () => {
    const dir = root();
    const failed = {
      verdict: "CI_BLOCKED",
      headSha: "h".repeat(40),
      failedChecks: ["Merge gate (task check) (failure)"],
    };
    const reruns: string[] = [];
    const h = harness();
    const blocked = (): ReleaseRunSeams => ({
      ...h.seams,
      merge: {
        ...h.seams.merge,
        watch: () => failed,
        rerunFailedChecks: (_r, sha) => {
          reruns.push(sha);
          return { ok: true, runIds: ["1"] };
        },
      },
    });
    expect(runReleaseRun(options(dir), blocked())).toBe(EXIT_VIOLATION);
    expect(reruns).toHaveLength(1);
    const saved = readReleaseRunRecord(dir, V);
    expect(saved.kind === "ok" && saved.record.retries.failedCheck).toBe(1);
    expect(runReleaseRun(options(dir, { resume: true }), blocked())).toBe(EXIT_VIOLATION);
    expect(reruns).toHaveLength(1);
    expect(h.printed()).toContain("without another re-run");
  });

  it("refuses a prerelease version up front", () => {
    const err = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    expect(cmdReleaseRun(["2.4.0-rc.1", "--expires", EXPIRES], { now: () => NOW })).toBe(
      EXIT_CONFIG_ERROR,
    );
    expect(String(err.mock.calls[0]?.[0])).toContain("cuts stable X.Y.Z versions only");
  });
});
