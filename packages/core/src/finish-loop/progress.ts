/**
 * Heartbeat surface for walk-away finish-loop (#871).
 * Append-only JSONL at `.deft-cache/finish-loop-progress.jsonl`.
 */

import { join, resolve } from "node:path";
import { containedWrite } from "../fs/contained-write.js";
import type { FinishLoopProgressLine } from "./types.js";

export const FINISH_LOOP_PROGRESS_REL = join(".deft-cache", "finish-loop-progress.jsonl");

export function finishLoopProgressPath(projectRoot: string): string {
  return resolve(projectRoot, FINISH_LOOP_PROGRESS_REL);
}

export function utcIso(now?: Date): string {
  return (now ?? new Date()).toISOString().replace(/\.\d{3}Z$/, "Z");
}

export function makeProgressLine(
  partial: Omit<FinishLoopProgressLine, "schemaVersion" | "ts"> & {
    readonly ts?: string;
  },
): FinishLoopProgressLine {
  return {
    schemaVersion: 1,
    ts: partial.ts ?? utcIso(),
    phase: partial.phase,
    iteration: partial.iteration,
    haltReason: partial.haltReason,
    message: partial.message.replace(/[\r\n]+/g, " "),
    prNumber: partial.prNumber,
    grantId: partial.grantId,
    queueCount: partial.queueCount,
    exitCode: partial.exitCode,
    extra: partial.extra,
  };
}

/**
 * Append one progress line. Creates parent dirs via containedWrite.
 * #2951 Phase 2: product write sink routes through containedWrite.
 */
export function appendFinishLoopProgress(
  projectRoot: string,
  line: FinishLoopProgressLine,
): string {
  const root = resolve(projectRoot);
  const path = finishLoopProgressPath(root);
  const payload = { ...line };
  containedWrite({
    root,
    target: path,
    data: `${JSON.stringify(payload)}\n`,
    mode: "append",
  });
  return path;
}
