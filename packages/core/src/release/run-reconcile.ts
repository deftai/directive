/**
 * Publish watch, draft flip and promote of `deft release:run` by
 * reconciliation (#6878, S5 of #6845; bound lean 7032154033 items 6, 9, 10).
 *
 * Each phase decides from observed state on every run and `--resume`; nothing
 * is overwritten and a done step is never redone.
 *
 * Publish watch: the approval covers source tree T at M, built by the
 * tag-triggered `npm-publish.yml` run at M. The phase reads the commit the
 * remote `v<version>` tag peels to and that run (event `push`, head M). A run
 * in progress is waited on; a run, or its post-publish two-pass fixture job,
 * that did not conclude `success` stops the run. npm is done only when both
 * packages then carry the version on the `maintainer` dist-tag. The run
 * publishes only by the tag push and never dispatches the manual republish
 * workflow. Until #6966 lands, a fixture that deferred its Pass 2 still reads
 * `success`; the OK line says so.
 *
 * Draft flip: the GitHub release for the tag that is published is done; a
 * missing or unreadable release stops; a draft needs the run's
 * `release-publish` grant (#6875 gate: only that grant, for the tree the
 * remote tag peels to).
 *
 * Promote: only with the recorded `release-promote-latest` grant, after the
 * publish watch (and so the fixture) passed. It first looks for a
 * promote-latest run: a `workflow_dispatch` run of `npm-publish.yml` created
 * since the tag-triggered run, whose promote job was not skipped. In progress
 * is waited on; `success` with both packages on `latest` at the version is
 * done; a failed run or a partial state stops without a dispatch. With no run
 * found it dispatches once; the grant is spent before the dispatch, so an
 * unknown dispatch result stops and is not retried.
 *
 * Grants: a recorded grant that an unfinished phase needs and that is
 * expired, spent or revoked is replaced only by a newer active grant for the
 * same target minted since approve (the operator's remint); otherwise the run
 * stops and names the mint command.
 */

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listActiveHumanGrants, loadAuthzState, loadGrant } from "../authz/store.js";
import type { HumanOriginGrant } from "../authz/types.js";
import { PUBLIC_NPM_REGISTRY } from "../doctor/constants.js";
import { containedWrite } from "../fs/contained-write.js";
import { defaultRunGh } from "../pr-merge-readiness/gh.js";
import type { RunGhFn } from "../pr-merge-readiness/types.js";
import { viewRelease } from "../release-publish/gh-api.js";
import { runPromoteLatest, runPublish } from "../release-publish/pipeline.js";
import type { NormalisedRelease, ViewReleaseState } from "../release-publish/types.js";
import {
  CLI_DRIFT_POLL_INTERVAL_MS,
  CLI_DRIFT_POLL_TIMEOUT_MS,
  defaultCliDriftSleepMs,
  WORKSPACE_PACKAGES,
} from "./cli-drift-report.js";
import { EXIT_OK, EXIT_VIOLATION } from "./constants.js";
import { runGit } from "./git.js";
import type { ReadResult } from "./run-merge.js";
import type { ReleaseRunGrantIds, ReleaseRunRecord } from "./run-record.js";
import type { ReleaseConfig, ReleaseSeams } from "./types.js";

/** The workflow the tag push triggers and the promote verb dispatches. */
export const NPM_PUBLISH_WORKFLOW = "npm-publish.yml";
/** The downstream fixture job of the tag-triggered run (#4271). */
export const POST_PUBLISH_FIXTURE_JOB = "Post-publish two-pass fixture";
/** The job a promote-latest dispatch runs (#5852); its name carries a suffix. */
export const PROMOTE_LATEST_JOB_PREFIX = "Promote a published stable version to npm latest";

/** One Actions run of `npm-publish.yml`, as REST lists it. */
export interface WorkflowRun {
  readonly id: number;
  readonly event: string;
  readonly headBranch: string;
  readonly headSha: string;
  readonly status: string;
  readonly conclusion: string | null;
  readonly createdAt: string;
  readonly url: string;
}

export interface WorkflowJob {
  readonly name: string;
  readonly status: string;
  readonly conclusion: string | null;
}

export type DistTags = Readonly<Record<string, string>>;

