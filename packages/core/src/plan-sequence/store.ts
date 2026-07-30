import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import { containedWrite } from "../fs/contained-write.js";
import { PLAN_SEQUENCE_FILENAME, type PlanSequence, parsePlanSequence } from "./types.js";

export function planSequencePath(projectRoot: string): string {
  return join(projectRoot, ".deft", PLAN_SEQUENCE_FILENAME);
}

export function readPlanSequence(projectRoot: string): PlanSequence | null {
  const path = planSequencePath(projectRoot);
  if (!existsSync(path)) {
    return null;
  }
  const raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
  return parsePlanSequence(raw);
}

export function writePlanSequence(projectRoot: string, sequence: PlanSequence): string {
  const path = planSequencePath(projectRoot);
  // #2980 wave D: product write sink routes through containedWrite.
  const root = resolve(projectRoot);
  containedWrite({
    root,
    target: path,
    data: `${JSON.stringify(sequence, null, 2)}\n`,
    mode: "replace",
  });
  return path;
}

export function clearPlanSequence(projectRoot: string): boolean {
  const path = planSequencePath(projectRoot);
  if (!existsSync(path)) {
    return false;
  }
  unlinkSync(path);
  return true;
}
