import {
  EXIT_EXTERNAL_ERROR,
  EXIT_MERGE_BLOCKED,
  EXIT_OK,
  VIA_ERROR,
  VIA_FALLBACK2,
} from "./constants.js";
import { isMergeReady } from "./evaluate.js";
import type { GateResult, GreptileVerdict } from "./types.js";

function verdictToDict(verdict: GreptileVerdict): Record<string, unknown> {
  return {
    found: verdict.found,
    errored: verdict.errored,
    last_reviewed_sha: verdict.lastReviewedSha,
    confidence: verdict.confidence,
    p0_count: verdict.p0Count,
    p1_count: verdict.p1Count,
    p2_count: verdict.p2Count,
    informal_clean: verdict.informalClean,
    raw_body_excerpt: verdict.rawBodyExcerpt,
  };
}

/** Serialise gate result matching Python `GateResult.to_dict()` key order. */
export function gateResultToDict(result: GateResult): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    pr_number: result.prNumber,
    repo: result.repo,
    head_sha: result.headSha,
    verdict: verdictToDict(result.verdict),
    failures: [...result.failures],
    merge_ready: isMergeReady(result.failures),
    via: result.via,
  };
  if (Object.keys(result.partialData).length > 0) {
    payload.partial_data = { ...result.partialData };
  }
  if (result.error !== null) {
    payload.error = result.error;
  }
  return payload;
}

/** Match Python json.dumps(..., indent=2) default ensure_ascii=True. */
function pythonJsonDumps(value: unknown): string {
  const json = JSON.stringify(value, null, 2);
  return json.replace(/[\u007f-\uffff]/g, (ch) => {
    const code = ch.charCodeAt(0);
    return `\\u${code.toString(16).padStart(4, "0")}`;
  });
}

export function emitJson(result: GateResult): string {
  return `${pythonJsonDumps(gateResultToDict(result))}\n`;
}

export function printHuman(result: GateResult): string {
  const lines: string[] = [];
  lines.push(`PR #${result.prNumber} merge-readiness check  (via=${result.via})`);
  lines.push(`  HEAD SHA:           ${result.headSha ?? "<unknown>"}`);
  lines.push(`  Greptile reviewed:  ${result.verdict.lastReviewedSha ?? "<not parsed>"}`);
  const confidenceStr =
    result.verdict.confidence !== null ? String(result.verdict.confidence) : "<not parsed>";
  lines.push(`  Confidence:         ${confidenceStr}/5`);
  lines.push(
    `  Findings:           P0=${result.verdict.p0Count}  ` +
      `P1=${result.verdict.p1Count}  P2=${result.verdict.p2Count}`,
  );
  lines.push(`  Errored sentinel:   ${result.verdict.errored ? "True" : "False"}`);
  if (result.via === VIA_FALLBACK2 && Object.keys(result.partialData).length > 0) {
    lines.push("  Fallback2 signal:");
    for (const key of ["pr_state", "merged", "mergeable", "mergeable_state"] as const) {
      if (key in result.partialData) {
        lines.push(`    ${key}: ${String(result.partialData[key])}`);
      }
    }
    const checkRuns = result.partialData.check_runs;
    if (checkRuns !== null && typeof checkRuns === "object" && !Array.isArray(checkRuns)) {
      const greptile = (checkRuns as Record<string, unknown>).greptile_review;
      if (greptile !== null && greptile !== undefined && typeof greptile === "object") {
        const g = greptile as Record<string, unknown>;
        const status = typeof g.status === "string" ? g.status : "unknown";
        const conclusion = typeof g.conclusion === "string" ? g.conclusion : "none";
        lines.push(
          `    Greptile Review check: {'status': '${status}', 'conclusion': '${conclusion}'}`,
        );
      }
    }
  }
  if (isMergeReady(result.failures)) {
    lines.push("");
    lines.push("Result: MERGE-READY");
  } else {
    const label = result.via !== VIA_ERROR ? "MERGE-BLOCKED" : "EXTERNAL-ERROR";
    lines.push("");
    lines.push(`Result: ${label}`);
    result.failures.forEach((fail, i) => {
      lines.push(`  [${i + 1}] ${fail}`);
    });
    if (result.error !== null) {
      lines.push("");
      lines.push(`Underlying error: ${result.error}`);
    }
  }
  return `${lines.join("\n")}\n`;
}

export function exitCodeFor(result: GateResult): number {
  if (result.via === VIA_ERROR) {
    return EXIT_EXTERNAL_ERROR;
  }
  return isMergeReady(result.failures) ? EXIT_OK : EXIT_MERGE_BLOCKED;
}
