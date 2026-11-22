import { describe, expect, it } from "vitest";
import type { HumanOriginGrant } from "../authz/types.js";
import { WORKSPACE_PACKAGES } from "./cli-drift-report.js";
import { EXIT_OK, EXIT_VIOLATION } from "./constants.js";
import {
  type DistTags,
  defaultListJobs,
  defaultListRuns,
  defaultReadJobLog,
  defaultReadRun,
  defaultReadTagCommit,
  POST_PUBLISH_FIXTURE_JOB,
  PROMOTE_LATEST_JOB_PREFIX,
  promotedTagOf,
  type ReconcileContext,
  type ReconcileSeams,
  reconcileFlip,
  reconcilePromote,
  reconcilePublishWatch,
  type WorkflowJob,
  type WorkflowRun,
} from "./run-reconcile.js";
import { newReleaseRunRecord, type ReleaseRunRecord } from "./run-record.js";
import type { ReleaseConfig } from "./types.js";

const V = "1.2.0";
const TAG = `v${V}`;
const M = "a".repeat(40);
const T = "d".repeat(40);
const OTHER = "e".repeat(40);
const NOW = Date.parse("2026-11-22T03:00:00Z");
const [RUNTIME, CLI] = WORKSPACE_PACKAGES;

function grant(
  id: string,
  op: string,
  semantics: Partial<HumanOriginGrant["semantics"]> = {},
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
      surfaces: [`${V}@${T}`],
      operations: [op as HumanOriginGrant["scope"]["operations"][number]],
      storyIds: [],
      issueIds: [],
      cohortId: null,
    },
    semantics: { expiresAt: null, singleUse: true, usedAt: null, revokedAt: null, ...semantics },
  };
}

function run(id: number, over: Partial<WorkflowRun> = {}): WorkflowRun {
  return {
    id,
    event: "push",
    headBranch: TAG,
    headSha: M,
    status: "completed",
    conclusion: "success",
    createdAt: "2026-11-22T02:00:00Z",
    url: `https://github.com/o/r/actions/runs/${String(id)}`,
    ...over,
  };
}

const PUBLISH_JOBS: WorkflowJob[] = [
  {
    id: 101,
    name: "Prepare and pack @deftai/directive*",
    status: "completed",
    conclusion: "success",
  },
  {
    id: 102,
    name: "Publish @deftai/directive* to npm",
    status: "completed",
    conclusion: "success",
  },
  { id: 103, name: POST_PUBLISH_FIXTURE_JOB, status: "completed", conclusion: "success" },
  {
    id: 104,
    name: `${PROMOTE_LATEST_JOB_PREFIX} (#5852)`,
    status: "completed",
    conclusion: "skipped",
  },
];
/** A promote job; its log names the tag it promoted (job id 200 promotes TAG). */
const promoteJobs = (id = 200): WorkflowJob[] => [
  {
    id: id + 1,
    name: "Prepare and pack @deftai/directive*",
    status: "completed",
    conclusion: "skipped",
  },
  { id, name: `${PROMOTE_LATEST_JOB_PREFIX} (#5852)`, status: "in_progress", conclusion: null },
];
const PROMOTE_JOBS = promoteJobs();
const REPUBLISH_JOBS: WorkflowJob[] = [
  {
    id: 301,
    name: "Prepare and pack @deftai/directive*",
    status: "completed",
    conclusion: "success",
  },
  {
    id: 302,
    name: `${PROMOTE_LATEST_JOB_PREFIX} (#5852)`,
    status: "completed",
    conclusion: "skipped",
  },
];
const promoteLog = (tag: string): string =>
  `2026-11-22T03:19:11.8188517Z env:\r\n2026-11-22T03:19:11.8188517Z   INPUT_TAG: ${tag}\r\n2026-11-22T03:19:12.5Z [36;1mVERSION="\${INPUT_TAG#v}"[0m\r\n`;

