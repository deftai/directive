import { existsSync, readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  defaultRunGh,
  fetchGreptileCommentBody,
  fetchPrHeadSha,
} from "../pr-merge-readiness/gh.js";
import { evaluateGates, parseGreptileBody } from "../pr-merge-readiness/index.js";
import type { RunGhFn } from "../pr-merge-readiness/types.js";
import { EXIT_EXTERNAL_ERROR, EXIT_OK, EXIT_UNCLEAN } from "./constants.js";

export interface CohortResolutionError {
  vbrief_path: string;
  reason: string;
}

export interface CohortPRResult {
  pr_number: number;
  head_sha: string | null;
  verdict: Record<string, unknown>;
  failures: string[];
  clean: boolean;
}

export interface CohortResult {
  repo: string | null;
  pr_results: CohortPRResult[];
  resolution_errors: CohortResolutionError[];
  all_clean: boolean;
}

function extractPrFromUri(uri: string): number | null {
  const pullIdx = uri.indexOf("/pull/");
  if (pullIdx < 0) {
    return null;
  }
  let i = pullIdx + "/pull/".length;
  const digits: string[] = [];
  while (i < uri.length) {
    const ch = uri.charAt(i);
    if (ch >= "0" && ch <= "9") {
      digits.push(ch);
      i += 1;
    } else {
      break;
    }
  }
  if (digits.length === 0) {
    return null;
  }
  return Number.parseInt(digits.join(""), 10);
}

function globPaths(pattern: string): string[] {
  if (pattern.includes("*")) {
    const slash = pattern.lastIndexOf("/");
    const dir = slash >= 0 ? pattern.slice(0, slash) : ".";
    const glob = slash >= 0 ? pattern.slice(slash + 1) : pattern;
    if (!existsSync(dir)) {
      return [];
    }
    return readdirSync(dir)
      .filter((name) => (glob === "*.vbrief.json" ? name.endsWith(".vbrief.json") : name === glob))
      .map((name) => resolve(dir, name));
  }
  return [resolve(pattern)];
}

export function resolveCohortFromVbriefs(vbriefGlobs: readonly string[]): {
  prNumbers: number[];
  failures: CohortResolutionError[];
} {
  const seenPrs: number[] = [];
  const seenSet = new Set<number>();
  const failures: CohortResolutionError[] = [];
  const paths: string[] = [];

  for (const pattern of vbriefGlobs) {
    const matched = globPaths(pattern).sort();
    if (matched.length === 0) {
      failures.push({
        vbrief_path: pattern,
        reason: `glob matched no files: ${JSON.stringify(pattern)}`,
      });
      continue;
    }
    paths.push(...matched);
  }

  for (const path of paths) {
    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    } catch (exc: unknown) {
      failures.push({ vbrief_path: path, reason: `unreadable: ${String(exc)}` });
      continue;
    }
    const plan = payload.plan;
    const references =
      typeof plan === "object" && plan !== null && !Array.isArray(plan)
        ? ((plan as Record<string, unknown>).references as unknown)
        : [];
    const refs = Array.isArray(references) ? references : [];
    const prNumbersInFile: number[] = [];
    for (const ref of refs) {
      if (typeof ref !== "object" || ref === null || Array.isArray(ref)) {
        continue;
      }
      const uri = (ref as Record<string, unknown>).uri;
      if (typeof uri !== "string" || uri.length === 0) {
        continue;
      }
      const pr = extractPrFromUri(uri);
      if (pr !== null) {
        prNumbersInFile.push(pr);
      }
    }
    if (prNumbersInFile.length === 0) {
      failures.push({
        vbrief_path: path,
        reason: "no x-vbrief/github-pr-style references found",
      });
      continue;
    }
    for (const prNum of prNumbersInFile) {
      if (seenSet.has(prNum)) {
        continue;
      }
      seenSet.add(prNum);
      seenPrs.push(prNum);
    }
  }

  return { prNumbers: seenPrs, failures };
}

export function evaluatePr(
  prNumber: number,
  repo: string | null,
  runGh: RunGhFn = defaultRunGh,
): CohortPRResult | null {
  const headSha = fetchPrHeadSha(prNumber, repo, runGh);
  if (headSha === null) {
    return null;
  }
  const body = fetchGreptileCommentBody(prNumber, repo, runGh);
  if (body === null) {
    return null;
  }
  const verdict = parseGreptileBody(body);
  const failures = evaluateGates(prNumber, headSha, verdict);
  return {
    pr_number: prNumber,
    head_sha: headSha,
    verdict: { ...verdict },
    failures: [...failures],
    clean: failures.length === 0,
  };
}

export function cohortResultToDict(cohort: CohortResult): Record<string, unknown> {
  return {
    repo: cohort.repo,
    all_clean: cohort.all_clean,
    pr_count: cohort.pr_results.length,
    pr_results: cohort.pr_results.map((r) => ({
      pr_number: r.pr_number,
      head_sha: r.head_sha,
      clean: r.clean,
      verdict: r.verdict,
      failures: r.failures,
    })),
    resolution_errors: cohort.resolution_errors,
  };
}

