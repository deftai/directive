import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SUBPROCESS_MAX_BUFFER } from "../subprocess/max-buffer.js";
import { resolveBinary } from "./binary.js";
import { pyRepr } from "./py-format.js";

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

  constructor(options: {
    stderr: string;
    exitCode: number;
    endpoint: string;
    payload: Record<string, unknown> | null;
    hint?: string;
  }) {
    const hint = options.hint ?? "";
    let msg =
      `gh api failed: endpoint=${pyRepr(options.endpoint)} ` +
      `exit=${options.exitCode} stderr=${pyRepr(options.stderr)}`;
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
  }
}

export type RunGhApiFn = (
  args: readonly string[],
  options?: { timeout?: number; whichFn?: Parameters<typeof resolveBinary>[0] },
) => { returncode: number; stdout: string; stderr: string };

/** Single subprocess seam invoked by every helper. */
export function runGhApi(
  args: readonly string[],
  options: { timeout?: number; whichFn?: Parameters<typeof resolveBinary>[0] } = {},
): { returncode: number; stdout: string; stderr: string } {
  const binary = resolveBinary(options.whichFn);
  const timeoutMs =
    options.timeout !== undefined ? Math.round(options.timeout * 1000) : DEFAULT_TIMEOUT_S * 1000;
  const result = spawnSync(binary, ["api", ...args], {
    encoding: "utf8",
    timeout: timeoutMs,
    env: process.env,
    maxBuffer: SUBPROCESS_MAX_BUFFER,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = typeof result.stderr === "string" ? result.stderr : "";
  // A spawn-level failure (e.g. ENOBUFS when stdout exceeds maxBuffer) yields a
  // null status and empty stderr; surface error.message so the GhRestError that
  // wraps this never reports a blank reason (#1867).
  if (result.status === null && result.error && stderr.trim().length === 0) {
    stderr = result.error.message;
  }
  return {
    returncode: result.status ?? 1,
    stdout: typeof result.stdout === "string" ? result.stdout : "",
    stderr,
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
    whichFn?: Parameters<typeof resolveBinary>[0];
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
  readonly whichFn?: Parameters<typeof resolveBinary>[0];
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
  "restCloseIssue",
  "restOpenPr",
  "restMergePr",
  "restIssueView",
  "restPrView",
  "restIssueList",
  "restIssueListPaginated",
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
    whichFn?: Parameters<typeof resolveBinary>[0];
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