interface World {
  tagCommit: string | null;
  pushRuns: WorkflowRun[];
  dispatchRuns: WorkflowRun[];
  /** Successive readRun answers per run id; the last one repeats. */
  runReads: Record<number, WorkflowRun[]>;
  jobs: Record<number, WorkflowJob[]>;
  /** Successive dist-tag answers per package; the last one repeats. */
  tags: Record<string, DistTags[]>;
  release: "draft" | "published" | "not-found" | "gh-error";
  /** Job logs by job id; job 200 promotes TAG unless set. */
  logs: Record<number, string>;
  active: HumanOriginGrant[];
  stored: Record<string, HumanOriginGrant>;
  /** Called on dispatch; may add the run the dispatch starts. */
  onDispatch?: (w: World) => number;
}

function world(over: Partial<World> = {}): World {
  return {
    tagCommit: M,
    pushRuns: [run(10)],
    dispatchRuns: [],
    runReads: {},
    jobs: { 10: PUBLISH_JOBS },
    tags: {
      [RUNTIME]: [{ maintainer: V, latest: "1.1.0" }],
      [CLI]: [{ maintainer: V, latest: "1.1.0" }],
    },
    release: "draft",
    logs: { 200: promoteLog(TAG) },
    active: [],
    stored: {},
    ...over,
  };
}

interface Rig {
  readonly ctx: ReconcileContext;
  readonly seams: ReconcileSeams;
  readonly lines: string[];
  readonly printed: string[];
  readonly calls: string[];
  record: () => ReleaseRunRecord;
}

function rig(w: World, grants: ReleaseRunRecord["grants"]): Rig {
  let record: ReleaseRunRecord = {
    ...newReleaseRunRecord({
      version: V,
      repo: "o/r",
      baseBranch: "master",
      expires: "2026-11-22T02:30:00Z",
      promoteLatest: grants.promoteLatest !== null,
      summary: null,
      ciReuseAtReadiness: null,
      now: new Date(NOW),
    }),
    releaseTree: T,
    approveRequestedAt: "2026-11-22T01:00:00Z",
    grants,
  };
  const lines: string[] = [];
  const printed: string[] = [];
  const calls: string[] = [];
  const reads: Record<string, number> = {};
  const next = <X>(key: string, list: X[]): X => {
    const i = reads[key] ?? 0;
    reads[key] = i + 1;
    return list[Math.min(i, list.length - 1)] as X;
  };
  let clock = NOW;
  const config = { version: V, repo: "o/r", projectRoot: "/p" } as ReleaseConfig;
  const ctx: ReconcileContext = {
    projectRoot: "/p",
    config,
    record: () => record,
    save: (patch) => {
      record = { ...record, ...patch };
    },
    line: (s) => lines.push(s),
    out: (t) => printed.push(t),
    listGrants: () => w.active,
    findGrants: (active) => ({
      releasePublish:
        active.filter((g) => g.scope.operations.includes("release-publish")).at(-1)?.id ?? null,
      promoteLatest:
        active.filter((g) => g.scope.operations.includes("release-promote-latest")).at(-1)?.id ??
        null,
    }),
    mintCommand: (kind) =>
      kind === "releasePublish"
        ? `deft authz:grant -- --template release-publish --target ${V}@${T} --expires <ISO> --confirm`
        : `deft authz:grant -- --template release-promote-latest --target ${V} --expires <ISO> --confirm`,
    flip: (_c, id) => {
      calls.push(`flip ${id}`);
      w.release = "published";
      return EXIT_OK;
    },
    promote: (_c, id) => {
      calls.push(`promote ${id}`);
      return w.onDispatch === undefined ? EXIT_OK : w.onDispatch(w);
    },
  };
  const seams: ReconcileSeams = {
    readTagCommit: () => ({ ok: true, sha: w.tagCommit }),
    listRuns: (_repo, q) => {
      calls.push(`list ${q.event}`);
      return { ok: true, runs: q.event === "push" ? w.pushRuns : w.dispatchRuns };
    },
    readRun: (_repo, id) => {
      const list = w.runReads[id];
      const found =
        list === undefined
          ? [...w.pushRuns, ...w.dispatchRuns].find((r) => r.id === id)
          : next(`run${String(id)}`, list);
      return found === undefined ? { ok: false, reason: "no run" } : { ok: true, run: found };
    },
    listJobs: (_repo, id) => ({ ok: true, jobs: w.jobs[id] ?? [] }),
    readJobLog: (_repo, id) => {
      const text = w.logs[id];
      return text === undefined ? { ok: false, reason: "no log" } : { ok: true, text };
    },
    readDistTags: (name) => ({ ok: true, tags: next(`tags${name}`, w.tags[name] ?? [{}]) }),
    viewRelease: () => [
      w.release,
      { isDraft: w.release === "draft", name: TAG, tagName: TAG, url: "u", id: 1 },
      w.release === "gh-error" ? "boom" : "",
    ],
    loadGrant: (_root, id) => w.stored[id] ?? null,
    sleepMs: (ms) => {
      calls.push("sleep");
      clock += ms;
    },
    nowMs: () => clock,
  };
  return { ctx, seams, lines, printed, calls, record: () => record };
}

