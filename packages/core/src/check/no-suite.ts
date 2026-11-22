/**
 * check/no-suite.ts -- run preparation for `deft check --no-suite` (#6469).
 *
 * Before any gate, a no-suite run does what CI's merge-gate job does before
 * `task check:merge`:
 *  1. resolve the branches (#6970): the delivery branch (`resolveDeliveryBranch`)
 *     and the comparison branch (the PR's base, else `resolveBaseBranch`); a
 *     malformed present `plan.policy.baseBranch` / `plan.policy.deliveryBranch`
 *     runs no gate (exit 2). When nothing local names a default, ask origin for
 *     its HEAD branch, fetch it, then point `origin/HEAD` at it;
 *  2. look up the head's open pull request once by REST;
 *  3. fetch the comparison branch and the delivery branch when it differs,
 *     through `trackingFetchArgv`; a failed fetch runs no gate (exit 2), and an
 *     exact `ls-remote` probe tells a missing branch apart from other failures;
 *  4. build the gate environment: no worker pin (`DEFT_ACTIVE_SCOPE`,
 *     `DEFT_BASE_REF`) and no inherited `GITHUB_*` PR variables, then CI's
 *     pull-request context when the head has exactly one open PR, with a
 *     temporary event payload file holding that PR;
 *  5. print the header lines: the branches fetched and where each came from,
 *     the merge base and the PR used, or the no-PR line.
 *
 * Every git, gh and temp-file call goes through a seam so the module is
 * testable without a network or a real repository.
 *
 * Non-goal (#6970, accepted lean 7073440422): prep makes sure the refs the
 * gates read are fetched (and `origin/HEAD` is set when origin names the
 * default); it does not tell gates which base to use. In the no-PR form no
 * base override is passed (`DEFT_BASE_REF` stays cleared, #6469 item 4), and
 * each gate keeps its own base resolution.
 */

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultWhich } from "../doctor/which.js";
import { containedWrite } from "../fs/contained-write.js";
import { ACTIVE_SCOPE_PIN_ENV } from "../hooks/scope.js";
import { FIELD_BASE_BRANCH, resolveBaseBranch } from "../policy/base-branch.js";
import {
  type DeliveryBranchResult,
  FIELD_DELIVERY_BRANCH,
  isSafeBranchName,
  resolveDeliveryBranch,
  trackingFetchArgv,
} from "../policy/delivery-branch.js";
import { runGhApi } from "../scm/gh-rest.js";
import type { GitRunner } from "../session/git.js";
import { SUBPROCESS_MAX_BUFFER } from "../subprocess/max-buffer.js";

/** Environment keys a no-suite run never passes to a gate from the caller (#6469 item 4). */
export const NO_SUITE_CLEARED_ENV_KEYS: readonly string[] = [
  ACTIVE_SCOPE_PIN_ENV,
  "DEFT_BASE_REF",
  "GITHUB_PR_NUMBER",
  "GITHUB_REPOSITORY",
  "GITHUB_BASE_REF",
  "GITHUB_EVENT_NAME",
  "GITHUB_EVENT_PATH",
];

