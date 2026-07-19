import { parseCoverageDebtIssueNumber } from "../vitest-runner/coverage-debt.js";
import { DEFAULT_BASE_BRANCH, RELEASE_HELP } from "./constants.js";
import { parseSkipCiIncidentArgv } from "./skip-ci-incident.js";
import type { ReleaseFlags } from "./types.js";

export function parseReleaseFlags(args: readonly string[]): ReleaseFlags {
  let help = false;
  let dryRun = false;
  let skipTag = false;
  let skipRelease = false;
  let allowDirty = false;
  let allowVbriefDrift = false;
  let allowCoverageDebtIssue: number | null = null;
  const skipCiIncident = parseSkipCiIncidentArgv(args);
  const allowSkipCiIssue: number | null =
    skipCiIncident.kind === "valid" ? skipCiIncident.issue : null;
  let skipCi = false;
  let skipBuild = false;
  let draft = true;
  let repo: string | null = null;
  let baseBranch = DEFAULT_BASE_BRANCH;
  let projectRoot: string | null = null;
  let summary: string | null = null;
  let version: string | null = null;
  const unknown: string[] = [];

  const takeValue = (flag: string, i: number): string | null => {
    if (i + 1 >= args.length) {
      unknown.push(`${flag} (missing value)`);
      return null;
    }
    return args[i + 1] ?? null;
  };

  let i = 0;
  while (i < args.length) {
    const token = args[i] ?? "";
    if (token === "-h" || token === "--help") {
      help = true;
    } else if (token === "--dry-run") {
      dryRun = true;
    } else if (token === "--skip-tag") {
      skipTag = true;
    } else if (token === "--skip-release") {
      skipRelease = true;
    } else if (token === "--allow-dirty") {
      allowDirty = true;
    } else if (token === "--allow-vbrief-drift") {
      allowVbriefDrift = true;
    } else if (token === "--allow-coverage-debt") {
      const value = takeValue(token, i);
      if (value !== null) {
        const issue = parseCoverageDebtIssueNumber(value);
        if (issue === null) {
          unknown.push(`${token} (malformed issue number)`);
        } else {
          allowCoverageDebtIssue = issue;
        }
        i += 1;
      }
    } else if (token.startsWith("--allow-coverage-debt=")) {
      const value = token.slice("--allow-coverage-debt=".length);
      const issue = parseCoverageDebtIssueNumber(value);
      if (issue === null) {
        unknown.push("--allow-coverage-debt= (malformed issue number)");
      } else {
        allowCoverageDebtIssue = issue;
      }
    } else if (token === "--skip-ci") {
      skipCi = true;
    } else if (token === "--allow-skip-ci") {
      // Value consumed by parseSkipCiIncidentArgv above; advance past it here.
      const value = takeValue(token, i);
      if (value !== null) i += 1;
    } else if (token.startsWith("--allow-skip-ci=")) {
      // Value consumed by parseSkipCiIncidentArgv above.
    } else if (token === "--skip-build") {
      skipBuild = true;
    } else if (token === "--no-draft") {
      draft = false;
    } else if (token === "--repo") {
      repo = takeValue(token, i);
      if (repo !== null) i += 1;
    } else if (token.startsWith("--repo=")) {
      repo = token.slice("--repo=".length) || null;
      if (!repo) unknown.push("--repo= (empty value)");
    } else if (token === "--base-branch") {
      const v = takeValue(token, i);
      if (v !== null) {
        baseBranch = v;
        i += 1;
      }
    } else if (token.startsWith("--base-branch=")) {
      const v = token.slice("--base-branch=".length);
      if (v) baseBranch = v;
      else unknown.push("--base-branch= (empty value)");
    } else if (token === "--project-root") {
      projectRoot = takeValue(token, i);
      if (projectRoot !== null) i += 1;
    } else if (token.startsWith("--project-root=")) {
      projectRoot = token.slice("--project-root=".length) || null;
      if (!projectRoot) unknown.push("--project-root= (empty value)");
    } else if (token === "--summary") {
      summary = takeValue(token, i);
      if (summary !== null) i += 1;
    } else if (token.startsWith("--summary=")) {
      summary = token.slice("--summary=".length) || null;
      if (!summary) unknown.push("--summary= (empty value)");
    } else if (token.startsWith("-")) {
      unknown.push(token);
    } else if (version === null) {
      version = token;
    } else {
      unknown.push(token);
    }
    i += 1;
  }

  if (skipCiIncident.kind === "invalid") {
    unknown.push(`--allow-skip-ci (${skipCiIncident.reason})`);
  }

  return {
    help,
    version,
    repo,
    baseBranch,
    projectRoot,
    dryRun,
    skipTag,
    skipRelease,
    allowDirty,
    allowVbriefDrift,
    allowCoverageDebtIssue,
    allowSkipCiIssue,
    skipCi,
    skipBuild,
    draft,
    summary,
    unknown,
  };
}

export function formatReleaseHelp(): string {
  return RELEASE_HELP;
}