const NO_GRANTS = { releasePublish: null, promoteLatest: null };
const dispatched = (r: Rig): number => r.calls.filter((c) => c.startsWith("promote ")).length;

describe("publish watch by reconciliation (#6878)", () => {
  it("clause 2: npm is done when the tag-triggered run at M and its fixture concluded success and both packages are on maintainer", () => {
    const r = rig(world(), NO_GRANTS);
    expect(reconcilePublishWatch(r.ctx, r.seams)).toBe(EXIT_OK);
    expect(r.lines.at(-1)).toContain("concluded success with its post-publish fixture");
    expect(r.lines.at(-1)).toContain("#6966");
  });

  it("clause 2: a run in progress is waited on, then judged", () => {
    const w = world({
      pushRuns: [run(10, { status: "in_progress", conclusion: null })],
      runReads: { 10: [run(10, { status: "in_progress", conclusion: null }), run(10)] },
    });
    const r = rig(w, NO_GRANTS);
    expect(reconcilePublishWatch(r.ctx, r.seams)).toBe(EXIT_OK);
    expect(r.calls).toContain("sleep");
    expect(r.lines[0]).toContain("waiting on");
  });

  it("clause 5: given one package published and a failed publish workflow run, the run stops and dispatches no republish", () => {
    const w = world({
      pushRuns: [run(10, { conclusion: "failure" })],
      tags: { [RUNTIME]: [{ maintainer: V }], [CLI]: [{ maintainer: "1.1.0" }] },
    });
    const r = rig(w, NO_GRANTS);
    expect(reconcilePublishWatch(r.ctx, r.seams)).toBe(EXIT_VIOLATION);
    expect(r.lines.at(-1)).toContain("concluded failure");
    expect(r.lines.at(-1)).toContain("never dispatches the manual republish workflow");
    expect(r.calls.some((c) => c.startsWith("promote") || c.includes("dispatch"))).toBe(false);
  });

  it("clause 1: only the tag-triggered run at M counts; a run on another commit stops", () => {
    const r = rig(world({ pushRuns: [run(10, { headSha: OTHER })] }), NO_GRANTS);
    expect(reconcilePublishWatch(r.ctx, r.seams)).toBe(EXIT_VIOLATION);
    expect(r.lines.at(-1)).toContain("not M");
  });

  it("clause 1: a fixture job that did not conclude success stops", () => {
    const jobs = PUBLISH_JOBS.map((j) =>
      j.name === POST_PUBLISH_FIXTURE_JOB ? { ...j, conclusion: "skipped" } : j,
    );
    const r = rig(world({ jobs: { 10: jobs } }), NO_GRANTS);
    expect(reconcilePublishWatch(r.ctx, r.seams)).toBe(EXIT_VIOLATION);
    expect(r.lines.at(-1)).toContain(`${POST_PUBLISH_FIXTURE_JOB} job`);
  });

  it("clause 2: npm is not done while a package lacks the version on maintainer", () => {
    const w = world({ tags: { [RUNTIME]: [{ maintainer: V }], [CLI]: [{ maintainer: "1.1.0" }] } });
    const r = rig(w, NO_GRANTS);
    expect(reconcilePublishWatch(r.ctx, r.seams)).toBe(EXIT_VIOLATION);
    expect(r.lines.at(-1)).toContain("npm is not done");
  });

  it("stops with no remote tag, and when no tag-triggered run shows up within the wait", () => {
    const noTag = rig(world({ tagCommit: null }), NO_GRANTS);
    expect(reconcilePublishWatch(noTag.ctx, noTag.seams)).toBe(EXIT_VIOLATION);
    expect(noTag.lines.at(-1)).toContain(`origin has no tag ${TAG}`);
    const noRun = rig(world({ pushRuns: [] }), NO_GRANTS);
    expect(reconcilePublishWatch(noRun.ctx, noRun.seams)).toBe(EXIT_VIOLATION);
    expect(noRun.lines.at(-1)).toContain("no tag-triggered npm-publish.yml run");
  });
});

