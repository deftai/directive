#!/usr/bin/env node
/**
 * Nightly lane reporter (#6849).
 *
 * Runs in the `report` job of .github/workflows/nightly.yml after both lanes.
 * It classifies each lane from the job and step results, then keeps ONE
 * durable tracking issue per lane, found by a hidden body marker among issues
 * opened by github-actions[bot], open or closed:
 *
 * - red lane: create the issue once, or reopen it, and comment with the lane,
 *   the outcome class, the SHA, the run id and attempt, the run URL, the
 *   failing test files and (coverage lane) the four coverage totals. A value
 *   the run did not produce is written as unknown, never as zero.
 * - passed lane: comment on an open issue and close it.
 *
 * A comment for the same lane, run id and attempt is never posted twice. The
 * issue is assigned to the login in the NIGHTLY_OWNER repository variable;
 * when it is unset the run summary says no one was assigned. Bodies go to gh
 * through --body-file, never through a shell command line.
 *
 * Env: NEEDS_JSON, REPO, RUN_ID, RUN_ATTEMPT, HEAD_SHA, SERVER_URL,
 * NIGHTLY_OWNER, ARTIFACT_DIR, GITHUB_WORKSPACE, GITHUB_STEP_SUMMARY,
 * RUNNER_TEMP, GH_TOKEN (via gh).
 */

import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

/** Login the tracking issues are opened by. */
export const ISSUE_CREATOR = "github-actions[bot]";

/** The two lanes: workflow job id, job name, artifact name. */
export const LANES = [
  {
    id: "coverage",
    job: "coverage",
    name: "Nightly coverage (Linux)",
    artifact: "nightly-coverage",
    coverage: true,
  },
  {
    id: "windows",
    job: "windows",
    name: "Nightly full suite (Windows)",
    artifact: "nightly-windows",
    coverage: false,
  },
];

/** Outcome classes. */
export const OUTCOMES = [
  "passed",
  "test-failure",
  "setup-failure",
  "timed-out-or-cancelled",
  "report-unavailable",
];

/** @param {string} laneId */
export function issueMarker(laneId) {
  return `<!-- deft-nightly-lane: ${laneId} -->`;
}

/**
 * @param {string} laneId
 * @param {string} runId
 * @param {string} attempt
 */
export function commentMarker(laneId, runId, attempt) {
  return `<!-- deft-nightly-run: ${laneId} ${runId} ${attempt} -->`;
}

/** @param {{ name: string }} lane */
export function issueTitle(lane) {
  return `Nightly lane red: ${lane.name}`;
}

/**
 * Classify one lane from its `needs` entry and whether its test report parsed.
 *
 * @param {{ result?: string, outputs?: Record<string, string> } | undefined} need
 * @param {boolean} reportPresent
 * @returns {string}
 */
export function classifyLane(need, reportPresent) {
  if (need === undefined || need === null) return "report-unavailable";
  const result = need.result ?? "";
  const outputs = need.outputs ?? {};
  if (result === "success") return "passed";
  if (result === "cancelled") return "timed-out-or-cancelled";
  if (result !== "failure") return "report-unavailable";
  if (outputs.setup !== "ok") return "setup-failure";
  const tests = outputs.tests ?? "";
  if (tests === "failure") return reportPresent ? "test-failure" : "report-unavailable";
  if (tests === "" || tests === "cancelled") return "timed-out-or-cancelled";
  return "report-unavailable";
}

/**
 * Failing test files (and their failing tests) from a vitest JSON report.
 * Null when the report is absent or unreadable.
 *
 * @param {string | null} text
 * @param {string} [workspace]
 * @returns {{ file: string, tests: string[] }[] | null}
 */
export function parseVitestReport(text, workspace = "") {
  if (text === null) return null;
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    return null;
  }
  if (data === null || typeof data !== "object" || !Array.isArray(data.testResults)) return null;
  const prefix = workspace.replaceAll("\\", "/").replace(/\/?$/, "/");
  const failed = [];
  for (const result of data.testResults) {
    if (result === null || typeof result !== "object") continue;
    const assertions = Array.isArray(result.assertionResults) ? result.assertionResults : [];
    const tests = assertions
      .filter((a) => a !== null && typeof a === "object" && a.status === "failed")
      .map((a) => String(a.fullName ?? a.title ?? "(unnamed test)"));
    if (result.status !== "failed" && tests.length === 0) continue;
    let file = String(result.name ?? "(unknown file)").replaceAll("\\", "/");
    if (prefix !== "/" && file.startsWith(prefix)) file = file.slice(prefix.length);
    failed.push({ file, tests });
  }
  return failed;
}