export interface ReconcileSeams {
  /** The commit the remote `v<version>` tag peels to; null when origin has no such tag. */
  readonly readTagCommit?: (
    tag: string,
    projectRoot: string,
  ) => ReadResult<{ readonly sha: string | null }>;
  readonly listRuns?: (
    repo: string,
    query: { readonly event: "push" | "workflow_dispatch"; readonly branch?: string },
  ) => ReadResult<{ readonly runs: readonly WorkflowRun[] }>;
  readonly readRun?: (repo: string, id: number) => ReadResult<{ readonly run: WorkflowRun }>;
  readonly listJobs?: (
    repo: string,
    runId: number,
  ) => ReadResult<{ readonly jobs: readonly WorkflowJob[] }>;
  readonly readDistTags?: (name: string) => ReadResult<{ readonly tags: DistTags }>;
  readonly viewRelease?: (
    version: string,
    repo: string,
  ) => [ViewReleaseState, NormalisedRelease | null, string];
  /** Load a grant by id (also an inactive one), to say why it no longer counts. */
  readonly loadGrant?: (projectRoot: string, id: string) => HumanOriginGrant | null;
  readonly sleepMs?: (ms: number) => void;
  readonly nowMs?: () => number;
}

export interface ReconcileContext {
  readonly projectRoot: string;
  readonly config: ReleaseConfig;
  readonly record: () => ReleaseRunRecord;
  readonly save: (patch: Partial<ReleaseRunRecord>) => void;
  readonly line: (status: string) => void;
  readonly out: (text: string) => void;
  readonly listGrants: (projectRoot: string) => readonly HumanOriginGrant[];
  /** The run's grant discovery (run.ts findRunGrants) over the given grants. */
  readonly findGrants: (grants: readonly HumanOriginGrant[]) => ReleaseRunGrantIds;
  /** The `deft ...` mint command for a grant kind, with an expiry placeholder. */
  readonly mintCommand: (kind: keyof ReleaseRunGrantIds) => string;
  /** Run the run-bound draft flip with this grant id. */
  readonly flip: (config: ReleaseConfig, grantId: string) => number;
  /** Dispatch promote-latest with this grant id (the grant is spent before dispatch). */
  readonly promote: (config: ReleaseConfig, grantId: string) => number;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function runOf(value: unknown): WorkflowRun | null {
  const r = asRecord(value);
  if (r === null || typeof r.id !== "number") return null;
  const str = (v: unknown): string => (typeof v === "string" ? v : "");
  return {
    id: r.id,
    event: str(r.event),
    headBranch: str(r.head_branch),
    headSha: str(r.head_sha).toLowerCase(),
    status: str(r.status),
    conclusion: typeof r.conclusion === "string" ? r.conclusion : null,
    createdAt: str(r.created_at),
    url: str(r.html_url),
  };
}

function ghJson(runGh: RunGhFn, endpoint: string): ReadResult<{ readonly value: unknown }> {
  const r = runGh(["gh", "api", endpoint]);
  if (r.returncode !== 0) return { ok: false, reason: `gh api ${endpoint}: ${r.stderr.trim()}` };
  try {
    return { ok: true, value: JSON.parse(r.stdout) as unknown };
  } catch {
    return { ok: false, reason: `gh api ${endpoint} returned no JSON` };
  }
}

/** The runs of `npm-publish.yml` for one event (and branch), first page, newest first. */
export function defaultListRuns(runGh: RunGhFn) {
  return (
    repo: string,
    query: { readonly event: "push" | "workflow_dispatch"; readonly branch?: string },
  ): ReadResult<{ readonly runs: readonly WorkflowRun[] }> => {
    const branch = query.branch === undefined ? "" : `&branch=${encodeURIComponent(query.branch)}`;
    const endpoint = `repos/${repo}/actions/workflows/${NPM_PUBLISH_WORKFLOW}/runs?event=${query.event}${branch}&per_page=100`;
    const read = ghJson(runGh, endpoint);
    if (!read.ok) return read;
    const list = asRecord(read.value)?.workflow_runs;
    if (!Array.isArray(list)) return { ok: false, reason: `${endpoint} has no workflow_runs` };
    const runs: WorkflowRun[] = [];
    for (const row of list) {
      const run = runOf(row);
      if (run === null) return { ok: false, reason: `${endpoint} listed a run without an id` };
      runs.push(run);
    }
    return { ok: true, runs };
  };
}

export function defaultReadRun(runGh: RunGhFn) {
  return (repo: string, id: number): ReadResult<{ readonly run: WorkflowRun }> => {
    const read = ghJson(runGh, `repos/${repo}/actions/runs/${String(id)}`);
    if (!read.ok) return read;
    const run = runOf(read.value);
    return run === null
      ? { ok: false, reason: `run ${String(id)} read had no id` }
      : { ok: true, run };
  };
}

export function defaultListJobs(runGh: RunGhFn) {
  return (repo: string, runId: number): ReadResult<{ readonly jobs: readonly WorkflowJob[] }> => {
    const endpoint = `repos/${repo}/actions/runs/${String(runId)}/jobs?per_page=100`;
    const read = ghJson(runGh, endpoint);
    if (!read.ok) return read;
    const list = asRecord(read.value)?.jobs;
    if (!Array.isArray(list)) return { ok: false, reason: `${endpoint} has no jobs` };
    const jobs: WorkflowJob[] = [];
    for (const row of list) {
      const j = asRecord(row);
      if (j === null || typeof j.name !== "string") {
        return { ok: false, reason: `${endpoint} listed a job without a name` };
      }
      jobs.push({
        name: j.name,
        status: typeof j.status === "string" ? j.status : "",
        conclusion: typeof j.conclusion === "string" ? j.conclusion : null,
      });
    }
    return { ok: true, jobs };
  };
}

/** The commit the remote tag peels to (`git ls-remote`, never a local ref). */
export function defaultReadTagCommit(seams: ReleaseSeams) {
  return (tag: string, projectRoot: string): ReadResult<{ readonly sha: string | null }> => {
    const r = runGit(
      projectRoot,
      ["ls-remote", "--tags", "origin", `refs/tags/${tag}`, `refs/tags/${tag}^{}`],
      seams,
    );
    if (r.status !== 0)
      return { ok: false, reason: `git ls-remote origin ${tag}: ${r.stderr.trim()}` };
    let plain: string | null = null;
    let deref: string | null = null;
    for (const row of r.stdout.split(/\r?\n/)) {
      const [sha, ref] = row.trim().split(/\s+/);
      if (sha === undefined || sha.length === 0) continue;
      if (ref === `refs/tags/${tag}^{}`) deref = sha.toLowerCase();
      else if (ref === `refs/tags/${tag}`) plain = sha.toLowerCase();
    }
    // An annotated tag lists its peeled commit as `^{}`; a lightweight tag does not.
    return { ok: true, sha: deref ?? plain };
  };
}

/** `npm view <name> dist-tags` against the public registry (a temp project `.npmrc`). */
export function defaultReadDistTags(name: string): ReadResult<{ readonly tags: DistTags }> {
  let dir: string | undefined;
  try {
    dir = mkdtempSync(join(tmpdir(), "deft-release-run-dist-tags-"));
    containedWrite({
      root: dir,
      target: ".npmrc",
      data: `@deftai:registry=${PUBLIC_NPM_REGISTRY}\nregistry=${PUBLIC_NPM_REGISTRY}\n`,
      mode: "create",
    });
    const result = spawnSync(
      "npm",
      ["view", name, "dist-tags", "--json", "--prefer-online", "--ignore-scripts"],
      {
        cwd: dir,
        encoding: "utf8",
        timeout: 15_000,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      },
    );
    if (result.error !== undefined || result.status !== 0) {
      return { ok: false, reason: `npm view ${name} dist-tags failed` };
    }
    const parsed = asRecord(JSON.parse(typeof result.stdout === "string" ? result.stdout : ""));
    if (parsed === null)
      return { ok: false, reason: `npm view ${name} dist-tags is not an object` };
    const tags: Record<string, string> = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value === "string") tags[key] = value;
    }
    return { ok: true, tags };
  } catch (err) {
    return { ok: false, reason: `npm view ${name} dist-tags: ${String(err)}` };
  } finally {
    if (dir !== undefined) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        /* best-effort temp cleanup */
      }
    }
  }
}