describe("draft flip by reconciliation (#6878)", () => {
  const publish = grant("g-publish", "release-publish");

  it("clause 2: a published release is done without a grant", () => {
    const r = rig(world({ release: "published" }), NO_GRANTS);
    expect(reconcileFlip(r.ctx, r.seams)).toBe(EXIT_OK);
    expect(r.calls).not.toContain("flip g-publish");
  });

  it("clause 2: a draft is flipped with the run's active grant; a missing release stops", () => {
    const r = rig(world({ active: [publish] }), {
      releasePublish: "g-publish",
      promoteLatest: null,
    });
    expect(reconcileFlip(r.ctx, r.seams)).toBe(EXIT_OK);
    expect(r.calls).toContain("flip g-publish");
    const missing = rig(world({ release: "not-found" }), NO_GRANTS);
    expect(reconcileFlip(missing.ctx, missing.seams)).toBe(EXIT_VIOLATION);
  });

  it("clause 6: given an expired release-publish grant when the draft flip is due, the run stops and names the mint command", () => {
    const expired = grant("g-publish", "release-publish", { expiresAt: "2026-11-22T02:30:00Z" });
    const r = rig(world({ stored: { "g-publish": expired } }), {
      releasePublish: "g-publish",
      promoteLatest: null,
    });
    expect(reconcileFlip(r.ctx, r.seams)).toBe(EXIT_VIOLATION);
    expect(r.calls).not.toContain("flip g-publish");
    expect(r.printed.join("")).toContain(
      `deft authz:grant -- --template release-publish --target ${V}@${T} --expires <ISO> --confirm`,
    );
    expect(r.lines.at(-1)).toContain("expired at 2026-11-22T02:30:00Z");
  });

  it("uses an operator remint for the same target in place of a spent grant", () => {
    const spent = grant("g-publish", "release-publish", { usedAt: "2026-11-22T02:40:00Z" });
    const remint = grant("g-publish-2", "release-publish", {}, "2026-11-22T02:50:00Z");
    const r = rig(world({ active: [remint], stored: { "g-publish": spent } }), {
      releasePublish: "g-publish",
      promoteLatest: null,
    });
    expect(reconcileFlip(r.ctx, r.seams)).toBe(EXIT_OK);
    expect(r.calls).toContain("flip g-publish-2");
    expect(r.record().grants.releasePublish).toBe("g-publish-2");
  });
});

