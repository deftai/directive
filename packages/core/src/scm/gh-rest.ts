import { type SpawnSyncOptions, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SUBPROCESS_MAX_BUFFER } from "../subprocess/max-buffer.js";
import { defaultWhich, type WhichFn } from "./binary.js";
import { classifyScmArgv, resolveBinaryForRole } from "./call-shape.js";
import { pyRepr } from "./py-format.js";
import {
  classifySpawnStatus,
  formatScmSpawnDiagnostic,
  isAvailabilitySpawnFailure,
} from "./spawn-status.js";

export const DEFAULT_TIMEOUT_S = 60;

/** Raised when the `"owner/repo"` argument is malformed. */
export class InvalidRepoError extends Error {
  constructor(repo: unknown) {
    const message =
      typeof repo !== "string" || repo.length === 0
        ? `repo must be a non-empty string of the form 'owner/repo'; got ${pyRepr(repo)}`
        : `repo must match 'owner/repo' (single slash, both segments non-empty); got ${pyRepr(repo)}`;
    super(message);
    this.name = "InvalidRepoError";
  }
}

/** Raised on non-zero `gh api` exit or non-JSON success response. */
export class GhRestError extends Error {
  readonly stderr: string;
  readonly exitCode: number;
  readonly endpoint: string;
  readonly payload: Record<string, unknown> | null;
  readonly hint: string;
  readonly binary: string;

  constructor(options: {
    stderr: string;
    exitCode: number;
    endpoint: string;
    payload: Record<string, unknown> | null;
    hint?: string;
    binary?: string;
  }) {
    const hint = options.hint ?? "";
    const binary = options.binary ?? "gh";
    const statusClass = classifySpawnStatus(options.exitCode);
    let msg =
      `${binary} api failed: endpoint=${pyRepr(options.endpoint)} ` + `exit=${options.exitCode}`;
    if (statusClass !== `exit ${options.exitCode}`) {
      msg += ` (${statusClass})`;
    }
    msg += ` stderr=${pyRepr(options.stderr)}`;
    if (hint.length > 0) {
      msg += `; hint: ${hint}`;
    }
    super(msg);
    this.name = "GhRestError";
    this.stderr = options.stderr;
    this.exitCode = options.exitCode;
    this.endpoint = options.endpoint;
    this.payload = options.payload;
    this.hint = hint;
    this.binary = binary;
  }
}

export type GhSpawnResult = {
  readonly status: number | null;
  readonly stdout?: string | Buffer | null;
  readonly stderr?: string | Buffer | null;
  readonly error?: { readonly message?: string; readonly code?: string };
};

export type GhSpawnFn = (
  command: string,
  args: readonly string[],
  options: SpawnSyncOptions,
) => GhSpawnResult;

export type GhApiProcess = {
  returncode: number;
  stdout: string;
  stderr: string;
  binary?: string;
};

export type RunGhApiFn = (
  args: readonly string[],
  options?: { timeout?: number; whichFn?: WhichFn; spawnFn?: GhSpawnFn },
) => GhApiProcess;

function defaultGhSpawn(
  command: string,
  args: readonly string[],
  options: SpawnSyncOptions,
): GhSpawnResult {
  return spawnSync(command, [...args], options);
}

function finalizeGhApiResult(
  binary: string,
  result: GhSpawnResult,
): GhApiProcess & {
  readonly rawStderr: string;
  readonly rawStatus: number | null;
  readonly error?: { readonly message?: string; readonly code?: string };
} {
  const rawStderr = typeof result.stderr === "string" ? result.stderr : "";
  let stderr = rawStderr;
  if (result.status === null && result.error && stderr.trim().length === 0) {
    stderr = result.error.message ?? "";
  }
  if (
    isAvailabilitySpawnFailure({
      status: result.status,
      error: result.error,
      stdout: typeof result.stdout === "string" ? result.stdout : "",
      stderr: rawStderr,
    }) &&
    stderr.trim().length === 0
  ) {
    stderr = formatScmSpawnDiagnostic(binary, result.status, stderr, result.error);
  }
  return {
    returncode: result.status ?? 1,
    stdout: typeof result.stdout === "string" ? result.stdout : "",
    stderr,
    binary,
    rawStderr,
    rawStatus: result.status,
    error: result.error,
  };
}

