import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
/**
 * merge_group.checks_requested entry. Check-runs are a projection, not the store.
 * Live App + org ruleset app-restriction + merge queue enablement remain deploy gaps.
 */

import { defaultRunGh } from "../pr-closing-keywords/gh.js";
import { fetchClosingIssuesReferences } from "../pr-protected-issues/gh.js";
import type { RunGhFn } from "../pr-protected-issues/types.js";
import type { OnePrUnitAppStore } from "./app-store.js";
import {
  type ConstituentPrCensus,
  evaluateMergeGroupCheck,
  type MergeGroupCheckResult,
} from "./merge-group.js";
import { getDefaultAppStore } from "./simulator.js";

export interface MergeGroupEventLike {
  readonly action?: string;
  readonly merge_group?: {
    readonly head_sha?: string;
    readonly head_ref?: string;
    readonly base_sha?: string;
    readonly base_ref?: string;
  };
  readonly repository?: {
    readonly full_name?: string;
  };
}

export interface MergeGroupCliSeams {
  readonly store?: OnePrUnitAppStore;
  readonly loadConstituents?: (sha: string) => ConstituentPrCensus[];
  readonly runGh?: RunGhFn;
}

export function loadMergeGroupEventFromPath(eventPath: string): MergeGroupEventLike {
  const raw = readFileSync(eventPath, "utf8");
  const parsed: unknown = JSON.parse(raw);
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return {};
  }
  return parsed as MergeGroupEventLike;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export type ConstituentLoadResult =
  | { readonly ok: true; readonly constituents: ConstituentPrCensus[] }
  | { readonly ok: false; readonly summary: string };

const fail = (summary: string): ConstituentLoadResult => ({ ok: false, summary });

/** Tip PR of a merge-queue ref: [refs/heads/]gh-readonly-queue/<base, may hold slashes>/pr-N-<sha>. */
const QUEUE_REF = /^(?:refs\/heads\/)?gh-readonly-queue\/.+\/pr-(\d+)-[0-9a-f]+$/;

export function parseQueueHeadRef(headRef: string): number | null {
  const m = QUEUE_REF.exec(headRef.trim());
  return m === null ? null : Number(m[1]);
}

/** PR number a queue commit title names: squash "(#N)" suffix or "Merge pull request #N". */
export function prNumberFromCommitMessage(message: string): number | null {
  const first = message.split("\n", 1)[0] ?? "";
  const m = /\(#(\d+)\)\s*$/.exec(first) ?? /^Merge pull request #(\d+)\b/.exec(first);
  return m === null ? null : Number(m[1]);
}

function describeGhFailure(r: { returncode: number; stderr: string }): string {
  const err = r.stderr.trim();
  return `exit ${r.returncode}${err.length > 0 ? `: ${err}` : ""}`;
}

function parseJson(stdout: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(stdout) as unknown };
  } catch {
    return { ok: false };
  }
}

function parseCommitMessages(stdout: string): string[] | null {
  const parsed = parseJson(stdout);
  if (!parsed.ok || !Array.isArray(parsed.value)) return null;
  const msgs: string[] = [];
  for (const item of parsed.value) {
    const rec = asRecord(item);
    const commit = rec === null ? null : asRecord(rec.commit);
    const message = commit === null ? null : commit.message;
    if (typeof message === "string") msgs.push(message);
  }
  return msgs;
}

/** Secondary discovery aid: PRs the forge associates with a commit. */
function discoverPrsByCommit(
  sha: string,
  repo: string,
  runGh: RunGhFn,
): { readonly numbers: number[]; readonly error: string | null } {
  const r = runGh(["gh", "api", `repos/${repo}/commits/${sha}/pulls`]);
  if (r.returncode !== 0) {
    return { numbers: [], error: `commits/${sha}/pulls failed (${describeGhFailure(r)})` };
  }
  const parsed = parseJson(r.stdout);
  if (!parsed.ok || !Array.isArray(parsed.value)) {
    return { numbers: [], error: `commits/${sha}/pulls returned unparseable or wrong-shape JSON` };
  }
  const numbers: number[] = [];
  for (const item of parsed.value) {
    const n = asRecord(item)?.number;
    if (typeof n === "number") numbers.push(n);
  }
  return { numbers, error: null };
}

/** Every PR in base..head: each queue entry is one commit titled with its PR number. */
function rangePrNumbers(
  baseSha: string,
  headSha: string,
  repo: string,
  runGh: RunGhFn,
): { readonly numbers: number[] } | { readonly error: string } {
  const r = runGh(["gh", "api", `repos/${repo}/compare/${baseSha}...${headSha}?per_page=100`]);
  if (r.returncode !== 0) {
    return { error: `compare ${baseSha}...${headSha} failed (${describeGhFailure(r)})` };
  }
  const parsed = parseJson(r.stdout);
  const rec = parsed.ok ? asRecord(parsed.value) : null;
  if (rec === null || !Array.isArray(rec.commits)) {
    return { error: "compare returned unparseable or wrong-shape JSON (no commits array)" };
  }
  const total = rec.total_commits;
  if (typeof total === "number" && total > rec.commits.length) {
    return { error: `compare range truncated (${rec.commits.length} of ${total} commits)` };
  }
  const numbers: number[] = [];
  for (const c of rec.commits) {
    const message = asRecord(asRecord(c)?.commit)?.message;
    const n = typeof message === "string" ? prNumberFromCommitMessage(message) : null;
    if (n === null) {
      const sha = asRecord(c)?.sha;
      return {
        error: `compare commit ${typeof sha === "string" ? sha : "?"} has no PR number in its title; cannot establish queue group membership`,
      };
    }
    numbers.push(n);
  }
  return { numbers };
}