describe("promote by reconciliation (#6878)", () => {
  const promote = grant("g-promote", "release-promote-latest");
  const GRANTS = { releasePublish: "g-publish", promoteLatest: "g-promote" };
  const onLatest = {
    [RUNTIME]: [{ maintainer: V, latest: V }],
    [CLI]: [{ maintainer: V, latest: V }],
  };
  const dispatchStarts =
    (conclusion: string) =>
    (w: World): number => {
      w.dispatchRuns = [
        run(20, {
          event: "workflow_dispatch",
          headBranch: "master",
          createdAt: "2026-11-22T02:30:00Z",
          conclusion,
        }),
      ];
      w.jobs[20] = PROMOTE_JOBS;
      w.tags = conclusion === "success" ? onLatest : w.tags;
      return EXIT_OK;
    };

  it("clause 10: given no promote grant, the run ends with latest unchanged", () => {
    const r = rig(world(), { releasePublish: "g-publish", promoteLatest: null });
    expect(reconcilePromote(r.ctx, r.seams)).toBe(EXIT_OK);
    expect(r.lines).toEqual(["SKIP (no release-promote-latest grant; latest unchanged)"]);
    expect(dispatched(r)).toBe(0);
  });

  it("clause 7: given a promote grant minted up front and a green post-publish fixture, promote dispatches once", () => {
    const w = world({ active: [promote], onDispatch: dispatchStarts("success") });
    const r = rig(w, GRANTS);
    expect(reconcilePromote(r.ctx, r.seams)).toBe(EXIT_OK);
    expect(dispatched(r)).toBe(1);
    expect(r.lines.at(-1)).toContain(`both packages on latest at ${V}`);
  });

  it("clause 8: both packages on latest and the promote run still in progress: --resume waits and does not mark promote done", () => {
    const inProgress = run(20, {
      event: "workflow_dispatch",
      headBranch: "master",
      createdAt: "2026-11-22T02:30:00Z",
      status: "in_progress",
      conclusion: null,
    });
    const w = world({
      active: [],
      dispatchRuns: [inProgress],
      runReads: {
        20: [inProgress, inProgress, { ...inProgress, status: "completed", conclusion: "failure" }],
      },
      jobs: { 10: PUBLISH_JOBS, 20: PROMOTE_JOBS },
      tags: onLatest,
    });
    const r = rig(w, GRANTS);
    expect(reconcilePromote(r.ctx, r.seams)).toBe(EXIT_VIOLATION);
    expect(r.calls.filter((c) => c === "sleep").length).toBeGreaterThanOrEqual(2);
    expect(r.lines.at(-1)).toContain("concluded failure; no new dispatch");
    expect(dispatched(r)).toBe(0);
  });

  it("clause 8: given a failed promote run, the run stops and does not dispatch again", () => {
    const failed = run(20, {
      event: "workflow_dispatch",
      headBranch: "master",
      createdAt: "2026-11-22T02:30:00Z",
      conclusion: "failure",
    });
    const w = world({
      active: [promote],
      dispatchRuns: [failed],
      jobs: { 10: PUBLISH_JOBS, 20: PROMOTE_JOBS },
    });
    const r = rig(w, GRANTS);
    expect(reconcilePromote(r.ctx, r.seams)).toBe(EXIT_VIOLATION);
    expect(dispatched(r)).toBe(0);
  });

  it("clause 3: a successful promote run with both packages on latest is done; a partial state stops without a dispatch", () => {
    const done = run(20, {
      event: "workflow_dispatch",
      headBranch: "master",
      createdAt: "2026-11-22T02:30:00Z",
    });
    const ok = rig(
      world({ dispatchRuns: [done], jobs: { 10: PUBLISH_JOBS, 20: PROMOTE_JOBS }, tags: onLatest }),
      GRANTS,
    );
    expect(reconcilePromote(ok.ctx, ok.seams)).toBe(EXIT_OK);
    expect(dispatched(ok)).toBe(0);
    const partial = rig(
      world({
        active: [promote],
        dispatchRuns: [done],
        jobs: { 10: PUBLISH_JOBS, 20: PROMOTE_JOBS },
        tags: { [RUNTIME]: [{ latest: V }], [CLI]: [{ latest: "1.1.0" }] },
      }),
      GRANTS,
    );
    expect(reconcilePromote(partial.ctx, partial.seams)).toBe(EXIT_VIOLATION);
    expect(partial.lines.at(-1)).toContain("partial promote");
    expect(dispatched(partial)).toBe(0);
  });

  it("clause 3: a republish dispatch or a run before the publish run is not a promote run", () => {
    const republish = run(21, {
      event: "workflow_dispatch",
      headBranch: "master",
      createdAt: "2026-11-22T02:30:00Z",
    });
    const older = run(19, {
      event: "workflow_dispatch",
      headBranch: "master",
      createdAt: "2026-11-22T01:00:00Z",
    });
    const w = world({
      active: [promote],
      dispatchRuns: [republish, older],
      jobs: { 10: PUBLISH_JOBS, 21: REPUBLISH_JOBS, 19: PROMOTE_JOBS },
      onDispatch: dispatchStarts("success"),
    });
    const r = rig(w, GRANTS);
    expect(reconcilePromote(r.ctx, r.seams)).toBe(EXIT_OK);
    expect(dispatched(r)).toBe(1);
  });

  it("clause 3: a promote run for another version is not this release's promote run", () => {
    const other = run(22, {
      event: "workflow_dispatch",
      headBranch: "master",
      createdAt: "2026-11-22T02:40:00Z",
    });
    const w = world({
      active: [promote],
      dispatchRuns: [other],
      jobs: { 10: PUBLISH_JOBS, 22: promoteJobs(220) },
      logs: { 200: promoteLog(TAG), 220: promoteLog("v1.1.0") },
      onDispatch: (wd) => {
        wd.dispatchRuns = [
          run(20, {
            event: "workflow_dispatch",
            headBranch: "master",
            createdAt: "2026-11-22T02:50:00Z",
          }),
          other,
        ];
        wd.jobs[20] = PROMOTE_JOBS;
        wd.tags = onLatest;
        return EXIT_OK;
      },
    });
    const r = rig(w, GRANTS);
    expect(reconcilePromote(r.ctx, r.seams)).toBe(EXIT_OK);
    expect(dispatched(r)).toBe(1);
    const unreadable = rig(
      world({
        active: [promote],
        dispatchRuns: [other],
        jobs: { 10: PUBLISH_JOBS, 22: promoteJobs(220) },
        logs: { 220: "no env here" },
      }),
      GRANTS,
    );
    expect(reconcilePromote(unreadable.ctx, unreadable.seams)).toBe(EXIT_VIOLATION);
    expect(unreadable.lines.at(-1)).toContain("cannot tell which tag");
    expect(dispatched(unreadable)).toBe(0);
  });

  it("clause 9: given a spent promote grant and an unknown dispatch result, the run stops", () => {
    const w = world({ active: [promote], onDispatch: () => EXIT_VIOLATION });
    const r = rig(w, GRANTS);
    expect(reconcilePromote(r.ctx, r.seams)).toBe(EXIT_VIOLATION);
    expect(dispatched(r)).toBe(1);
    expect(r.lines.at(-1)).toContain("dispatch result is unknown");
    expect(r.lines.at(-1)).toContain("not retried");
    // --resume: no run started and the grant is spent, so nothing is dispatched again.
    w.active = [];
    w.stored["g-promote"] = grant("g-promote", "release-promote-latest", {
      usedAt: "2026-11-22T02:31:00Z",
    });
    const resumed = rig(w, GRANTS);
    expect(reconcilePromote(resumed.ctx, resumed.seams)).toBe(EXIT_VIOLATION);
    expect(dispatched(resumed)).toBe(0);
    expect(resumed.printed.join("")).toContain("--template release-promote-latest");
  });

  it("stops when a package is already on latest with no promote run, and when the dispatched run never shows", () => {
    const already = rig(world({ active: [promote], tags: onLatest }), GRANTS);
    expect(reconcilePromote(already.ctx, already.seams)).toBe(EXIT_VIOLATION);
    expect(dispatched(already)).toBe(0);
    const unseen = rig(world({ active: [promote] }), GRANTS);
    expect(reconcilePromote(unseen.ctx, unseen.seams)).toBe(EXIT_VIOLATION);
    expect(dispatched(unseen)).toBe(1);
    expect(unseen.lines.at(-1)).toContain("no run shows yet");
  });
});