interface Io {
  readonly readTagCommit: NonNullable<ReconcileSeams["readTagCommit"]>;
  readonly listRuns: NonNullable<ReconcileSeams["listRuns"]>;
  readonly readRun: NonNullable<ReconcileSeams["readRun"]>;
  readonly listJobs: NonNullable<ReconcileSeams["listJobs"]>;
  readonly readDistTags: NonNullable<ReconcileSeams["readDistTags"]>;
  readonly viewRelease: NonNullable<ReconcileSeams["viewRelease"]>;
  readonly loadGrant: NonNullable<ReconcileSeams["loadGrant"]>;
  readonly sleepMs: (ms: number) => void;
  readonly nowMs: () => number;
}

function io(seams: ReconcileSeams, release: ReleaseSeams = {}, runGh: RunGhFn = defaultRunGh): Io {
  return {
    readTagCommit: seams.readTagCommit ?? defaultReadTagCommit(release),
    listRuns: seams.listRuns ?? defaultListRuns(runGh),
    readRun: seams.readRun ?? defaultReadRun(runGh),
    listJobs: seams.listJobs ?? defaultListJobs(runGh),
    readDistTags: seams.readDistTags ?? defaultReadDistTags,
    viewRelease: seams.viewRelease ?? ((v, repo) => viewRelease(v, repo, release)),
    loadGrant: seams.loadGrant ?? loadGrant,
    sleepMs: seams.sleepMs ?? defaultCliDriftSleepMs,
    nowMs: seams.nowMs ?? Date.now,
  };
}

