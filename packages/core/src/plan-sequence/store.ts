import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
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
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(sequence, null, 2)}\n`, "utf8");
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
