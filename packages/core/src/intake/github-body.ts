import { mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { type Finding, renderFinding, scanLine } from "../encoding/scan.js";
import { pythonSplitlines, stripMarkdownQuotes } from "../encoding/text.js";
import { containedWrite } from "../fs/contained-write.js";
import { defaultWhich } from "../scm/binary.js";
import { type CompletedProcess, call } from "../scm/call.js";

export const DEFAULT_TIMEOUT_SECONDS = 60;

/** Stable error code for CP1252/CP437-as-UTF-8 / U+FFFD body corruption (#2960). */
export const SCM_BODY_ENCODING_CODE = "scm-body-encoding";

export class GitHubBodyError extends Error {
  readonly code?: string;

  constructor(message: string, options?: { code?: string }) {
    super(message);
    this.name = "GitHubBodyError";
    this.code = options?.code;
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
    return stripUtf8Bom(stdinText ?? "");
  }
  return stripUtf8Bom(readFileSync(bodyFile, "utf8"));
}

/** Strip a leading UTF-8 BOM so body-file writers stay UTF-8 no BOM (#2960 / #798). */
export function stripUtf8Bom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/**
 * Scan body text with the same mojibake pattern set as verify:encoding
 * (`packages/core/src/encoding/patterns.ts` / scanLine). Issue/PR bodies are
 * Markdown: strip fenced blocks and inline code spans so documented examples
 * of the corruption class (e.g. `#2960` fixtures) are not false positives —
 * matches `scanFile` .md behavior.
 */
export function scanBodyText(body: string, source = "body"): Finding[] {
  const findings: Finding[] = [];
  const scanText = stripMarkdownQuotes(body);
  const originalLines = pythonSplitlines(body);
  const strippedLines = pythonSplitlines(scanText);
  if (originalLines.length === 0 && body.length > 0) {
    findings.push(...scanLine(source, 1, scanText, body));
    return findings;
  }
  // Preserve line alignment when strip blanks fenced blocks (newline-for-newline).
  while (strippedLines.length < originalLines.length) {
    strippedLines.push("");
  }
  originalLines.forEach((orig, idx) => {
    const stripped = strippedLines[idx] ?? "";
    findings.push(...scanLine(source, idx + 1, stripped, orig));
  });
  return findings;
}

function formatEncodingFindings(findings: Finding[]): string {
  return findings.map((f) => renderFinding(f).trim()).join("; ");
}

/**
 * Fail closed when body text already contains CP1252/CP437-as-UTF-8 mojibake
 * or U+FFFD (before PATCH and as a live-body diagnostic).
 */
export function assertBodyEncoding(body: string, phase: string): void {
  const findings = scanBodyText(body, phase);
  if (findings.length === 0) {
    return;
  }
  const detail = formatEncodingFindings(findings);
  throw new GitHubBodyError(
    `body encoding failed (${phase}): ${detail}. Repair: task scm:body:issue:fetch -- --repo OWNER/REPO --issue N --out-file <path>, fix as UTF-8 (no BOM), task scm:body:issue:edit -- --body-file <path> (#2960 / #2948 / #2944).`,
    { code: SCM_BODY_ENCODING_CODE },
  );
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

/** Body may be null on empty GitHub issues/PRs — treat as empty string for lint/fetch. */
function bodyFieldOrEmpty(obj: Record<string, unknown>): string {
  const value = obj.body;
  if (value === null || value === undefined) {
    return "";
  }
  if (typeof value !== "string") {
    throw new GitHubBodyError(`response did not include string field "body"`);
  }
  return value;
}

function countNewlines(text: string): number {
  let count = 0;
  for (const ch of text) {
    if (ch === "\n") count += 1;
  }
  return count;
}

function normalizeNewlines(text: string): string {
  return text.replace(/\r\n/g, "\n");
}

/** Fail closed when live read-back body is flattened or mojibaked vs intended payload (#2607 / #2960). */
export function verifyBodyPostcondition(intended: string, live: string): void {
  if (intended === live) {
    return;
  }
  if (normalizeNewlines(intended) === normalizeNewlines(live)) {
    return;
  }

  const diagnoses: string[] = [];
  if (live.includes("\uFFFD") && !intended.includes("\uFFFD")) {
    diagnoses.push(
      "live body contains U+FFFD replacement character not present in intended payload",
    );
  }

  const liveFindings = scanBodyText(live, "live");
  const intendedFindings = scanBodyText(intended, "intended");
  if (liveFindings.length > 0 && intendedFindings.length === 0) {
    diagnoses.push(
      `live body contains mojibake not present in intended payload (${formatEncodingFindings(liveFindings)})`,
    );
  }

  const intendedNl = countNewlines(intended);
  const liveNl = countNewlines(live);
  if (intendedNl > 0 && liveNl < intendedNl) {
    diagnoses.push(`newline count mismatch (intended ${intendedNl}, live ${liveNl})`);
  }

  if (intended.includes("\n") && intended.replace(/\n/g, " ") === live) {
    diagnoses.push(
      "live body looks like intended newlines were collapsed to spaces (PowerShell string[] join)",
    );
  }

  if (diagnoses.length > 0) {
    const isEncoding = diagnoses.some(
      (d) => d.includes("U+FFFD") || d.includes("mojibake") || d.includes("encoding"),
    );
    throw new GitHubBodyError(`body postcondition failed: ${diagnoses.join("; ")}`, {
      code: isEncoding ? SCM_BODY_ENCODING_CODE : undefined,
    });
  }

  throw new GitHubBodyError(
    `body postcondition failed: re-fetched body does not match intended payload (length intended=${intended.length}, live=${live.length})`,
  );
}

function mutateWithReadback(
  mutationEndpoint: string,
  method: string,
  payload: Record<string, unknown>,
  readbackEndpoint: string | ((response: Record<string, unknown>) => string),
  options: { binary?: string | null; runFn?: RunGhApiFn } = {},
): Record<string, unknown> {
  const intendedBody = typeof payload.body === "string" ? payload.body : undefined;
  if (intendedBody !== undefined) {
    // Fail closed before PATCH when the intended payload is already corrupted (#2960).
    assertBodyEncoding(intendedBody, "pre-write");
  }
  const mutation = runGhApiJson([mutationEndpoint, "--method", method, "--input", "-"], {
    inputText: jsonInput(payload),
    binary: options.binary,
    runFn: options.runFn,
  });
  const endpoint =
    typeof readbackEndpoint === "function" ? readbackEndpoint(mutation) : readbackEndpoint;
  const readback = runGhApiJson([endpoint], { binary: options.binary, runFn: options.runFn });
  if (intendedBody !== undefined) {
    const liveBody = bodyFieldOrEmpty(readback);
    verifyBodyPostcondition(intendedBody, liveBody);
    // Defense in depth: live body must also be free of encoding corruption.
    assertBodyEncoding(liveBody, "post-write-readback");
  }
  return readback;
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

export function fetchIssueBody(
  repo: string,
  issue: number,
  options: { binary?: string | null; runFn?: RunGhApiFn } = {},
): string {
  const [owner, name] = splitRepo(repo);
  const endpoint = `repos/${owner}/${name}/issues/${issue}`;
  const response = runGhApiJson([endpoint], { binary: options.binary, runFn: options.runFn });
  return bodyFieldOrEmpty(response);
}

export function fetchPrBody(
  repo: string,
  pr: number,
  options: { binary?: string | null; runFn?: RunGhApiFn } = {},
): string {
  const [owner, name] = splitRepo(repo);
  const endpoint = `repos/${owner}/${name}/pulls/${pr}`;
  const response = runGhApiJson([endpoint], { binary: options.binary, runFn: options.runFn });
  return bodyFieldOrEmpty(response);
}

export function writeIssueBodyToFile(
  repo: string,
  issue: number,
  outFile: string,
  options: { binary?: string | null; runFn?: RunGhApiFn } = {},
): string {
  const body = fetchIssueBody(repo, issue, options);
  // UTF-8 no BOM (Node default for encoding: "utf8").
  // #2980 wave B: product write sink routes through containedWrite under out-file parent.
  const abs = resolve(outFile);
  const parent = dirname(abs);
  mkdirSync(parent, { recursive: true });
  containedWrite({
    root: parent,
    target: abs,
    data: body,
    mode: "replace",
  });
  return body;
}
/**
 * Lint a live issue body for mojibake. Returns findings (empty = clean).
 * Does not throw on hits — callers decide exit code.
 */
export function lintIssueBody(
  repo: string,
  issue: number,
  options: { binary?: string | null; runFn?: RunGhApiFn } = {},
): Finding[] {
  const body = fetchIssueBody(repo, issue, options);
  return scanBodyText(body, `issue/${issue}`);
}

/**
 * Lint a live PR body for mojibake. Returns findings (empty = clean).
 */
export function lintPrBody(
  repo: string,
  pr: number,
  options: { binary?: string | null; runFn?: RunGhApiFn } = {},
): Finding[] {
  const body = fetchPrBody(repo, pr, options);
  return scanBodyText(body, `pr/${pr}`);
}

export interface GitHubBodyCliArgs {
  command: string;
  repo?: string;
  title?: string;
  issue?: number;
  comment?: number;
  pr?: number;
  bodyFile?: string;
  outFile?: string;
}

function writeLintFailure(kind: string, id: number, findings: Finding[]): void {
  process.stderr.write(
    `error [${SCM_BODY_ENCODING_CODE}]: ${kind} #${id} body contains encoding mojibake (${findings.length} hit(s)):\n`,
  );
  for (const f of findings) {
    process.stderr.write(`${renderFinding(f)}\n`);
  }
  process.stderr.write(
    `Repair: task scm:body:issue:fetch -- --repo OWNER/REPO --issue ${id} --out-file <path>, fix as UTF-8 (no BOM), task scm:body:issue:edit -- --body-file <path>. After non-scm:body mutations, re-run lint (#2960; recurrence #2948/#2944).\n`,
  );
}

export function githubBodyMain(
  args: GitHubBodyCliArgs,
  options: { runFn?: RunGhApiFn; binary?: string | null } = {},
): number {
  try {
    switch (args.command) {
      case "issue-fetch": {
        if (args.repo === undefined || args.issue === undefined || args.outFile === undefined) {
          process.stderr.write("error: issue-fetch requires --repo, --issue, and --out-file\n");
          return 1;
        }
        writeIssueBodyToFile(args.repo, args.issue, args.outFile, {
          runFn: options.runFn,
          binary: options.binary,
        });
        return 0;
      }
      case "issue-lint": {
        if (args.repo === undefined || args.issue === undefined) {
          process.stderr.write("error: issue-lint requires --repo and --issue\n");
          return 1;
        }
        const findings = lintIssueBody(args.repo, args.issue, {
          runFn: options.runFn,
          binary: options.binary,
        });
        if (findings.length > 0) {
          writeLintFailure("issue", args.issue, findings);
          return 1;
        }
        process.stdout.write(
          `ok: issue #${args.issue} body has no CP1252/CP437-as-UTF-8 mojibake\n`,
        );
        return 0;
      }
      case "pr-lint": {
        if (args.repo === undefined || args.pr === undefined) {
          process.stderr.write("error: pr-lint requires --repo and --pr\n");
          return 1;
        }
        const findings = lintPrBody(args.repo, args.pr, {
          runFn: options.runFn,
          binary: options.binary,
        });
        if (findings.length > 0) {
          writeLintFailure("pr", args.pr, findings);
          return 1;
        }
        process.stdout.write(`ok: pr #${args.pr} body has no CP1252/CP437-as-UTF-8 mojibake\n`);
        return 0;
      }
      default: {
        const body = readBody(args.bodyFile ?? "-");
        let result: Record<string, unknown>;
        switch (args.command) {
          case "issue-create":
            result = createIssue(args.repo as string, {
              title: args.title as string,
              body,
              runFn: options.runFn,
              binary: options.binary,
            });
            break;
          case "issue-edit":
            result = editIssueBody(args.repo as string, args.issue as number, {
              body,
              runFn: options.runFn,
              binary: options.binary,
            });
            break;
          case "comment-create":
            result = createIssueComment(args.repo as string, args.issue as number, {
              body,
              runFn: options.runFn,
              binary: options.binary,
            });
            break;
          case "comment-edit":
            result = editIssueCommentBody(args.repo as string, args.comment as number, {
              body,
              runFn: options.runFn,
              binary: options.binary,
            });
            break;
          case "pr-edit":
            result = editPrBody(args.repo as string, args.pr as number, {
              body,
              runFn: options.runFn,
              binary: options.binary,
            });
            break;
          default:
            process.stderr.write(`error: unknown command ${JSON.stringify(args.command)}\n`);
            return 1;
        }
        process.stdout.write(`${JSON.stringify(result)}\n`);
        return 0;
      }
    }
  } catch (exc) {
    if (exc instanceof GitHubBodyError && exc.code !== undefined) {
      process.stderr.write(`error [${exc.code}]: ${exc.message}\n`);
    } else {
      process.stderr.write(`error: ${String(exc)}\n`);
    }
    return 1;
  }
}