type Poll<T> =
  | { readonly kind: "done"; readonly value: T }
  | { readonly kind: "again" }
  | {
      readonly kind: "stop";
      readonly reason: string;
    };

/**
 * Re-read until done or stop. With a budget (the Phase 7 npm wait of the
 * publish watch) the wait gives up when it is spent; without one it waits as
 * long as the read says `again` (a run in progress ends when GitHub ends it).
 */
function poll<T>(
  x: Io,
  read: () => Poll<T>,
  budgetMs: number | null,
):
  | { readonly kind: "done"; readonly value: T }
  | { readonly kind: "stop"; readonly reason: string }
  | { readonly kind: "spent" } {
  const start = x.nowMs();
  for (;;) {
    const r = read();
    if (r.kind !== "again") return r;
    if (budgetMs !== null && x.nowMs() - start >= budgetMs) return { kind: "spent" };
    x.sleepMs(CLI_DRIFT_POLL_INTERVAL_MS);
  }
}

/** Wait while the run is not completed; return the completed run. */
function waitCompleted(
  x: Io,
  repo: string,
  run: WorkflowRun,
  say: (text: string) => void,
): ReadResult<{ readonly run: WorkflowRun }> {
  if (run.status === "completed") return { ok: true, run };
  say(`waiting on ${run.url || `run ${String(run.id)}`} (${run.status})`);
  const waited = poll<WorkflowRun>(
    x,
    () => {
      const r = x.readRun(repo, run.id);
      if (!r.ok) return { kind: "stop", reason: r.reason };
      return r.run.status === "completed" ? { kind: "done", value: r.run } : { kind: "again" };
    },
    null,
  );
  if (waited.kind === "done") return { ok: true, run: waited.value };
  return { ok: false, reason: waited.kind === "stop" ? waited.reason : "wait ended" };
}

function newestFirst(runs: readonly WorkflowRun[]): WorkflowRun[] {
  return [...runs].sort((a, b) =>
    a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0,
  );
}

/** The commit the remote tag peels to, which must exist. */
function remoteTagCommit(x: Io, ctx: ReconcileContext): ReadResult<{ readonly sha: string }> {
  const tag = `v${ctx.config.version}`;
  const read = x.readTagCommit(tag, ctx.projectRoot);
  if (!read.ok) return read;
  if (read.sha === null) {
    return { ok: false, reason: `origin has no tag ${tag}; the finish step did not push it` };
  }
  return { ok: true, sha: read.sha };
}

/**
 * The tag-triggered run at M. `budgetMs` waits for a run that has not shown
 * up yet (just after the tag push); a tag-triggered run on another commit stops.
 */
