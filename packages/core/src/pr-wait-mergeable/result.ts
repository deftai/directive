import type { WaitMergeableResult } from "./types.js";

export function toResultDict(result: WaitMergeableResult): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    pr_number: result.prNumber,
    repo: result.repo,
    outcome: result.outcome,
    exit_code: result.exitCode,
  };
  if (Object.keys(result.monitorResult).length > 0) {
    payload.monitor_result = result.monitorResult;
  }
  if (Object.keys(result.protectedCheck).length > 0) {
    payload.protected_check = result.protectedCheck;
  }
  if (Object.keys(result.semanticGreen).length > 0) {
    payload.semantic_green = result.semanticGreen;
  }
  if (result.mergeQueue !== undefined && Object.keys(result.mergeQueue).length > 0) {
    payload.merge_queue = result.mergeQueue;
  }
  if (result.mergeStdout.length > 0) {
    payload.merge_stdout = result.mergeStdout;
  }
  if (result.mergeStderr.length > 0) {
    payload.merge_stderr = result.mergeStderr;
  }
  if (result.error !== null) {
    payload.error = result.error;
  }
  return payload;
}

export function makeResult(
  fields: Omit<
    WaitMergeableResult,
    | "monitorResult"
    | "protectedCheck"
    | "semanticGreen"
    | "mergeQueue"
    | "mergeStdout"
    | "mergeStderr"
  > & {
    readonly monitorResult?: Record<string, unknown>;
    readonly protectedCheck?: Record<string, unknown>;
    readonly semanticGreen?: Record<string, unknown>;
    readonly mergeQueue?: Record<string, unknown>;
    readonly mergeStdout?: string;
    readonly mergeStderr?: string;
  },
): WaitMergeableResult {
  return {
    monitorResult: fields.monitorResult ?? {},
    protectedCheck: fields.protectedCheck ?? {},
    semanticGreen: fields.semanticGreen ?? {},
    mergeQueue: fields.mergeQueue ?? {},
    mergeStdout: fields.mergeStdout ?? "",
    mergeStderr: fields.mergeStderr ?? "",
    prNumber: fields.prNumber,
    repo: fields.repo,
    outcome: fields.outcome,
    exitCode: fields.exitCode,
    error: fields.error,
  };
}
