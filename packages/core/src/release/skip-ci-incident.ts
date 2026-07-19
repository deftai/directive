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
/** Set by `task release:e2e` worker subprocesses — permits `--skip-ci` without issue citation. */
export const RELEASE_E2E_ENV = "DEFT_RELEASE_E2E";

export function parseSkipCiIncidentArgv(argv: readonly string[]): SkipCiIncidentResolution {
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i] ?? "";
    if (token === SKIP_CI_FLAG) {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("-")) {
        return { kind: "invalid", reason: `${SKIP_CI_FLAG} requires an issue number (#N)` };
      }
      const issue = parseSkipCiIncidentIssueNumber(next);
      return issue === null
        ? { kind: "invalid", reason: `${SKIP_CI_FLAG} value must be #N or N` }
        : { kind: "valid", issue };
    }
    if (token.startsWith(`${SKIP_CI_FLAG}=`)) {
      const value = token.slice(SKIP_CI_FLAG.length + 1);
      const issue = parseSkipCiIncidentIssueNumber(value);
      return issue === null
        ? { kind: "invalid", reason: `${SKIP_CI_FLAG}= value must be #N or N` }
        : { kind: "valid", issue };
    }
  }
  return { kind: "none" };
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