function findTagRun(
  x: Io,
  ctx: ReconcileContext,
  m: string,
  budgetMs: number | null,
): ReadResult<{ readonly run: WorkflowRun }> {
  const tag = `v${ctx.config.version}`;
  const found = poll<WorkflowRun>(
    x,
    () => {
      const list = x.listRuns(ctx.config.repo, { event: "push", branch: tag });
      if (!list.ok) return { kind: "stop", reason: list.reason };
      const runs = newestFirst(list.runs.filter((r) => r.event === "push" && r.headBranch === tag));
      const atM = runs.find((r) => r.headSha === m);
      if (atM !== undefined) return { kind: "done", value: atM };
      const other = runs[0];
      if (other !== undefined) {
        return {
          kind: "stop",
          reason: `the tag-triggered ${NPM_PUBLISH_WORKFLOW} run for ${tag} is on ${other.headSha.slice(0, 12)}, not M ${m.slice(0, 12)}`,
        };
      }
      return budgetMs === null ? { kind: "stop", reason: "no run" } : { kind: "again" };
    },
    budgetMs,
  );
  if (found.kind === "done") return { ok: true, run: found.value };
  if (found.kind === "stop") return { ok: false, reason: found.reason };
  return {
    ok: false,
    reason: `no tag-triggered ${NPM_PUBLISH_WORKFLOW} run for ${tag} yet; check the Actions tab, then --resume`,
  };
}

/** Wait until every workspace package has `tag` at the version, within the npm wait budget. */
function waitDistTag(x: Io, version: string, tag: "maintainer" | "latest"): ReadResult<object> {
  let last = "";
  const waited = poll<true>(
    x,
    () => {
      const seen: string[] = [];
      for (const name of WORKSPACE_PACKAGES) {
        const r = x.readDistTags(name);
        if (!r.ok) return { kind: "stop", reason: r.reason };
        seen.push(`${name}@${tag}=${r.tags[tag] ?? "none"}`);
      }
      last = seen.join(", ");
      return seen.every((s) => s.endsWith(`=${version}`))
        ? { kind: "done", value: true }
        : { kind: "again" };
    },
    CLI_DRIFT_POLL_TIMEOUT_MS,
  );
  if (waited.kind === "done") return { ok: true };
  if (waited.kind === "stop") return { ok: false, reason: waited.reason };
  return { ok: false, reason: `the registry still shows ${last}` };
}

function stop(ctx: ReconcileContext, reason: string): number {
  ctx.line(`FAIL (${reason})`);
  return EXIT_VIOLATION;
}

/** Publish watch by reconciliation (items 6 and 9). */
export function reconcilePublishWatch(
  ctx: ReconcileContext,
  seams: ReconcileSeams = {},
  release: ReleaseSeams = {},
  runGh?: RunGhFn,
): number {
  const x = io(seams, release, runGh);
  const m = remoteTagCommit(x, ctx);
  if (!m.ok) return stop(ctx, m.reason);
  const found = findTagRun(x, ctx, m.sha, CLI_DRIFT_POLL_TIMEOUT_MS);
  if (!found.ok) return stop(ctx, found.reason);
  const done = waitCompleted(x, ctx.config.repo, found.run, (t) => ctx.line(t));
  if (!done.ok) return stop(ctx, done.reason);
  const run = done.run;
  const where = run.url || `run ${String(run.id)}`;
  if (run.conclusion !== "success") {
    return stop(
      ctx,
      `the tag-triggered ${NPM_PUBLISH_WORKFLOW} run ${where} concluded ${String(run.conclusion)}; ` +
        "the run never dispatches the manual republish workflow. Recover by hand " +
        "(docs/RELEASING.md § Release run recovery), then --resume",
    );
  }
  const jobs = x.listJobs(ctx.config.repo, run.id);
  if (!jobs.ok) return stop(ctx, jobs.reason);
  const fixture = jobs.jobs.find((j) => j.name === POST_PUBLISH_FIXTURE_JOB);
  if (fixture?.conclusion !== "success") {
    return stop(
      ctx,
      `the ${POST_PUBLISH_FIXTURE_JOB} job of ${where} is ${fixture === undefined ? "missing" : String(fixture.conclusion)}, not success`,
    );
  }
  const tags = waitDistTag(x, ctx.config.version, "maintainer");
  if (!tags.ok) return stop(ctx, `npm is not done: ${tags.reason}`);
  ctx.line(
    `OK (${where} at M ${m.sha.slice(0, 12)} concluded success with its post-publish fixture; ` +
      `both packages carry ${ctx.config.version} on maintainer. A fixture that deferred Pass 2 still reads success until #6966)`,
  );
  return EXIT_OK;
}

