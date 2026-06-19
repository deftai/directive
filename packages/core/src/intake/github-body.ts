import { readFileSync } from "node:fs";
import { defaultWhich } from "../scm/binary.js";
import { type CompletedProcess, call } from "../scm/call.js";

export const DEFAULT_TIMEOUT_SECONDS = 60;

export class GitHubBodyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GitHubBodyError";
  }
}

export type RunGhApiFn = (
  args: readonly string[],
  options?: { inputText?: string | null; binary?: string },
) => Record<string, unknown>;

function splitRepo(repo: string): [string, string] {
  const parts = repo.split("/", 2);
  if (parts.length !== 2 || parts[0] === "" || parts[1] === "" || parts[1]?.includes("/")) {
    throw new GitHubBodyError(`repo must be OWNER/NAME; got ${JSON.stringify(repo)}`);
  }
  return [parts[0] as string, parts[1] as string];
}

/** Resolve the live GitHub CLI used for writes and mutation read-back. */
export function resolveLiveGh(): string {
  if (defaultWhich("gh") === null) {
    throw new GitHubBodyError(
      "gh not found on PATH; safe body posting requires live gh, not ghx, so immediate read-back cannot be served from a stale cache",
    );
  }
  return "gh";
}

export function readBody(bodyFile: string, stdinText?: string | null): string {
  if (bodyFile === "-") {
    return stdinText ?? "";
  }
  return readFileSync(bodyFile, "utf8");
}

function jsonInput(payload: Record<string, unknown>): string {
  return JSON.stringify(payload);
}

function runGhApiJson(
  args: readonly string[],
  options: { inputText?: string | null; binary?: string | null; runFn?: RunGhApiFn } = {},
): Record<string, unknown> {
  if (options.runFn !== undefined) {
    return options.runFn(args, {
      inputText: options.inputText,
      binary: options.binary ?? undefined,
    });
  }
  const binary = options.binary ?? resolveLiveGh();
  let result: CompletedProcess;
  try {
    result = call("github-issue", "api", [...args], {
      binary,
      timeout: DEFAULT_TIMEOUT_SECONDS,
      input: options.inputText ?? undefined,
    });
  } catch {
    throw new GitHubBodyError(`${JSON.stringify(binary)} not found on PATH`);
  }

  if (result.returncode !== 0) {
    const stderr = result.stderr.trim() || "(no stderr)";
    throw new GitHubBodyError(
      `gh api ${args.join(" ")} failed with exit ${result.returncode}: ${stderr}`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout || "{}");
  } catch {
    throw new GitHubBodyError(`gh api ${args.join(" ")} returned non-JSON output`);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new GitHubBodyError(`gh api ${args.join(" ")} returned non-object JSON`);
  }
  return parsed as Record<string, unknown>;
}

function requireIntField(obj: Record<string, unknown>, field: string): number {
  const value = obj[field];
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new GitHubBodyError(
      `mutation response did not include integer field ${JSON.stringify(field)}`,
    );
  }
  return value;
}

function mutateWithReadback(
  mutationEndpoint: string,
  method: string,
  payload: Record<string, unknown>,
  readbackEndpoint: string | ((response: Record<string, unknown>) => string),
  options: { binary?: string | null; runFn?: RunGhApiFn } = {},
): Record<string, unknown> {
  const mutation = runGhApiJson([mutationEndpoint, "--method", method, "--input", "-"], {
    inputText: jsonInput(payload),
    binary: options.binary,
    runFn: options.runFn,
  });
  const endpoint =
    typeof readbackEndpoint === "function" ? readbackEndpoint(mutation) : readbackEndpoint;
  return runGhApiJson([endpoint], { binary: options.binary, runFn: options.runFn });
}

export function createIssue(
  repo: string,
  options: { title: string; body: string; binary?: string | null; runFn?: RunGhApiFn },
): Record<string, unknown> {
  const [owner, name] = splitRepo(repo);
  const endpoint = `repos/${owner}/${name}/issues`;
  return mutateWithReadback(
    endpoint,
    "POST",
    { title: options.title, body: options.body },
    (response) => `repos/${owner}/${name}/issues/${requireIntField(response, "number")}`,
    { binary: options.binary, runFn: options.runFn },
  );
}

export function editIssueBody(
  repo: string,
  issue: number,
  options: { body: string; binary?: string | null; runFn?: RunGhApiFn },
): Record<string, unknown> {
  const [owner, name] = splitRepo(repo);
  const endpoint = `repos/${owner}/${name}/issues/${issue}`;
  return mutateWithReadback(endpoint, "PATCH", { body: options.body }, endpoint, {
    binary: options.binary,
    runFn: options.runFn,
  });
}

export function createIssueComment(
  repo: string,
  issue: number,
  options: { body: string; binary?: string | null; runFn?: RunGhApiFn },
): Record<string, unknown> {
  const [owner, name] = splitRepo(repo);
  const endpoint = `repos/${owner}/${name}/issues/${issue}/comments`;
  return mutateWithReadback(
    endpoint,
    "POST",
    { body: options.body },
    (response) => `repos/${owner}/${name}/issues/comments/${requireIntField(response, "id")}`,
    { binary: options.binary, runFn: options.runFn },
  );
}

export function editIssueCommentBody(
  repo: string,
  commentId: number,
  options: { body: string; binary?: string | null; runFn?: RunGhApiFn },
): Record<string, unknown> {
  const [owner, name] = splitRepo(repo);
  const endpoint = `repos/${owner}/${name}/issues/comments/${commentId}`;
  return mutateWithReadback(endpoint, "PATCH", { body: options.body }, endpoint, {
    binary: options.binary,
    runFn: options.runFn,
  });
}

export function editPrBody(
  repo: string,
  pr: number,
  options: { body: string; binary?: string | null; runFn?: RunGhApiFn },
): Record<string, unknown> {
  const [owner, name] = splitRepo(repo);
  const endpoint = `repos/${owner}/${name}/pulls/${pr}`;
  return mutateWithReadback(endpoint, "PATCH", { body: options.body }, endpoint, {
    binary: options.binary,
    runFn: options.runFn,
  });
}

export interface GitHubBodyCliArgs {
  command: string;
  repo?: string;
  title?: string;
  issue?: number;
  comment?: number;
  pr?: number;
  bodyFile?: string;
}

export function githubBodyMain(args: GitHubBodyCliArgs): number {
  try {
    const body = readBody(args.bodyFile ?? "-");
    let result: Record<string, unknown>;
    switch (args.command) {
      case "issue-create":
        result = createIssue(args.repo as string, { title: args.title as string, body });
        break;
      case "issue-edit":
        result = editIssueBody(args.repo as string, args.issue as number, { body });
        break;
      case "comment-create":
        result = createIssueComment(args.repo as string, args.issue as number, { body });
        break;
      case "comment-edit":
        result = editIssueCommentBody(args.repo as string, args.comment as number, { body });
        break;
      case "pr-edit":
        result = editPrBody(args.repo as string, args.pr as number, { body });
        break;
      default:
        process.stderr.write(`error: unknown command ${JSON.stringify(args.command)}\n`);
        return 1;
    }
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return 0;
  } catch (exc) {
    process.stderr.write(`error: ${String(exc)}\n`);
    return 1;
  }
}