/** Single subprocess seam invoked by every helper. */
export function runGhApi(
  args: readonly string[],
  options: { timeout?: number; whichFn?: WhichFn; spawnFn?: GhSpawnFn } = {},
): GhApiProcess {
  const whichFn = options.whichFn ?? defaultWhich;
  const spawnFn = options.spawnFn ?? defaultGhSpawn;
  const role = classifyScmArgv("api", args);
  let binary = resolveBinaryForRole(role, whichFn);
  const timeoutMs =
    options.timeout !== undefined ? Math.round(options.timeout * 1000) : DEFAULT_TIMEOUT_S * 1000;
  const spawnOpts: SpawnSyncOptions = {
    encoding: "utf8",
    timeout: timeoutMs,
    env: process.env,
    maxBuffer: SUBPROCESS_MAX_BUFFER,
    stdio: ["ignore", "pipe", "pipe"],
  };
  const spawnOnce = (bin: string) =>
    finalizeGhApiResult(bin, spawnFn(bin, ["api", ...args], spawnOpts));
  let first = spawnOnce(binary);
  if (
    role === "cached-get" &&
    binary === "ghx" &&
    isAvailabilitySpawnFailure({
      status: first.rawStatus,
      error: first.error,
      stdout: first.stdout,
      stderr: first.rawStderr,
    }) &&
    whichFn("gh") !== null
  ) {
    binary = "gh";
    first = spawnOnce(binary);
  }
  return {
    returncode: first.returncode,
    stdout: first.stdout,
    stderr: first.stderr,
    binary,
  };
}

export function splitRepo(repo: string): [string, string] {
  if (typeof repo !== "string" || repo.length === 0) {
    throw new InvalidRepoError(repo);
  }
  const parts = repo.split("/");
  if (parts.length !== 2 || parts[0] === "" || parts[1] === "") {
    throw new InvalidRepoError(repo);
  }
  return [parts[0] as string, parts[1] as string];
}

function execApi(
  args: readonly string[],
  options: {
    endpoint: string;
    payload: Record<string, unknown> | null;
    hint?: string;
    expectList?: boolean;
    runGhApiFn?: RunGhApiFn;
    whichFn?: WhichFn;
  },
): unknown {
  const runner = options.runGhApiFn ?? runGhApi;
  const result = runner(args, { whichFn: options.whichFn });
  if (result.returncode !== 0) {
    throw new GhRestError({
      stderr: result.stderr.trim(),
      exitCode: result.returncode,
      endpoint: options.endpoint,
      payload: options.payload,
      hint: options.hint ?? "",
      binary: result.binary ?? "gh",
    });
  }
  const stdout = result.stdout.trim();
  if (stdout.length === 0) {
    return options.expectList ? [] : {};
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout) as unknown;
  } catch (exc: unknown) {
    const message = exc instanceof Error ? exc.message : String(exc);
    throw new GhRestError({
      stderr: `non-JSON response: ${message}; raw=${pyRepr(stdout)}`,
      exitCode: 0,
      endpoint: options.endpoint,
      payload: options.payload,
      hint: "REST endpoint returned non-JSON; check gh / ghx version",
    });
  }
  const expectedList = options.expectList ?? false;
  if (expectedList) {
    if (!Array.isArray(parsed)) {
      throw new GhRestError({
        stderr: `unexpected top-level type ${typeof parsed}`,
        exitCode: 0,
        endpoint: options.endpoint,
        payload: options.payload,
        hint: "REST endpoint returned non-list; expected list",
      });
    }
    return parsed;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new GhRestError({
      stderr: `unexpected top-level type ${Array.isArray(parsed) ? "list" : typeof parsed}`,
      exitCode: 0,
      endpoint: options.endpoint,
      payload: options.payload,
      hint: "REST endpoint returned non-dict; expected dict",
    });
  }
  return parsed;
}