export interface NoSuiteGitResult {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

export type NoSuiteGitFn = (args: readonly string[], cwd: string) => NoSuiteGitResult;

export type NoSuiteGhGetResult =
  | { readonly ok: true; readonly json: unknown }
  | { readonly ok: false; readonly error: string };

/** One REST GET (`repos/...` path), live (never the ghx cache). */
export type NoSuiteGhGetFn = (path: string) => NoSuiteGhGetResult;

/** Writes the event payload; returns its path and a cleanup. */
export type NoSuiteEventWriter = (payload: string) => {
  readonly path: string;
  readonly cleanup: () => void;
};

export interface NoSuitePullRequest {
  readonly number: number;
  readonly repository: string;
  readonly baseRef: string;
}

export interface NoSuitePrepInput {
  readonly projectRoot: string;
  readonly env: NodeJS.ProcessEnv;
  readonly git?: NoSuiteGitFn;
  readonly ghGet?: NoSuiteGhGetFn;
  readonly writeEvent?: NoSuiteEventWriter;
}

export type NoSuitePrep =
  | {
      readonly ok: true;
      readonly env: NodeJS.ProcessEnv;
      readonly header: readonly string[];
      readonly pullRequest: NoSuitePullRequest | null;
      readonly cleanup: () => void;
    }
  | { readonly ok: false; readonly exitCode: 2; readonly message: string };

export type PrepareNoSuiteRunFn = (input: NoSuitePrepInput) => NoSuitePrep;

/** Where a fetched branch came from (#6970); the missing-branch fix depends on it. */
export type NoSuiteBranchSource =
  | { readonly kind: "base-policy" }
  | { readonly kind: "delivery-policy" }
  | { readonly kind: "pull-request"; readonly number: number }
  | { readonly kind: "local-default" }
  | { readonly kind: "remote-head" }
  | { readonly kind: "fallback" };

export interface NoSuiteBranch {
  readonly branch: string;
  readonly source: NoSuiteBranchSource;
}

function defaultGit(args: readonly string[], cwd: string): NoSuiteGitResult {
  const result = spawnSync("git", [...args], {
    cwd,
    encoding: "utf8",
    maxBuffer: SUBPROCESS_MAX_BUFFER,
  });
  return {
    status: result.error !== undefined ? null : result.status,
    stdout: result.stdout ?? "",
    stderr: result.error !== undefined ? result.error.message : (result.stderr ?? ""),
  };
}

/** Live `gh api <path>`: hides `ghx` so a just-opened PR and its current body are read. */
function defaultGhGet(path: string): NoSuiteGhGetResult {
  const result = runGhApi([path], {
    whichFn: (name) => (name === "ghx" ? null : defaultWhich(name)),
  });
  if (result.returncode !== 0) {
    return { ok: false, error: result.stderr.trim() || `gh api exit ${result.returncode}` };
  }
  try {
    return { ok: true, json: JSON.parse(result.stdout) as unknown };
  } catch (err: unknown) {
    return { ok: false, error: `non-JSON response: ${(err as Error).message}` };
  }
}

function defaultWriteEvent(payload: string): { path: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "deft-check-no-suite-"));
  const written = containedWrite({
    root: dir,
    target: "event.json",
    data: payload,
    mode: "create",
  });
  return {
    path: written.path,
    cleanup: () => {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // best-effort temp cleanup
      }
    },
  };
}

/** `owner/repo` from a GitHub remote URL (https, ssh or scp form), else null. */
export function repoSlugFromRemoteUrl(url: string): string | null {
  // String steps, not one backtracking regex (CodeQL polynomial-ReDoS on `::` runs).
  const text = url.trim();
  const host = text.toLowerCase().indexOf("github.com");
  if (host === -1) return null;
  const rest = text.slice(host + "github.com".length);
  const sep = rest.charAt(0);
  if (sep !== ":" && sep !== "/") return null;
  const parts = rest
    .slice(1)
    .split("/")
    .filter((part) => part.length > 0);
  if (parts.length !== 2) return null;
  const owner = parts[0] as string;
  const repo = (parts[1] as string).replace(/\.git$/i, "");
  if (repo.length === 0 || /\s/.test(owner) || /\s/.test(repo)) return null;
  return `${owner}/${repo}`;
}

/** Caller env without the worker pin and inherited PR context (#6469 item 4). */
export function clearNoSuiteEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { ...env };
  for (const key of NO_SUITE_CLEARED_ENV_KEYS) {
    delete out[key];
  }
  return out;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** Open PRs from a `commits/<sha>/pulls` reply whose head SHA is `headSha`. */
export function openPullsAtHead(json: unknown, headSha: string): number[] {
  if (!Array.isArray(json)) return [];
  const numbers: number[] = [];
  for (const entry of json) {
    const pr = asRecord(entry);
    if (pr === null || pr.state !== "open") continue;
    const head = asRecord(pr.head);
    if (head?.sha !== headSha) continue;
    if (typeof pr.number === "number") numbers.push(pr.number);
  }
  return numbers;
}

/** Header and message label for a branch source (#6970). */
export function noSuiteBranchSourceLabel(source: NoSuiteBranchSource): string {
  switch (source.kind) {
    case "base-policy":
      return FIELD_BASE_BRANCH;
    case "delivery-policy":
      return FIELD_DELIVERY_BRANCH;
    case "pull-request":
      return `pull request #${source.number} base`;
    case "local-default":
      return "origin/HEAD or an existing main/master ref";
    case "remote-head":
      return "origin's HEAD branch";
    case "fallback":
      return "framework fallback";
  }
}

