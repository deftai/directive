import { spawnSync } from "node:child_process";
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
    stdio: ["ignore", "pipe", "pipe"],
  });
  return {
    returncode: result.status ?? 1,
    stdout: typeof result.stdout === "string" ? result.stdout : "",
    stderr: typeof result.stderr === "string" ? result.stderr : "",
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