export interface GhRestSeams {
  readonly runGhApiFn?: RunGhApiFn;
  readonly whichFn?: WhichFn;
}

/** `GET /repos/{owner}/{repo}/issues/{n}` -- read a single issue. */
export function restIssueView(
  repo: string,
  n: number,
  seams: GhRestSeams = {},
): Record<string, unknown> {
  const [owner, name] = splitRepo(repo);
  const endpoint = `repos/${owner}/${name}/issues/${n}`;
  return execApi([endpoint], {
    endpoint,
    payload: null,
    hint: "verify repo and issue number; check gh auth status",
    runGhApiFn: seams.runGhApiFn,
    whichFn: seams.whichFn,
  }) as Record<string, unknown>;
}

export interface RestIssueListOptions {
  readonly state?: string;
  readonly labels?: readonly string[];
  readonly author?: string | null;
  readonly perPage?: number;
}

/** `GET /repos/{owner}/{repo}/issues` -- list issues (REST collection). */
export function restIssueList(
  repo: string,
  options: RestIssueListOptions = {},
  seams: GhRestSeams = {},
): Record<string, unknown>[] {
  const state = options.state ?? "open";
  const labels = options.labels ?? [];
  const author = options.author ?? null;
  const perPage = options.perPage ?? 30;
  const [owner, name] = splitRepo(repo);
  const endpoint = `repos/${owner}/${name}/issues`;
  const args: string[] = [endpoint, "--method", "GET"];
  args.push("--raw-field", `state=${state}`);
  args.push("--raw-field", `per_page=${perPage}`);
  if (labels.length > 0) {
    args.push("--raw-field", `labels=${labels.join(",")}`);
  }
  if (author !== null && author.length > 0) {
    args.push("--raw-field", `creator=${author}`);
  }
  return execApi(args, {
    endpoint,
    payload: null,
    hint:
      "verify repo, state value (open|closed|all), labels exist, " +
      "and core REST bucket has remaining quota",
    expectList: true,
    runGhApiFn: seams.runGhApiFn,
    whichFn: seams.whichFn,
  }) as Record<string, unknown>[];
}

export const REST_MAX_PER_PAGE = 100;
export const REST_PAGINATION_MAX_PAGES = 100;

export const PUBLIC_HELPERS = [
  "restCreateIssue",
  "restPostComment",
  "restUpdateComment",
  "restDeleteComment",
  "restGetUser",
  "restUpdateIssue",
  "restCreateLabel",
  "restCloseIssue",
  "restOpenPr",
  "restMergePr",
  "restIssueView",
  "restPrView",
  "restIssueList",
  "restIssueListPaginated",
  "restIssueListOpenInventory",
] as const;

function writeJsonPayload(payload: Record<string, unknown>): { path: string; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "gh_rest_payload_"));
  const path = join(dir, "payload.json");
  writeFileSync(path, JSON.stringify(payload), "utf8");
  return { path, dir };
}

function execMutation(
  args: readonly string[],
  options: {
    endpoint: string;
    payload: Record<string, unknown>;
    hint?: string;
    runGhApiFn?: RunGhApiFn;
    whichFn?: WhichFn;
  },
): Record<string, unknown> {
  const written = writeJsonPayload(options.payload);
  try {
    return execApi([...args, "--input", written.path], {
      endpoint: options.endpoint,
      payload: options.payload,
      hint: options.hint,
      runGhApiFn: options.runGhApiFn,
      whichFn: options.whichFn,
    }) as Record<string, unknown>;
  } finally {
    rmSync(written.dir, { recursive: true, force: true });
  }
}

export function restCreateIssue(
  repo: string,
  title: string,
  body: string,
  labels: readonly string[] = [],
  seams: GhRestSeams = {},
): Record<string, unknown> {
  const [owner, name] = splitRepo(repo);
  const payload: Record<string, unknown> = { title, body };
  if (labels.length > 0) {
    payload.labels = [...labels];
  }
  const endpoint = `repos/${owner}/${name}/issues`;
  return execMutation([endpoint, "--method", "POST"], {
    endpoint,
    payload,
    hint: "verify repo permissions, label existence, and that the core REST bucket has remaining quota",
    ...seams,
  });
}