function loadOnePr(
  number: number,
  repo: string,
  runGh: RunGhFn,
): { readonly census: ConstituentPrCensus } | { readonly error: string } {
  const pr = runGh(["gh", "api", `repos/${repo}/pulls/${number}`]);
  if (pr.returncode !== 0) {
    return { error: `PR #${number} lookup failed (${describeGhFailure(pr)})` };
  }
  const parsed = parseJson(pr.stdout);
  const rec = parsed.ok ? asRecord(parsed.value) : null;
  const node = rec?.node_id;
  if (rec === null || typeof node !== "string" || node.trim().length === 0) {
    return { error: `PR #${number} lookup returned unparseable or wrong-shape JSON (no node_id)` };
  }
  const commits = runGh(["gh", "api", `repos/${repo}/pulls/${number}/commits`]);
  if (commits.returncode !== 0) {
    return { error: `PR #${number} commits lookup failed (${describeGhFailure(commits)})` };
  }
  const commitMessages = parseCommitMessages(commits.stdout);
  if (commitMessages === null) {
    return { error: `PR #${number} commits lookup returned unparseable or wrong-shape JSON` };
  }
  let lastFailure = "";
  const linked = fetchClosingIssuesReferences(number, repo, (cmd) => {
    const r = runGh(cmd);
    if (r.returncode !== 0) lastFailure = describeGhFailure(r);
    return r;
  });
  if (linked === null) {
    const detail = lastFailure.length > 0 ? ` (${lastFailure})` : "";
    return { error: `PR #${number} closing references unreadable${detail}` };
  }
  return {
    census: {
      prNodeId: node.trim(),
      repo,
      closingIssuesReferences: linked,
      body: typeof rec.body === "string" ? rec.body : "",
      commitMessages,
    },
  };
}

/**
 * Production constituent loader (#6424). The queue head commit has no PR
 * association, so members come from head_ref (tip) plus the base..head range
 * (a group may hold several PRs). Every failure is named, never an empty list.
 */
export function loadConstituentsFromGithub(
  event: MergeGroupEventLike,
  runGh: RunGhFn = defaultRunGh,
): ConstituentLoadResult {
  const repo = event.repository?.full_name?.trim() ?? "";
  if (repo.length === 0) return fail("missing repository.full_name on merge_group event");
  const headSha = event.merge_group?.head_sha?.trim() ?? "";
  const headRef = event.merge_group?.head_ref?.trim() ?? "";
  const baseSha = event.merge_group?.base_sha?.trim() ?? "";
  const tip = parseQueueHeadRef(headRef);
  const numbers: number[] = [];
  if (tip === null) {
    const found = discoverPrsByCommit(headSha, repo, runGh);
    if (found.numbers.length === 0) {
      const why = found.error ?? "no PR is associated with the head commit";
      return fail(
        `unparseable merge_group.head_ref "${headRef}" (expected gh-readonly-queue/<base>/pr-N-<sha>); ${why}`,
      );
    }
    numbers.push(...found.numbers);
  } else {
    numbers.push(tip);
    if (baseSha.length === 0) {
      return fail("missing merge_group.base_sha; cannot enumerate the queue group");
    }
    const range = rangePrNumbers(baseSha, headSha, repo, runGh);
    if ("error" in range) return fail(range.error);
    numbers.push(...range.numbers);
  }
  const constituents: ConstituentPrCensus[] = [];
  for (const n of new Set(numbers)) {
    const loaded = loadOnePr(n, repo, runGh);
    if ("error" in loaded) return fail(loaded.error);
    constituents.push(loaded.census);
  }
  return { ok: true, constituents };
}

export function runMergeGroupCheckFromEvent(
  event: MergeGroupEventLike,
  seams: MergeGroupCliSeams = {},
): MergeGroupCheckResult {
  const sha = event.merge_group?.head_sha?.trim() ?? "";
  if (sha.length === 0) {
    return {
      conclusion: "failure",
      title: "one-pr-unit",
      summary: "unreadable merge_group.head_sha",
      sha: "",
    };
  }
  const store = seams.store ?? getDefaultAppStore();
  let constituentPrs: readonly ConstituentPrCensus[];
  if (seams.loadConstituents !== undefined) {
    constituentPrs = seams.loadConstituents(sha);
  } else {
    const loaded = loadConstituentsFromGithub(event, seams.runGh ?? defaultRunGh);
    if (!loaded.ok) {
      return { conclusion: "failure", title: "one-pr-unit", summary: loaded.summary, sha };
    }
    constituentPrs = loaded.constituents;
  }
  return evaluateMergeGroupCheck({ mergeGroupSha: sha, constituentPrs, store });
}

export function main(
  argv: readonly string[] = process.argv,
  env: NodeJS.ProcessEnv = process.env,
): number {
  void argv;
  const eventPath = env.GITHUB_EVENT_PATH?.trim() ?? "";
  if (eventPath.length === 0) {
    process.stderr.write("one-pr-unit merge-group: GITHUB_EVENT_PATH is required\n");
    return 1;
  }
  let event: MergeGroupEventLike;
  try {
    event = loadMergeGroupEventFromPath(eventPath);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`one-pr-unit merge-group: failed to read event: ${message}\n`);
    return 1;
  }
  const result = runMergeGroupCheckFromEvent(event);
  process.stdout.write(`${result.conclusion} ${result.sha} ${result.title}\n${result.summary}\n`);
  return result.conclusion === "success" ? 0 : 1;
}

const invoked = process.argv[1];
if (invoked !== undefined && import.meta.url === pathToFileURL(invoked).href) {
  process.exit(main());
}
