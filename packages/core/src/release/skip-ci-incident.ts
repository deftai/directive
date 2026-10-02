/** Parse `#2652`, `2652`, or bare numeric strings for skip-ci incident citation. */
export function parseSkipCiIncidentIssueNumber(raw: string): number | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const normalized = trimmed.startsWith("#") ? trimmed.slice(1) : trimmed;
  if (!/^\d+$/.test(normalized)) return null;
  const issue = Number.parseInt(normalized, 10);
  return Number.isFinite(issue) && issue > 0 ? issue : null;
}

export type SkipCiIncidentResolution =
  | { readonly kind: "none" }
  | { readonly kind: "valid"; readonly issue: number }
  | { readonly kind: "invalid"; readonly reason: string };

const SKIP_CI_FLAG = "--allow-skip-ci";
/** Distinct override for unpaid skip-ci citations (#5239 R3 + S1). */
export const ALLOW_UNPAID_SKIP_CI_FLAG = "--allow-unpaid-skip-ci";
/** Set by `task release:e2e` worker subprocesses — permits `--skip-ci` without issue citation. */
export const RELEASE_E2E_ENV = "DEFT_RELEASE_E2E";

function parseIssueFlag(argv: readonly string[], flag: string): SkipCiIncidentResolution {
  // Scan every occurrence so a later malformed duplicate cannot be masked by
  // an earlier valid token (SLizard P1 on #5239).
  let firstValid: number | null = null;
  let sawAny = false;
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i] ?? "";
    if (token === flag) {
      sawAny = true;
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("-")) {
        return { kind: "invalid", reason: `${flag} requires an issue number (#N)` };
      }
      const issue = parseSkipCiIncidentIssueNumber(next);
      if (issue === null) {
        return { kind: "invalid", reason: `${flag} value must be #N or N` };
      }
      if (firstValid !== null && firstValid !== issue) {
        return {
          kind: "invalid",
          reason: `${flag} has conflicting issue numbers (#${firstValid} vs #${issue})`,
        };
      }
      firstValid = issue;
      i += 1;
      continue;
    }
    if (token.startsWith(`${flag}=`)) {
      sawAny = true;
      const value = token.slice(flag.length + 1);
      const issue = parseSkipCiIncidentIssueNumber(value);
      if (issue === null) {
        return { kind: "invalid", reason: `${flag}= value must be #N or N` };
      }
      if (firstValid !== null && firstValid !== issue) {
        return {
          kind: "invalid",
          reason: `${flag} has conflicting issue numbers (#${firstValid} vs #${issue})`,
        };
      }
      firstValid = issue;
    }
  }
  if (!sawAny || firstValid === null) {
    return { kind: "none" };
  }
  return { kind: "valid", issue: firstValid };
}

export function parseSkipCiIncidentArgv(argv: readonly string[]): SkipCiIncidentResolution {
  return parseIssueFlag(argv, SKIP_CI_FLAG);
}

export function parseAllowUnpaidSkipCiArgv(argv: readonly string[]): SkipCiIncidentResolution {
  return parseIssueFlag(argv, ALLOW_UNPAID_SKIP_CI_FLAG);
}

/**
 * Production `--skip-ci` is an incident (#2652): require `--allow-skip-ci=#N` or
 * run inside `task release:e2e` (`DEFT_RELEASE_E2E=1`).
 */
export function validateSkipCiIncident(
  skipCi: boolean,
  allowSkipCiIssue: number | null,
  env: NodeJS.ProcessEnv = process.env,
): SkipCiIncidentResolution {
  if (!skipCi) {
    return { kind: "none" };
  }
  if (allowSkipCiIssue !== null) {
    return { kind: "valid", issue: allowSkipCiIssue };
  }
  if (env[RELEASE_E2E_ENV] === "1") {
    return { kind: "valid", issue: 0 };
  }
  return {
    kind: "invalid",
    reason:
      "production --skip-ci skips Step 5 vitest coverage and ships untested npm builds (#2652). " +
      "Pass --allow-skip-ci=#N citing the tracked incident after operator review, " +
      "or use `task release:e2e` for rehearsal-only skips.",
  };
}

export type SkipCiUnpaidLedgerGate =
  | { readonly kind: "ok" }
  | { readonly kind: "invalid"; readonly reason: string };

/**
 * Refuse unpaid `--allow-skip-ci=#N` citations (#5239 R3 + S1).
 * OPEN/UNKNOWN issue state or a prior CHANGELOG spend marker counts as unpaid
 * unless `--allow-unpaid-skip-ci=#N` matches the same issue.
 */
export function validateSkipCiUnpaidLedger(options: {
  readonly skipCi: boolean;
  readonly allowSkipCiIssue: number | null;
  readonly allowUnpaidSkipCiIssue: number | null;
  readonly unpaidIssues: readonly {
    readonly issue: number;
    readonly reasons: readonly string[];
  }[];
}): SkipCiUnpaidLedgerGate {
  if (!options.skipCi || options.allowSkipCiIssue === null || options.allowSkipCiIssue <= 0) {
    return { kind: "ok" };
  }
  const unpaid = options.unpaidIssues.filter((e) => e.issue === options.allowSkipCiIssue);
  if (unpaid.length === 0) return { kind: "ok" };
  if (
    options.allowUnpaidSkipCiIssue !== null &&
    options.allowUnpaidSkipCiIssue === options.allowSkipCiIssue
  ) {
    return { kind: "ok" };
  }
  const reasons = unpaid.flatMap((e) => e.reasons);
  const detail = reasons.includes("changelog_spent")
    ? "CHANGELOG already records this incident as spent on a prior production cut"
    : "cited incident is OPEN or UNKNOWN";
  return {
    kind: "invalid",
    reason:
      `production --allow-skip-ci=#${options.allowSkipCiIssue} is unpaid (${detail}). ` +
      `Pass --allow-unpaid-skip-ci=#${options.allowSkipCiIssue} for a distinct explicit override, ` +
      `or cut with a green Step 5 (no --skip-ci) (#5239).`,
  };
}

/** Loud stderr banner when Step 5 is skipped with operator acknowledgment (#2652). */
export function formatSkipCiIncidentWarning(issue: number): string {
  const cite = issue > 0 ? `#${issue}` : "release:e2e rehearsal";
  return (
    `\n` +
    `*** WARNING: release Step 5 CI/coverage SKIPPED (--skip-ci) ***\n` +
    `*** This cut will NOT be validated by vitest coverage / task check. ***\n` +
    `*** Incident citation: ${cite} — npm publish proceeds UNTESTED (#2652). ***\n` +
    `*** Next production patch MUST cut without --skip-ci once the hang is fixed. ***\n\n`
  );
}
