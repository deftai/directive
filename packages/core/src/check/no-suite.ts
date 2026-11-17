/**
 * check/no-suite.ts -- run preparation for `deft check --no-suite` (#6469).
 *
 * Before any gate, a no-suite run does what CI's merge-gate job does before
 * `task check:merge`:
 *  1. fetch `origin master:refs/remotes/origin/master` (and the PR's base
 *     branch when it has another name); a failed fetch runs no gate (exit 2);
 *  2. look up the head's open pull request once by REST;
 *  3. build the gate environment: no worker pin (`DEFT_ACTIVE_SCOPE`,
 *     `DEFT_BASE_REF`) and no inherited `GITHUB_*` PR variables, then CI's
 *     pull-request context when the head has exactly one open PR, with a
 *     temporary event payload file holding that PR;
 *  4. print the header lines: the merge base and the PR used, or the no-PR line.
 *
 * Every git, gh and temp-file call goes through a seam so the module is
 * testable without a network or a real repository.
 */

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultWhich } from "../doctor/which.js";
import { containedWrite } from "../fs/contained-write.js";
import { ACTIVE_SCOPE_PIN_ENV } from "../hooks/scope.js";
import { runGhApi } from "../scm/gh-rest.js";
import { SUBPROCESS_MAX_BUFFER } from "../subprocess/max-buffer.js";

/** CI's merge-gate fetch refspec (`.github/workflows/ci.yml` merge-gate job). */
export const NO_SUITE_MASTER_REFSPEC = "master:refs/remotes/origin/master";

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

function fetchFailure(refspec: string, result: NoSuiteGitResult): NoSuitePrep {
  const detail = result.stderr.trim();
  return {
    ok: false,
    exitCode: 2,
    message:
      `check --no-suite: git fetch origin ${refspec} failed (exit ${result.status ?? "none"})` +
      `${detail.length > 0 ? `: ${detail}` : ""}; no gate ran. ` +
      "Restore network or remote access, then run again.",
  };
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
 * Prepare a `deft check --no-suite` run (#6469 items 4 and 5). On success the
 * caller passes `env` to every gate, prints `header`, and calls `cleanup` after
 * the last gate.
 */
export function prepareNoSuiteRun(input: NoSuitePrepInput): NoSuitePrep {
  const git = input.git ?? defaultGit;
  const ghGet = input.ghGet ?? defaultGhGet;
  const writeEvent = input.writeEvent ?? defaultWriteEvent;
  const cwd = input.projectRoot;

  const masterFetch = git(["fetch", "origin", NO_SUITE_MASTER_REFSPEC], cwd);
  if (masterFetch.status !== 0) {
    return fetchFailure(NO_SUITE_MASTER_REFSPEC, masterFetch);
  }

  const headSha = git(["rev-parse", "HEAD"], cwd).stdout.trim();
  const slug = repoSlugFromRemoteUrl(git(["remote", "get-url", "origin"], cwd).stdout);
  const lookup = lookupPullRequest(slug, headSha, ghGet);

  const base = asRecord(lookup.pr?.json.base);
  const baseRef = typeof base?.ref === "string" && base.ref.length > 0 ? base.ref : "master";
  if (baseRef !== "master") {
    const refspec = `${baseRef}:refs/remotes/origin/${baseRef}`;
    const baseFetch = git(["fetch", "origin", refspec], cwd);
    if (baseFetch.status !== 0) {
      return fetchFailure(refspec, baseFetch);
    }
  }

  const mergeBase = git(["merge-base", "HEAD", `origin/${baseRef}`], cwd).stdout.trim();
  const env = clearNoSuiteEnv(input.env);
  const header = [
    `check --no-suite: fetched origin/master${baseRef !== "master" ? ` and origin/${baseRef}` : ""}`,
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