export function renderReviewCleanText(cohort: CohortResult): string {
  const n = cohort.pr_results.length;
  const lines: string[] = [`Swarm cohort CLEAN verification (${n} PR${n === 1 ? "" : "s"})`];
  if (cohort.repo) {
    lines.push(`  Repo: ${cohort.repo}`);
  }
  if (cohort.resolution_errors.length > 0) {
    lines.push("  Resolution errors:");
    for (const err of cohort.resolution_errors) {
      lines.push(`    [${err.vbrief_path}] ${err.reason}`);
    }
  }
  for (const r of cohort.pr_results) {
    const status = r.clean ? "CLEAN" : "UNCLEAN";
    const v = r.verdict;
    lines.push("");
    lines.push(`  PR #${r.pr_number} -- ${status}`);
    lines.push(`    HEAD SHA:           ${r.head_sha ?? "<unknown>"}`);
    lines.push(`    Greptile reviewed:  ${String(v.lastReviewedSha ?? "<not parsed>")}`);
    const conf = v.confidence;
    lines.push(
      `    Confidence:         ${conf === null || conf === undefined ? "<not parsed>" : String(conf)}/5`,
    );
    lines.push(
      `    Findings:           P0=${String(v.p0Count ?? 0)}  ` +
        `P1=${String(v.p1Count ?? 0)}  P2=${String(v.p2Count ?? 0)}`,
    );
    lines.push(`    Errored sentinel:   ${v.errored === true ? "True" : "False"}`);
    r.failures.forEach((fail, index) => {
      lines.push(`      [${index + 1}] ${fail}`);
    });
  }
  lines.push("");
  if (cohort.all_clean) {
    lines.push("Result: COHORT CLEAN -- Phase 5 -> 6 merge discussion may proceed");
  } else {
    const nUnclean = cohort.pr_results.filter((r) => !r.clean).length;
    lines.push(
      `Result: COHORT BLOCKED -- ${nUnclean}/${n} PR(s) unclean. ` +
        "Do NOT raise the Phase 5 -> 6 gate; re-dispatch pollers or " +
        "address findings, then re-run task swarm:verify-review-clean.",
    );
  }
  return lines.join("\n");
}

export interface VerifyReviewCleanArgs {
  prNumbers?: readonly number[];
  cohortGlobs?: readonly string[];
  repo?: string | null;
  emitJson?: boolean;
  runGh?: RunGhFn;
}

export function verifyReviewClean(args: VerifyReviewCleanArgs): {
  exitCode: number;
  stdout: string;
  stderr: string;
} {
  const prNumbers = [...new Set(args.prNumbers ?? [])];
  const resolutionErrors: CohortResolutionError[] = [];
  if (args.cohortGlobs !== undefined && args.cohortGlobs.length > 0) {
    const discovered = resolveCohortFromVbriefs(args.cohortGlobs);
    for (const pr of discovered.prNumbers) {
      if (!prNumbers.includes(pr)) {
        prNumbers.push(pr);
      }
    }
    resolutionErrors.push(...discovered.failures);
  }

  if (prNumbers.length === 0) {
    const msg =
      "Error: empty cohort. Pass one or more PR numbers as positional " +
      "arguments and/or --cohort <glob> to discover PRs from vBRIEF references.";
    const cohort: CohortResult = {
      repo: args.repo ?? null,
      pr_results: [],
      resolution_errors: resolutionErrors,
      all_clean: false,
    };
    if (args.emitJson) {
      return {
        exitCode: EXIT_EXTERNAL_ERROR,
        stdout: `${JSON.stringify(cohortResultToDict(cohort), null, 2)}\n`,
        stderr: "",
      };
    }
    let stderr = `${msg}\n`;
    for (const err of resolutionErrors) {
      stderr += `  [${err.vbrief_path}] ${err.reason}\n`;
    }
    return { exitCode: EXIT_EXTERNAL_ERROR, stdout: "", stderr };
  }

  const runGh = args.runGh ?? defaultRunGh;
  const prResults: CohortPRResult[] = [];
  for (const prNum of prNumbers) {
    const perPr = evaluatePr(prNum, args.repo ?? null, runGh);
    if (perPr === null) {
      return { exitCode: EXIT_EXTERNAL_ERROR, stdout: "", stderr: "" };
    }
    prResults.push(perPr);
  }

  const cohort: CohortResult = {
    repo: args.repo ?? null,
    pr_results: prResults,
    resolution_errors: resolutionErrors,
    all_clean:
      prResults.length > 0 && resolutionErrors.length === 0 && prResults.every((r) => r.clean),
  };

  if (args.emitJson) {
    return {
      exitCode: cohort.all_clean ? EXIT_OK : EXIT_UNCLEAN,
      stdout: `${JSON.stringify(cohortResultToDict(cohort), null, 2)}\n`,
      stderr: "",
    };
  }
  return {
    exitCode: cohort.all_clean ? EXIT_OK : EXIT_UNCLEAN,
    stdout: `${renderReviewCleanText(cohort)}\n`,
    stderr: "",
  };
}

export { EXIT_EXTERNAL_ERROR, EXIT_OK, EXIT_UNCLEAN };