export function restPostComment(
  repo: string,
  n: number,
  body: string,
  seams: GhRestSeams = {},
): Record<string, unknown> {
  const [owner, name] = splitRepo(repo);
  const endpoint = `repos/${owner}/${name}/issues/${n}/comments`;
  return execMutation([endpoint, "--method", "POST"], {
    endpoint,
    payload: { body },
    hint: "verify repo permissions, that the issue/PR is open or lockable, and core REST bucket quota",
    ...seams,
  });
}

/** `PATCH /repos/{owner}/{repo}/issues/comments/{id}` -- edit a PR/issue comment in place. */
export function restUpdateComment(
  repo: string,
  commentId: number,
  body: string,
  seams: GhRestSeams = {},
): Record<string, unknown> {
  const [owner, name] = splitRepo(repo);
  const endpoint = `repos/${owner}/${name}/issues/comments/${commentId}`;
  return execMutation([endpoint, "--method", "PATCH"], {
    endpoint,
    payload: { body },
    hint: "verify repo permissions and comment id; check gh auth status",
    ...seams,
  });
}

/** `DELETE /repos/{owner}/{repo}/issues/comments/{id}` -- remove a duplicate claim comment. */
export function restDeleteComment(
  repo: string,
  commentId: number,
  seams: GhRestSeams = {},
): Record<string, unknown> {
  const [owner, name] = splitRepo(repo);
  const endpoint = `repos/${owner}/${name}/issues/comments/${commentId}`;
  return execMutation([endpoint, "--method", "DELETE"], {
    endpoint,
    payload: {},
    hint: "verify repo permissions and comment id; check gh auth status",
    ...seams,
  });
}

/** `GET /user` -- authenticated GitHub login for review-owner claims. */
export function restGetUser(seams: GhRestSeams = {}): Record<string, unknown> {
  return execApi(["user"], {
    endpoint: "user",
    payload: null,
    hint: "verify gh auth status (`gh auth login`)",
    runGhApiFn: seams.runGhApiFn,
    whichFn: seams.whichFn,
  }) as Record<string, unknown>;
}

export function restUpdateIssue(
  repo: string,
  n: number,
  patch: Record<string, unknown>,
  seams: GhRestSeams = {},
): Record<string, unknown> {
  const [owner, name] = splitRepo(repo);
  const endpoint = `repos/${owner}/${name}/issues/${n}`;
  return execMutation([endpoint, "--method", "PATCH"], {
    endpoint,
    payload: patch,
    hint: "verify repo permissions and issue number; check gh auth status",
    ...seams,
  });
}

export function restCreateLabel(
  repo: string,
  name: string,
  color: string,
  description: string,
  seams: GhRestSeams = {},
): Record<string, unknown> {
  const [owner, repoName] = splitRepo(repo);
  const endpoint = `repos/${owner}/${repoName}/labels`;
  return execMutation([endpoint, "--method", "POST"], {
    endpoint,
    payload: { name, color, description },
    hint: "verify repo permissions; label may already exist (422 is acceptable for idempotent bootstrap)",
    ...seams,
  });
}

export function restCloseIssue(
  repo: string,
  n: number,
  reason: string | null = "completed",
  seams: GhRestSeams = {},
): Record<string, unknown> {
  const [owner, name] = splitRepo(repo);
  const endpoint = `repos/${owner}/${name}/issues/${n}`;
  return execMutation([endpoint, "--method", "PATCH"], {
    endpoint,
    payload: { state: "closed", state_reason: reason },
    hint: "verify repo permissions and that the issue is open (closing a closed issue is idempotent server-side)",
    ...seams,
  });
}

