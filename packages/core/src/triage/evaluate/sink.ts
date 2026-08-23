import { existsSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { containedRemove, containedWrite } from "../../fs/contained-write.js";
import { issueEvalScratchRoot, sinkDir, sinkManifestPath, sinkVerdictPath } from "./paths.js";
import type { EvaluateResult } from "./types.js";
import { assertNoReservedClearance } from "./value.js";

export function writeInvocationSink(projectRoot: string, result: EvaluateResult): string {
  const root = resolve(projectRoot);
  const serialized = JSON.stringify(result, null, 2);
  assertNoReservedClearance(serialized, "verdict sink");
  containedWrite({
    root,
    target: sinkManifestPath(projectRoot, result.sha12, result.invocationId),
    data: `${serialized}\n`,
    mode: "replace",
  });
  for (const verdict of result.verdicts) {
    const body = JSON.stringify(verdict, null, 2);
    assertNoReservedClearance(body, `verdict issue-${verdict.issue}`);
    containedWrite({
      root,
      target: sinkVerdictPath(projectRoot, result.sha12, result.invocationId, verdict.issue),
      data: `${body}\n`,
      mode: "replace",
    });
  }
  return sinkDir(projectRoot, result.sha12, result.invocationId);
}

export function gcStaleSha12Dirs(projectRoot: string, currentSha12: string): string[] {
  const root = resolve(projectRoot);
  const scratch = issueEvalScratchRoot(projectRoot);
  if (!existsSync(scratch)) {
    return [];
  }
  const removed: string[] = [];
  for (const name of readdirSync(scratch)) {
    if (name === currentSha12) {
      continue;
    }
    const target = `${scratch.replace(/\\/g, "/")}/${name}`;
    containedRemove({ root, target, recursive: true });
    removed.push(name);
  }
  return removed;
}

export function teardownSink(projectRoot: string, sha12: string, invocationId: string): void {
  const dir = sinkDir(projectRoot, sha12, invocationId);
  if (!existsSync(dir)) {
    return;
  }
  containedRemove({ root: resolve(projectRoot), target: dir, recursive: true });
}