describe("reconciliation reads (#6878)", () => {
  const gh =
    (answers: Record<string, string | null>) =>
    (cmd: readonly string[]): { returncode: number; stdout: string; stderr: string } => {
      const endpoint = cmd[2] ?? "";
      const key = Object.keys(answers).find((k) => endpoint.includes(k));
      const body = key === undefined ? null : answers[key];
      return body === null || body === undefined
        ? { returncode: 1, stdout: "", stderr: "boom" }
        : { returncode: 0, stdout: body, stderr: "" };
    };
  const restRun = {
    id: 10,
    event: "push",
    head_branch: TAG,
    head_sha: M.toUpperCase(),
    status: "completed",
    conclusion: "success",
    created_at: "2026-11-22T02:00:00Z",
    html_url: "u",
  };

  it("lists runs of npm-publish.yml by event and branch, and reads one run", () => {
    const runGh = gh({
      "runs?event=push&branch=v1.2.0": JSON.stringify({ workflow_runs: [restRun] }),
      "actions/runs/10": JSON.stringify(restRun),
    });
    const listed = defaultListRuns(runGh)("o/r", { event: "push", branch: TAG });
    expect(listed).toMatchObject({ ok: true, runs: [{ id: 10, headSha: M, headBranch: TAG }] });
    expect(defaultReadRun(runGh)("o/r", 10)).toMatchObject({ ok: true, run: { id: 10 } });
    expect(defaultListRuns(gh({}))("o/r", { event: "workflow_dispatch" }).ok).toBe(false);
    expect(defaultListRuns(gh({ runs: "{}" }))("o/r", { event: "workflow_dispatch" }).ok).toBe(
      false,
    );
    expect(
      defaultListRuns(gh({ runs: JSON.stringify({ workflow_runs: [{}] }) }))("o/r", {
        event: "workflow_dispatch",
      }).ok,
    ).toBe(false);
    expect(defaultReadRun(gh({ "runs/10": "not json" }))("o/r", 10).ok).toBe(false);
    expect(defaultReadRun(gh({ "runs/10": "{}" }))("o/r", 10).ok).toBe(false);
  });

  it("reads a job log and the tag a promote job promoted", () => {
    expect(defaultReadJobLog(gh({ "jobs/200/logs": promoteLog(TAG) }))("o/r", 200)).toEqual({
      ok: true,
      text: promoteLog(TAG),
    });
    expect(defaultReadJobLog(gh({}))("o/r", 200).ok).toBe(false);
    expect(promotedTagOf(promoteLog(TAG))).toBe(TAG);
    expect(promotedTagOf('if [[ "$INPUT_TAG" =~ x ]]')).toBeNull();
  });

  it("lists the jobs of a run", () => {
    const jobs = JSON.stringify({
      jobs: [
        { id: 7, name: POST_PUBLISH_FIXTURE_JOB, status: "completed", conclusion: "success" },
        { name: "x" },
      ],
    });
    expect(defaultListJobs(gh({ jobs }))("o/r", 10)).toEqual({
      ok: true,
      jobs: [
        { id: 7, name: POST_PUBLISH_FIXTURE_JOB, status: "completed", conclusion: "success" },
        { id: 0, name: "x", status: "", conclusion: null },
      ],
    });
    expect(defaultListJobs(gh({ jobs: "{}" }))("o/r", 10).ok).toBe(false);
    expect(defaultListJobs(gh({ jobs: JSON.stringify({ jobs: [{}] }) }))("o/r", 10).ok).toBe(false);
    expect(defaultListJobs(gh({}))("o/r", 10).ok).toBe(false);
  });

  it("reads the commit the remote tag peels to, annotated or lightweight", () => {
    const read = (stdout: string, status = 0) =>
      defaultReadTagCommit({ spawnText: () => ({ status, stdout, stderr: "offline" }) })(TAG, "/p");
    expect(read(`${OTHER}\trefs/tags/${TAG}\n${M}\trefs/tags/${TAG}^{}\n`)).toEqual({
      ok: true,
      sha: M,
    });
    expect(read(`${M}\trefs/tags/${TAG}\n`)).toEqual({ ok: true, sha: M });
    expect(read("")).toEqual({ ok: true, sha: null });
    expect(read("", 1).ok).toBe(false);
  });
});