/**
 * The four coverage totals from coverage-summary.json. A missing total is null.
 *
 * @param {string | null} text
 * @returns {{ lines: number | null, statements: number | null, functions: number | null, branches: number | null }}
 */
export function parseCoverageTotals(text) {
  const totals = { lines: null, statements: null, functions: null, branches: null };
  if (text === null) return totals;
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    return totals;
  }
  const total = data !== null && typeof data === "object" ? data.total : null;
  if (total === null || typeof total !== "object") return totals;
  for (const key of Object.keys(totals)) {
    const pct = total[key]?.pct;
    if (typeof pct === "number" && Number.isFinite(pct)) totals[key] = pct;
  }
  return totals;
}

/** @param {number | null} value */
function pctText(value) {
  return value === null ? "unknown" : `${value}%`;
}

/**
 * Comment body for one lane of one run.
 *
 * @param {{
 *   lane: { id: string, name: string, coverage: boolean },
 *   outcome: string,
 *   sha: string,
 *   runId: string,
 *   attempt: string,
 *   runUrl: string,
 *   failing: { file: string, tests: string[] }[] | null,
 *   totals: ReturnType<typeof parseCoverageTotals> | null,
 * }} input
 */
export function buildComment(input) {
  const { lane, outcome, sha, runId, attempt, runUrl, failing, totals } = input;
  const lines = [
    commentMarker(lane.id, runId, attempt),
    `**${lane.name}**: ${outcome}`,
    "",
    `- SHA: ${sha || "unknown"}`,
    `- Run: ${runId || "unknown"} attempt ${attempt || "unknown"}`,
    `- Run URL: ${runUrl || "unknown"}`,
  ];
  if (outcome !== "passed") {
    if (failing === null) {
      lines.push("- Failing test files: unknown (no test report)");
    } else if (failing.length === 0) {
      lines.push("- Failing test files: none (the test step failed for another reason)");
    } else {
      lines.push(`- Failing test files (${failing.length}):`);
      for (const entry of failing) {
        lines.push(`  - \`${entry.file}\``);
        for (const test of entry.tests.slice(0, 10)) lines.push(`    - ${test}`);
        if (entry.tests.length > 10) lines.push(`    - and ${entry.tests.length - 10} more`);
      }
    }
  }
  if (lane.coverage) {
    const t = totals ?? parseCoverageTotals(null);
    lines.push(
      `- Coverage totals: lines ${pctText(t.lines)}, statements ${pctText(t.statements)}, ` +
        `functions ${pctText(t.functions)}, branches ${pctText(t.branches)}`,
    );
  }
  let body = `${lines.join("\n")}\n`;
  // GitHub caps a comment at 65536 characters.
  if (body.length > 60000) body = `${body.slice(0, 60000)}\n\n(truncated)\n`;
  return body;
}

/** @param {{ id: string, name: string }} lane */
export function issueBody(lane) {
  return (
    `${issueMarker(lane.id)}\n` +
    `This issue tracks the **${lane.name}** lane of the nightly workflow ` +
    "(`.github/workflows/nightly.yml`). The workflow reopens it and comments when the lane is red, " +
    "and comments and closes it when the lane passes. Release readiness reuses a lane only when its " +
    "latest attempt succeeded on the release tree (docs/RELEASING.md).\n"
  );
}

/**
 * @param {unknown} parsed
 * @returns {Record<string, unknown>[]}
 */
function flattenPages(parsed) {
  if (!Array.isArray(parsed)) return [];
  return parsed.flatMap((page) => (Array.isArray(page) ? page : [page]));
}

/**
 * Default gh runner: argv only, no shell.
 *
 * @param {string[]} args
 * @returns {string}
 */
export function runGh(args) {
  // Issue and comment listings grow with each red night; the default 1 MiB
  // output cap would fail the report on a long-lived tracking issue.
  return execFileSync("gh", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 256 * 1024 * 1024,
  });
}