export function restOpenPr(
  repo: string,
  head: string,
  base: string,
  title: string,
  body: string,
  options: { draft?: boolean } & GhRestSeams = {},
): Record<string, unknown> {
  const [owner, name] = splitRepo(repo);
  const endpoint = `repos/${owner}/${name}/pulls`;
  return execMutation([endpoint, "--method", "POST"], {
    endpoint,
    payload: { title, head, base, body, draft: options.draft ?? false },
    hint: "verify branch exists on origin, head/base differ, repo permissions, and core REST bucket quota",
    runGhApiFn: options.runGhApiFn,
    whichFn: options.whichFn,
  });
}

export function restMergePr(
  repo: string,
  n: number,
  options: {
    method?: string;
    commitTitle?: string | null;
    commitMessage?: string | null;
  } & GhRestSeams = {},
): Record<string, unknown> {
  const [owner, name] = splitRepo(repo);
  const payload: Record<string, unknown> = { merge_method: options.method ?? "squash" };
  if (options.commitTitle !== undefined && options.commitTitle !== null) {
    payload.commit_title = options.commitTitle;
  }
  if (options.commitMessage !== undefined && options.commitMessage !== null) {
    payload.commit_message = options.commitMessage;
  }
  const endpoint = `repos/${owner}/${name}/pulls/${n}/merge`;
  return execMutation([endpoint, "--method", "PUT"], {
    endpoint,
    payload,
    hint: "verify PR is non-draft, mergeable, branch-protection checks pass, and required reviews are satisfied",
    runGhApiFn: options.runGhApiFn,
    whichFn: options.whichFn,
  });
}

export function restPrView(
  repo: string,
  n: number,
  seams: GhRestSeams = {},
): Record<string, unknown> {
  const [owner, name] = splitRepo(repo);
  const endpoint = `repos/${owner}/${name}/pulls/${n}`;
  return execApi([endpoint], {
    endpoint,
    payload: null,
    hint: "verify repo and PR number; check gh auth status",
    runGhApiFn: seams.runGhApiFn,
    whichFn: seams.whichFn,
  }) as Record<string, unknown>;
}

export interface RestIssueListPaginatedOptions extends RestIssueListOptions {
  readonly limit?: number | null;
  readonly excludePulls?: boolean;
}

const OPEN_INVENTORY_MAX_ISSUES = REST_PAGINATION_MAX_PAGES * REST_MAX_PER_PAGE;

function issueRowOrThrow(item: unknown, endpoint: string): Record<string, unknown> {
  if (typeof item !== "object" || item === null || Array.isArray(item)) {
    throw new GhRestError({
      stderr: "open-issue inventory row is not an object",
      exitCode: 0,
      endpoint,
      payload: null,
      hint: "REST issue list rows must be objects",
    });
  }
  return item as Record<string, unknown>;
}

/** Flatten `gh api --paginate --slurp` issue-list output (pages or single page). */
export function flattenOpenInventoryPayload(
  parsed: unknown[],
  endpoint: string,
): Record<string, unknown>[] {
  if (parsed.length === 0) {
    return [];
  }
  const out: Record<string, unknown>[] = [];
  const allPages = parsed.every((item) => Array.isArray(item));
  if (allPages) {
    for (const page of parsed) {
      if (!Array.isArray(page)) {
        continue;
      }
      for (const item of page) {
        const row = issueRowOrThrow(item, endpoint);
        if ("pull_request" in row) {
          continue;
        }
        out.push(row);
      }
    }
    return out;
  }
  for (const item of parsed) {
    const row = issueRowOrThrow(item, endpoint);
    if ("pull_request" in row) {
      continue;
    }
    out.push(row);
  }
  return out;
}

/**
 * Complete open-issue inventory in one `gh api --paginate --slurp` subprocess (#3752).
 * Fail-closed on command failure, non-array JSON, buffer exhaustion, or cap hit.
 * Pull-request rows are excluded.
 */