function grantProblem(grant: HumanOriginGrant | null, nowMs: number): string {
  if (grant === null) return "not found";
  const s = grant.semantics;
  if (s.revokedAt !== null) return `revoked at ${s.revokedAt}`;
  if (s.usedAt !== null) return `spent at ${s.usedAt}`;
  if (s.expiresAt !== null && Date.parse(s.expiresAt) <= nowMs) return `expired at ${s.expiresAt}`;
  return "not active";
}

/**
 * The grant an unfinished phase needs: the recorded one while active, else a
 * newer active grant for the same target (an operator remint), else a stop
 * that names the mint command.
 */
function usableGrant(
  x: Io,
  ctx: ReconcileContext,
  kind: keyof ReleaseRunGrantIds,
): { readonly ok: true; readonly id: string } | { readonly ok: false } {
  const record = ctx.record();
  const id = record.grants[kind];
  const active = ctx.listGrants(ctx.projectRoot);
  if (id !== null && active.some((g) => g.id === id)) return { ok: true, id };
  const why =
    id === null ? "not recorded" : grantProblem(x.loadGrant(ctx.projectRoot, id), x.nowMs());
  const replacement = ctx.findGrants(active)[kind];
  if (replacement !== null && replacement !== id) {
    ctx.save({ grants: { ...record.grants, [kind]: replacement } });
    ctx.line(
      `grant ${String(id)} is ${why}; using grant ${replacement}, minted since for the same target`,
    );
    return { ok: true, id: replacement };
  }
  const template = kind === "releasePublish" ? "release-publish" : "release-promote-latest";
  ctx.out(
    [
      `The ${template} grant ${String(id)} is ${why}. Mint a new one, then resume:`,
      `  ${ctx.mintCommand(kind)}`,
      `  deft release:run ${record.version} --resume`,
      "",
    ].join("\n"),
  );
  ctx.line(`FAIL (${template} grant ${String(id)} is ${why}; mint command printed above)`);
  return { ok: false };
}

/** Draft flip by reconciliation (item 9). */
export function reconcileFlip(
  ctx: ReconcileContext,
  seams: ReconcileSeams = {},
  release: ReleaseSeams = {},
): number {
  const x = io(seams, release);
  const tag = `v${ctx.config.version}`;
  const [state, payload, reason] = x.viewRelease(ctx.config.version, ctx.config.repo);
  if (state === "published") {
    ctx.line(`OK (${tag} is already published; done)`);
    return EXIT_OK;
  }
  if (state === "not-found") {
    return stop(ctx, `no GitHub release for ${tag} on ${ctx.config.repo}; nothing created here`);
  }
  if (state !== "draft") return stop(ctx, reason || `cannot read the GitHub release ${tag}`);
  const grant = usableGrant(x, ctx, "releasePublish");
  if (!grant.ok) return EXIT_VIOLATION;
  const code = ctx.flip(ctx.config, grant.id);
  if (code !== EXIT_OK)
    return stop(ctx, `draft flip of ${payload?.url ?? tag} exited ${String(code)}`);
  ctx.line(`OK (${tag} published with grant ${grant.id})`);
  return EXIT_OK;
}

/** The newest promote-latest run since `since`, or null. */
function findPromoteRun(
  x: Io,
  ctx: ReconcileContext,
  since: string,
): ReadResult<{ readonly run: WorkflowRun | null }> {
  const list = x.listRuns(ctx.config.repo, { event: "workflow_dispatch" });
  if (!list.ok) return list;
  for (const run of newestFirst(list.runs.filter((r) => r.event === "workflow_dispatch"))) {
    if (run.createdAt < since) break;
    const jobs = x.listJobs(ctx.config.repo, run.id);
    if (!jobs.ok) return jobs;
    const job = jobs.jobs.find((j) => j.name.startsWith(PROMOTE_LATEST_JOB_PREFIX));
    if (job !== undefined && job.conclusion !== "skipped") return { ok: true, run };
  }
  return { ok: true, run: null };
}