/**
 * The lane's tracking issue: marker in the body, opened by ISSUE_CREATOR,
 * open or closed. The oldest one wins if several exist.
 *
 * @param {(args: string[]) => string} gh
 * @param {string} repo
 * @param {string} laneId
 */
export function findTrackingIssue(gh, repo, laneId) {
  const out = gh([
    "api",
    "--paginate",
    "--slurp",
    `repos/${repo}/issues?state=all&creator=${encodeURIComponent(ISSUE_CREATOR)}&per_page=100`,
  ]);
  const marker = issueMarker(laneId);
  const issues = flattenPages(JSON.parse(out)).filter(
    (issue) =>
      issue !== null &&
      typeof issue === "object" &&
      issue.pull_request === undefined &&
      typeof issue.body === "string" &&
      issue.body.includes(marker),
  );
  issues.sort((a, b) => Number(a.number) - Number(b.number));
  const found = issues[0];
  if (found === undefined) return null;
  return {
    number: Number(found.number),
    state: String(found.state),
    assignees: Array.isArray(found.assignees)
      ? found.assignees.map((a) => String(a?.login ?? ""))
      : [],
  };
}

/**
 * The runs already reported on the issue for this lane, from the comment markers.
 *
 * @param {(args: string[]) => string} gh
 * @param {string} repo
 * @param {number} number
 * @param {string} laneId
 * @returns {{ runId: number, attempt: number }[]}
 */
export function reportedRuns(gh, repo, number, laneId) {
  const out = gh(["api", "--paginate", "--slurp", `repos/${repo}/issues/${number}/comments?per_page=100`]);
  const pattern = new RegExp(`<!-- deft-nightly-run: ${laneId} (\\d+) (\\d+) -->`, "g");
  const runs = [];
  for (const c of flattenPages(JSON.parse(out))) {
    if (c === null || typeof c !== "object" || typeof c.body !== "string") continue;
    // Only the reporter's own comments count; anyone else could forge a marker.
    if (c.user?.login !== ISSUE_CREATOR) continue;
    for (const m of c.body.matchAll(pattern)) {
      runs.push({ runId: Number(m[1]), attempt: Number(m[2]) });
    }
  }
  return runs;
}

/**
 * @param {{ runId: number, attempt: number }[]} runs
 * @param {string} runId
 * @param {string} attempt
 */
function runState(runs, runId, attempt) {
  const id = Number(runId);
  return {
    already: runs.some((r) => r.runId === id && r.attempt === Number(attempt)),
    // A rerun of an older nightly must not undo what a newer run reported.
    newer: Number.isFinite(id) && runs.some((r) => r.runId > id),
  };
}

/**
 * Report one lane. Returns a summary line.
 *
 * @param {{
 *   gh: (args: string[]) => string,
 *   writeBody: (name: string, text: string) => string,
 *   repo: string,
 *   owner: string,
 *   lane: { id: string, name: string, coverage: boolean },
 *   outcome: string,
 *   comment: string,
 *   runId: string,
 *   attempt: string,
 * }} input
 */
export function reportLane(input) {
  const { gh, writeBody, repo, owner, lane, outcome, comment, runId, attempt } = input;
  let issue = findTrackingIssue(gh, repo, lane.id);
  const post = (number) => {
    const file = writeBody(`${lane.id}-comment.md`, comment);
    gh(["issue", "comment", String(number), "--repo", repo, "--body-file", file]);
  };
  const seen =
    issue === null
      ? { already: false, newer: false }
      : runState(reportedRuns(gh, repo, issue.number, lane.id), runId, attempt);
  if (issue !== null && seen.newer) {
    if (!seen.already) post(issue.number);
    return `${lane.name}: ${outcome}; a newer run already reported on #${issue.number}; state left as is`;
  }
  if (outcome === "passed") {
    if (issue === null || issue.state !== "open") {
      return `${lane.name}: passed; no open tracking issue`;
    }
    if (!seen.already) post(issue.number);
    gh(["issue", "close", String(issue.number), "--repo", repo]);
    return `${lane.name}: passed; commented on and closed #${issue.number}`;
  }
  let action;
  if (issue === null) {
    const file = writeBody(`${lane.id}-issue.md`, issueBody(lane));
    const args = ["issue", "create", "--repo", repo, "--title", issueTitle(lane), "--body-file", file];
    if (owner !== "") args.push("--assignee", owner);
    const url = gh(args).trim();
    const match = /\/issues\/(\d+)\s*$/.exec(url);
    if (match === null) throw new Error(`gh issue create returned no issue URL: ${url}`);
    issue = { number: Number(match[1]), state: "open", assignees: owner === "" ? [] : [owner] };
    action = `created #${issue.number}`;
  } else if (issue.state !== "open") {
    gh(["issue", "reopen", String(issue.number), "--repo", repo]);
    action = `reopened #${issue.number}`;
  } else {
    action = `updated #${issue.number}`;
  }
  if (owner !== "" && !issue.assignees.includes(owner)) {
    gh(["issue", "edit", String(issue.number), "--repo", repo, "--add-assignee", owner]);
  }
  if (seen.already) {
    return `${lane.name}: ${outcome}; ${action}; this run was already reported`;
  }
  post(issue.number);
  return `${lane.name}: ${outcome}; ${action}`;
}

