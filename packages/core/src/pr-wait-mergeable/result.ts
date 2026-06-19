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
    "monitorResult" | "protectedCheck" | "mergeStdout" | "mergeStderr"
  > & {
    readonly monitorResult?: Record<string, unknown>;
    readonly protectedCheck?: Record<string, unknown>;
    readonly mergeStdout?: string;
    readonly mergeStderr?: string;
  },
): WaitMergeableResult {
  return {
    monitorResult: fields.monitorResult ?? {},
    protectedCheck: fields.protectedCheck ?? {},
    mergeStdout: fields.mergeStdout ?? "",
    mergeStderr: fields.mergeStderr ?? "",
    prNumber: fields.prNumber,
    repo: fields.repo,
    outcome: fields.outcome,
    exitCode: fields.exitCode,
    error: fields.error,
  };
}
