import { computeGateResult } from "../pr-merge-readiness/compute.js";
import { EXIT_EXTERNAL_ERROR } from "../pr-merge-readiness/constants.js";
import { defaultRunGh } from "../pr-merge-readiness/gh.js";
import { exitCodeFor, gateResultToDict } from "../pr-merge-readiness/output.js";
import { EXIT_CONFIG_ERROR } from "./constants.js";
import type { CallReadinessOptions, PollResult } from "./types.js";

/** Match Python json.dumps(..., indent=2) default ensure_ascii=True. */
function pythonJsonDumps(value: unknown): string {
  const json = JSON.stringify(value, null, 2);
  return json.replace(/[\u007f-\uffff]/g, (ch) => {
    const code = ch.charCodeAt(0);
    return `\\u${code.toString(16).padStart(4, "0")}`;
  });
}

/** Run one pr_merge_readiness-equivalent check and parse the verdict JSON. */
export function callReadiness(
  prNumber: number,
  repo: string,
  options: CallReadinessOptions = {},
): PollResult {
  const stderrChunks: string[] = [];
  const originalWrite = process.stderr.write.bind(process.stderr);
  const captureWrite: typeof process.stderr.write = ((
    chunk: string | Uint8Array,
    ..._args: unknown[]
  ) => {
    if (typeof chunk === "string") {
      stderrChunks.push(chunk);
    } else {
      stderrChunks.push(Buffer.from(chunk).toString("utf8"));
    }
    return true;
  }) as typeof process.stderr.write;

  try {
    process.stderr.write = captureWrite;
    const runGh = options.runGh ?? defaultRunGh;
    const result = computeGateResult(prNumber, repo, runGh);
    const payload = gateResultToDict(result);
    const exitCode = exitCodeFor(result);
    return {
      exitCode,
      payload,
      rawStdout: `${pythonJsonDumps(payload)}\n`,
      rawStderr: stderrChunks.join(""),
    };
  } catch (exc: unknown) {
    const message =
      exc instanceof Error ? exc.message : `unexpected exception running readiness: ${String(exc)}`;
    return {
      exitCode: EXIT_CONFIG_ERROR,
      payload: {
        via: "error",
        merge_ready: false,
        error: message,
      },
      rawStdout: "",
      rawStderr: stderrChunks.join("") || message,
    };
  } finally {
    process.stderr.write = originalWrite;
  }
}

/** Map readiness-layer external errors to monitor poll semantics. */
export function readinessExitToPoll(exitCode: number): number {
  if (exitCode === EXIT_EXTERNAL_ERROR) {
    return 1;
  }
  return exitCode;
}