/** The fix a missing-branch message suggests, by source (#6970). */
function missingBranchFix(source: NoSuiteBranchSource): string {
  switch (source.kind) {
    case "base-policy":
      return `Set ${FIELD_BASE_BRANCH} to a branch origin has, then run again.`;
    case "delivery-policy":
      return `Set ${FIELD_DELIVERY_BRANCH} to a branch origin has, then run again.`;
    case "pull-request":
      return `Retarget pull request #${source.number} or push its base branch, then run again.`;
    default:
      return (
        `Set ${FIELD_DELIVERY_BRANCH} (and ${FIELD_BASE_BRANCH} if pull requests merge into ` +
        "another branch) to a branch origin has, then run again."
      );
  }
}

/**
 * Branch name from `git ls-remote --symref origin HEAD` output
 * (`ref: refs/heads/<b>\tHEAD`), else null (#6970). String steps, no regex.
 */
export function remoteHeadBranchFromLsRemote(stdout: string): string | null {
  const prefix = "ref: refs/heads/";
  for (const raw of stdout.split("\n")) {
    const line = raw.trim();
    if (!line.startsWith(prefix)) continue;
    const rest = line.slice(prefix.length);
    const tab = rest.indexOf("\t");
    if (tab === -1 || rest.slice(tab + 1).trim() !== "HEAD") continue;
    const name = rest.slice(0, tab);
    return isSafeBranchName(name) ? name : null;
  }
  return null;
}

function prepFailure(message: string): NoSuitePrep {
  return { ok: false, exitCode: 2, message };
}

/** `GitRunner` over the `NoSuiteGitFn` seam, so the resolvers stay offline in tests. */
function gitRunnerOver(git: NoSuiteGitFn): GitRunner {
  return (root, args) => {
    const result = git(args, root);
    return { code: result.status ?? 1, stdout: result.stdout, stderr: result.stderr };
  };
}

function deliverySource(delivery: DeliveryBranchResult, remoteHead: string | null) {
  if (delivery.source === "typed") return { kind: "delivery-policy" } as const;
  if (delivery.source === "default-fallback") return { kind: "fallback" } as const;
  if (remoteHead !== null && delivery.branch === remoteHead) {
    return { kind: "remote-head" } as const;
  }
  return { kind: "local-default" } as const;
}

type ResolvedBranches =
  | {
      readonly ok: true;
      readonly delivery: NoSuiteBranch;
      readonly base: NoSuiteBranch;
      readonly fetched: readonly NoSuiteBranch[];
    }
  | { readonly ok: false; readonly prep: NoSuitePrep };

/** Malformed present policy refuses before any fetch (#6970 item 1). */
function malformedPolicy(projectRoot: string, runGit: GitRunner): NoSuitePrep | null {
  const delivery = resolveDeliveryBranch(projectRoot, runGit);
  if (
    (delivery.source === "typed" && delivery.error !== null) ||
    delivery.source === "default-on-error"
  ) {
    return prepFailure(
      `check --no-suite: ${FIELD_DELIVERY_BRANCH} is malformed (${delivery.error ?? "invalid"}); ` +
        `no gate ran. Correct ${FIELD_DELIVERY_BRANCH}, then run again.`,
    );
  }
  const base = resolveBaseBranch(projectRoot, runGit);
  if ((base.source === "typed" && base.error !== null) || base.source === "default-on-error") {
    return prepFailure(
      `check --no-suite: ${FIELD_BASE_BRANCH} is malformed (${base.error ?? "invalid"}); ` +
        `no gate ran. Correct ${FIELD_BASE_BRANCH}, then run again.`,
    );
  }
  return null;
}

/**
 * Resolve the delivery and base branches (#6970 items 1-2). When nothing local
 * names a default, ask origin for its HEAD branch, fetch it, and only then
 * point `origin/HEAD` at it so the gates' own resolvers see the same branch.
 * A failed query keeps the fallback (origin named no default). Once origin
 * has named its HEAD branch, a failed fetch or `set-head` stops the run: going
 * on would compare against the fallback, not origin's default.
 */