/** @param {string} path */
function readIfPresent(path) {
  return existsSync(path) ? readFileSync(path, "utf8") : null;
}

/**
 * Report both lanes.
 *
 * @param {Record<string, string | undefined>} env
 * @param {{ gh?: (args: string[]) => string, readFile?: (path: string) => string | null, writeBody?: (name: string, text: string) => string, summary?: (text: string) => void }} [deps]
 * @returns {string[]} summary lines
 */
export function runReport(env, deps = {}) {
  const gh = deps.gh ?? runGh;
  const readFile = deps.readFile ?? readIfPresent;
  const bodyDir = deps.writeBody ? "" : mkdtempSync(join(env.RUNNER_TEMP || tmpdir(), "nightly-report-"));
  const writeBody =
    deps.writeBody ??
    ((name, text) => {
      const file = join(bodyDir, name);
      writeFileSync(file, text, "utf8");
      return file;
    });
  const repo = env.REPO ?? "";
  if (repo === "") throw new Error("REPO is not set");
  const runId = env.RUN_ID ?? "";
  const attempt = env.RUN_ATTEMPT ?? "";
  const sha = env.HEAD_SHA ?? "";
  const owner = (env.NIGHTLY_OWNER ?? "").trim();
  const runUrl = runId !== "" ? `${env.SERVER_URL || "https://github.com"}/${repo}/actions/runs/${runId}/attempts/${attempt || "1"}` : "";
  const artifactDir = env.ARTIFACT_DIR ?? "nightly-artifacts";
  const workspace = env.GITHUB_WORKSPACE ?? "";
  let needs;
  try {
    needs = JSON.parse(env.NEEDS_JSON ?? "") ?? {};
  } catch (err) {
    throw new Error(`NEEDS_JSON is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  // upload-artifact roots an artifact at the common folder of the files it
  // found, so a file sits either under its folder or at the artifact root.
  const readArtifact = (artifact, folder, name) =>
    readFile(join(artifactDir, artifact, folder, name)) ?? readFile(join(artifactDir, artifact, name));
  const summary = [];
  for (const lane of LANES) {
    const failing = parseVitestReport(
      readArtifact(lane.artifact, "nightly-report", "vitest.json"),
      workspace,
    );
    const totals = lane.coverage
      ? parseCoverageTotals(readArtifact(lane.artifact, "coverage", "coverage-summary.json"))
      : null;
    const outcome = classifyLane(needs[lane.job], failing !== null);
    const comment = buildComment({ lane, outcome, sha, runId, attempt, runUrl, failing, totals });
    summary.push(
      reportLane({ gh, writeBody, repo, owner, lane, outcome, comment, runId, attempt }),
    );
  }
  summary.push(
    owner === ""
      ? "NIGHTLY_OWNER is not set: no one was assigned to the nightly tracking issues."
      : `Nightly tracking issues are assigned to ${owner}.`,
  );
  const text = `## Nightly lanes\n\n${summary.map((line) => `- ${line}`).join("\n")}\n`;
  if (deps.summary) deps.summary(text);
  else if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, text);
  return summary;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    for (const line of runReport(process.env)) console.log(line);
  } catch (err) {
    console.error(`nightly-report: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  }
}