export function restIssueListOpenInventory(
  repo: string,
  seams: GhRestSeams = {},
): Record<string, unknown>[] {
  const [owner, name] = splitRepo(repo);
  const endpoint = `repos/${owner}/${name}/issues?state=open&per_page=${REST_MAX_PER_PAGE}`;
  const runner = seams.runGhApiFn ?? runGhApi;
  const result = runner(["--paginate", "--slurp", endpoint], { timeout: 120 });
  if (result.returncode !== 0) {
    throw new GhRestError({
      stderr: result.stderr.trim(),
      exitCode: result.returncode,
      endpoint,
      payload: null,
      hint: "verify gh auth and core REST quota; open-issue inventory must be complete",
      binary: result.binary ?? "gh",
    });
  }
  const stdout = result.stdout.trim();
  if (stdout.length === 0) {
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch (exc: unknown) {
    const message = exc instanceof Error ? exc.message : String(exc);
    throw new GhRestError({
      stderr: `non-JSON open-issue inventory: ${message}`,
      exitCode: 0,
      endpoint,
      payload: null,
      hint: "gh api --paginate --slurp must return a JSON array",
    });
  }
  if (!Array.isArray(parsed)) {
    throw new GhRestError({
      stderr: `unexpected top-level type ${typeof parsed}`,
      exitCode: 0,
      endpoint,
      payload: null,
      hint: "open-issue inventory must be a JSON array",
    });
  }
  const out = flattenOpenInventoryPayload(parsed, endpoint);
  if (out.length >= OPEN_INVENTORY_MAX_ISSUES) {
    throw new GhRestError({
      stderr: `open-issue inventory reached cap ${OPEN_INVENTORY_MAX_ISSUES}; pagination may be incomplete`,
      exitCode: 0,
      endpoint,
      payload: null,
      hint: "repo may exceed supported open-issue count; fail closed rather than truncate",
    });
  }
  return out;
}

export function restIssueListPaginated(
  repo: string,
  options: RestIssueListPaginatedOptions = {},
  seams: GhRestSeams = {},
): Record<string, unknown>[] {
  const cappedPerPage = Math.min(
    Math.max(1, options.perPage ?? REST_MAX_PER_PAGE),
    REST_MAX_PER_PAGE,
  );
  const [owner, name] = splitRepo(repo);
  const endpoint = `repos/${owner}/${name}/issues`;
  const out: Record<string, unknown>[] = [];
  const excludePulls = options.excludePulls ?? true;

  for (let page = 1; page <= REST_PAGINATION_MAX_PAGES; page += 1) {
    const args: string[] = [endpoint, "--method", "GET"];
    args.push("--raw-field", `state=${options.state ?? "open"}`);
    args.push("--raw-field", `per_page=${cappedPerPage}`);
    args.push("--raw-field", `page=${page}`);
    if ((options.labels ?? []).length > 0) {
      args.push("--raw-field", `labels=${(options.labels ?? []).join(",")}`);
    }
    if (options.author !== undefined && options.author !== null && options.author.length > 0) {
      args.push("--raw-field", `creator=${options.author}`);
    }
    const pagePayload = execApi(args, {
      endpoint,
      payload: null,
      hint: "verify repo, state value (open|closed|all), labels exist, and core REST bucket has remaining quota",
      expectList: true,
      runGhApiFn: seams.runGhApiFn,
      whichFn: seams.whichFn,
    }) as Record<string, unknown>[];

    if (pagePayload.length === 0) {
      return out;
    }
    for (const item of pagePayload) {
      if (excludePulls && "pull_request" in item) {
        continue;
      }
      out.push(item);
      if (options.limit !== undefined && options.limit !== null && out.length >= options.limit) {
        return out.slice(0, options.limit);
      }
    }
    if (pagePayload.length < cappedPerPage) {
      return out;
    }
  }

  throw new GhRestError({
    stderr: `pagination exceeded REST_PAGINATION_MAX_PAGES=${REST_PAGINATION_MAX_PAGES}`,
    exitCode: 0,
    endpoint,
    payload: null,
    hint: "pass an explicit `limit` to bound the run, or open a follow-up to add explicit `page` cursor support",
  });
}