function resolveBranches(
  projectRoot: string,
  git: NoSuiteGitFn,
  fetchBranch: (branch: NoSuiteBranch) => NoSuitePrep | null,
): ResolvedBranches {
  const runGit = gitRunnerOver(git);
  const malformed = malformedPolicy(projectRoot, runGit);
  if (malformed !== null) return { ok: false, prep: malformed };

  let remoteHead: string | null = null;
  const fetched: NoSuiteBranch[] = [];
  if (resolveDeliveryBranch(projectRoot, runGit).source === "default-fallback") {
    const query = git(["ls-remote", "--symref", "origin", "HEAD"], projectRoot);
    const name = query.status === 0 ? remoteHeadBranchFromLsRemote(query.stdout) : null;
    if (name !== null) {
      const candidate: NoSuiteBranch = { branch: name, source: { kind: "remote-head" } };
      const fetchFailure = fetchBranch(candidate);
      if (fetchFailure !== null) return { ok: false, prep: fetchFailure };
      fetched.push(candidate);
      const setHead = git(["remote", "set-head", "origin", name], projectRoot);
      if (setHead.status !== 0) {
        const detail = setHead.stderr.trim();
        return {
          ok: false,
          prep: prepFailure(
            `check --no-suite: git remote set-head origin ${name} failed ` +
              `(exit ${setHead.status ?? "none"})${detail.length > 0 ? `: ${detail}` : ""}; ` +
              "no gate ran. The gates find the default branch through origin/HEAD; " +
              `set ${FIELD_DELIVERY_BRANCH} to ${name}, then run again.`,
          ),
        };
      }
      remoteHead = name;
    }
  }

  const deliveryResult = resolveDeliveryBranch(projectRoot, runGit);
  const delivery: NoSuiteBranch = {
    branch: deliveryResult.branch,
    source: deliverySource(deliveryResult, remoteHead),
  };
  const baseResult = resolveBaseBranch(projectRoot, runGit);
  const base: NoSuiteBranch =
    baseResult.source === "typed"
      ? { branch: baseResult.branch, source: { kind: "base-policy" } }
      : delivery;
  return { ok: true, delivery, base, fetched };
}

interface PullLookup {
  readonly pr: { readonly number: number; readonly json: Record<string, unknown> } | null;
  readonly reason: string;
}

function lookupPullRequest(
  slug: string | null,
  headSha: string,
  ghGet: NoSuiteGhGetFn,
): PullLookup {
  if (slug === null) {
    return { pr: null, reason: "origin is not a GitHub remote" };
  }
  if (headSha.length === 0) {
    return { pr: null, reason: "HEAD could not be read" };
  }
  const listed = ghGet(`repos/${slug}/commits/${headSha}/pulls`);
  if (!listed.ok) {
    return { pr: null, reason: `pull request lookup failed (${listed.error})` };
  }
  const open = openPullsAtHead(listed.json, headSha);
  if (open.length === 0) {
    return { pr: null, reason: `no open pull request has head ${headSha.slice(0, 12)}` };
  }
  if (open.length > 1) {
    return {
      pr: null,
      reason: `${open.length} open pull requests have head ${headSha.slice(0, 12)} (#${open.join(", #")})`,
    };
  }
  const number = open[0] as number;
  const detail = ghGet(`repos/${slug}/pulls/${number}`);
  const json = detail.ok ? asRecord(detail.json) : null;
  if (json === null) {
    const why = detail.ok ? "not an object" : detail.error;
    return { pr: null, reason: `reading pull request #${number} failed (${why})` };
  }
  return { pr: { number, json }, reason: "" };
}

/**
 * Fetch one branch with `trackingFetchArgv` (#6970 items 3 and 5). Returns null
 * on success, else the exit-2 prep: an unsafe name, a branch origin does not
 * have (exact `ls-remote` probe exit 2), a failure while origin has the branch,
 * or today's network text when the probe is inconclusive.
 */