/** Judge a promote run: wait while in progress, then success with both on latest, or stop. */
function settlePromoteRun(x: Io, ctx: ReconcileContext, found: WorkflowRun): number {
  const done = waitCompleted(x, ctx.config.repo, found, (t) => ctx.line(t));
  if (!done.ok) return stop(ctx, done.reason);
  const where = done.run.url || `run ${String(done.run.id)}`;
  if (done.run.conclusion !== "success") {
    return stop(
      ctx,
      `promote-latest run ${where} concluded ${String(done.run.conclusion)}; no new dispatch`,
    );
  }
  const latest = waitDistTag(x, ctx.config.version, "latest");
  if (!latest.ok)
    return stop(ctx, `partial promote after ${where}: ${latest.reason}; no new dispatch`);
  ctx.line(`OK (${where} concluded success; both packages on latest at ${ctx.config.version})`);
  return EXIT_OK;
}

/** Promote by reconciliation (item 10). */
export function reconcilePromote(
  ctx: ReconcileContext,
  seams: ReconcileSeams = {},
  release: ReleaseSeams = {},
  runGh?: RunGhFn,
): number {
  if (ctx.record().grants.promoteLatest === null) {
    ctx.line("SKIP (no release-promote-latest grant; latest unchanged)");
    return EXIT_OK;
  }
  const x = io(seams, release, runGh);
  const m = remoteTagCommit(x, ctx);
  if (!m.ok) return stop(ctx, m.reason);
  // The publish watch passed (phase order); its run anchors the promote search.
  const publish = findTagRun(x, ctx, m.sha, null);
  if (!publish.ok) return stop(ctx, publish.reason);
  const since = publish.run.createdAt;
  const existing = findPromoteRun(x, ctx, since);
  if (!existing.ok) return stop(ctx, existing.reason);
  if (existing.run !== null) return settlePromoteRun(x, ctx, existing.run);

  for (const name of WORKSPACE_PACKAGES) {
    const r = x.readDistTags(name);
    if (!r.ok) return stop(ctx, r.reason);
    if (r.tags.latest === ctx.config.version) {
      return stop(
        ctx,
        `${name} is already on latest at ${ctx.config.version} with no promote-latest run; nothing dispatched`,
      );
    }
  }
  const grant = usableGrant(x, ctx, "promoteLatest");
  if (!grant.ok) return EXIT_VIOLATION;
  const code = ctx.promote(ctx.config, grant.id);
  if (code !== EXIT_OK) {
    return stop(
      ctx,
      `the promote-latest dispatch result is unknown (exit ${String(code)}) and grant ${grant.id} is spent; ` +
        "it is not retried. --resume reads the promote run if one started",
    );
  }
  const appeared = poll<WorkflowRun>(
    x,
    () => {
      const r = findPromoteRun(x, ctx, since);
      if (!r.ok) return { kind: "stop", reason: r.reason };
      return r.run === null ? { kind: "again" } : { kind: "done", value: r.run };
    },
    CLI_DRIFT_POLL_TIMEOUT_MS,
  );
  if (appeared.kind === "stop") return stop(ctx, appeared.reason);
  if (appeared.kind === "spent") {
    return stop(ctx, "promote-latest was dispatched but no run shows yet; --resume reads it");
  }
  return settlePromoteRun(x, ctx, appeared.value);
}

/** Production draft flip under the run: the #6875 run-bound gate, this grant only. */
export function defaultRunFlip(release: ReleaseSeams) {
  return (c: ReleaseConfig, grantId: string): number =>
    runPublish(
      { version: c.version, repo: c.repo, projectRoot: c.projectRoot, dryRun: false },
      release,
      { grantId },
    );
}

/** Production promote dispatch under the run: the gate sees only the run's grant. */
export function defaultRunPromote(release: ReleaseSeams, projectRoot: string) {
  return (c: ReleaseConfig, grantId: string): number => {
    const grants = listActiveHumanGrants(projectRoot, loadAuthzState(projectRoot)).filter(
      (g) => g.id === grantId,
    );
    return runPromoteLatest(
      { version: c.version, repo: c.repo, projectRoot: c.projectRoot, dryRun: false },
      { ...release, closedVerbGrants: grants },
    );
  };
}