function fetchNoSuiteBranch(
  git: NoSuiteGitFn,
  cwd: string,
  target: NoSuiteBranch,
): NoSuitePrep | null {
  const label = noSuiteBranchSourceLabel(target.source);
  const argv = trackingFetchArgv("origin", target.branch);
  if (!argv.ok) {
    return prepFailure(`check --no-suite: ${argv.error} (from ${label}); no gate ran.`);
  }
  const result = git(argv.argv, cwd);
  if (result.status === 0) return null;
  const detail = result.stderr.trim();
  const exit = result.status ?? "none";
  const probe = git(["ls-remote", "--exit-code", "origin", `refs/heads/${target.branch}`], cwd);
  if (probe.status === 2) {
    return prepFailure(
      `check --no-suite: origin has no branch ${target.branch} (from ${label}); no gate ran. ` +
        missingBranchFix(target.source),
    );
  }
  if (probe.status === 0) {
    return prepFailure(
      `check --no-suite: git fetch of ${target.branch} (from ${label}) failed (exit ${exit}) ` +
        `although origin has that branch${detail.length > 0 ? `: ${detail}` : ""}; no gate ran. ` +
        "Run again; if it fails again, run the same git fetch by hand to see the cause.",
    );
  }
  const refspec = `refs/heads/${target.branch}:refs/remotes/origin/${target.branch}`;
  return prepFailure(
    `check --no-suite: git fetch origin ${refspec} failed (exit ${exit})` +
      `${detail.length > 0 ? `: ${detail}` : ""}; no gate ran. ` +
      "Restore network or remote access, then run again.",
  );
}

/**
 * Prepare a `deft check --no-suite` run (#6469 items 4 and 5; #6970). On
 * success the caller passes `env` to every gate, prints `header`, and calls
 * `cleanup` after the last gate.
 */
export function prepareNoSuiteRun(input: NoSuitePrepInput): NoSuitePrep {
  const git = input.git ?? defaultGit;
  const ghGet = input.ghGet ?? defaultGhGet;
  const writeEvent = input.writeEvent ?? defaultWriteEvent;
  const cwd = input.projectRoot;
  const fetchBranch = (target: NoSuiteBranch) => fetchNoSuiteBranch(git, cwd, target);

  const resolved = resolveBranches(cwd, git, fetchBranch);
  if (!resolved.ok) return resolved.prep;

  const headSha = git(["rev-parse", "HEAD"], cwd).stdout.trim();
  const slug = repoSlugFromRemoteUrl(git(["remote", "get-url", "origin"], cwd).stdout);
  const lookup = lookupPullRequest(slug, headSha, ghGet);

  const base = asRecord(lookup.pr?.json.base);
  const prBase = typeof base?.ref === "string" && base.ref.length > 0 ? base.ref : null;
  const comparison: NoSuiteBranch =
    prBase !== null && lookup.pr !== null
      ? { branch: prBase, source: { kind: "pull-request", number: lookup.pr.number } }
      : resolved.base;

  const fetched: NoSuiteBranch[] = [...resolved.fetched];
  for (const target of [comparison, resolved.delivery]) {
    if (fetched.some((done) => done.branch === target.branch)) continue;
    const failure = fetchBranch(target);
    if (failure !== null) return failure;
    fetched.push(target);
  }

  const baseRef = comparison.branch;
  const mergeBase = git(["merge-base", "HEAD", `origin/${baseRef}`], cwd).stdout.trim();
  const env = clearNoSuiteEnv(input.env);
  const header = [
    `check --no-suite: fetched ${fetched
      .map((b) => `origin/${b.branch} (${noSuiteBranchSourceLabel(b.source)})`)
      .join(" and ")}`,
    `check --no-suite: merge base ${mergeBase.length > 0 ? mergeBase : "(none found)"} with origin/${baseRef}`,
  ];

  if (lookup.pr === null || slug === null) {
    header.push(
      `check --no-suite: no pull request used: ${lookup.reason}. ` +
        "Checks that read the PR ran in their no-PR form; open the PR, then run again.",
    );
    return { ok: true, env, header, pullRequest: null, cleanup: () => {} };
  }

  const payload = JSON.stringify({ number: lookup.pr.number, pull_request: lookup.pr.json });
  const event = writeEvent(payload);
  env.GITHUB_PR_NUMBER = String(lookup.pr.number);
  env.GITHUB_REPOSITORY = slug;
  env.GITHUB_BASE_REF = baseRef;
  env.GITHUB_EVENT_NAME = "pull_request";
  env.GITHUB_EVENT_PATH = event.path;
  header.push(
    `check --no-suite: pull request #${lookup.pr.number} (${slug}, base ${baseRef}); ` +
      "gates get CI's pull-request context",
  );
  return {
    ok: true,
    env,
    header,
    pullRequest: { number: lookup.pr.number, repository: slug, baseRef },
    cleanup: event.cleanup,
  };
}
