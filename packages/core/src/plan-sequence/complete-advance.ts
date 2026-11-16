/**
 * Plan cursor catch-up after `scope:complete` (#6205).
 *
 * Readers already derive the cursor from completed briefs, so this write is
 * a convenience, not a record: it never fails and never rolls back the
 * completion. It writes the stored cursor forward only when this checkout
 * holds an untracked plan file, never a tracked plan and never another
 * checkout's plan, and reports exactly one named line.
 */
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { basename, relative, resolve } from "node:path";
import { derivePlanCursor, findFinishingOrigin, materializeDerivedCursor } from "./derive.js";
import { planSequencePath, readPlanSequence, writePlanSequence } from "./store.js";
import type { TerminalLifecycleOrigin } from "./terminal-drift.js";
import { collectTerminalLifecycleOrigins } from "./terminal-drift-scan.js";

export const COMPLETE_ADVANCE_STATUSES = [
  "advanced",
  "derived-only",
  "no-sequence",
  "no-entry",
  "not-current",
  "store-failed",
] as const;

export type CompleteAdvanceStatus = (typeof COMPLETE_ADVANCE_STATUSES)[number];

export interface CompleteAdvanceResult {
  readonly status: CompleteAdvanceStatus;
  /** The one line `scope:complete` prints. */
  readonly line: string;
}

export interface CompleteAdvanceSeams {
  /** True when git tracks the plan file in this checkout. */
  readonly isPlanTracked?: (projectRoot: string) => boolean;
  /** Plan write; tests inject a failure. */
  readonly writePlan?: typeof writePlanSequence;
  /** Terminal folder facts; defaults to the local scan. */
  readonly collectOrigins?: (projectRoot: string) => TerminalLifecycleOrigin[];
}

/** True when git tracks `.deft/plan-sequence.json` in this checkout. */
export function isPlanSequenceTracked(projectRoot: string): boolean {
  try {
    execFileSync("git", ["ls-files", "--error-unmatch", "--", ".deft/plan-sequence.json"], {
      cwd: projectRoot,
      stdio: ["ignore", "ignore", "ignore"],
    });
    return true;
  } catch {
    return false;
  }
}

function result(status: CompleteAdvanceStatus, detail: string): CompleteAdvanceResult {
  return { status, line: `plan-sequence: ${status} (${detail})` };
}

function relPosix(projectRoot: string, path: string): string {
  return relative(resolve(projectRoot), resolve(path)).replace(/\\/g, "/");
}

/**
 * After a successful complete of `completedPath`, move this checkout's stored
 * cursor forward when that brief finished the entry the reader had reached.
 */
export function advancePlanAfterComplete(input: {
  readonly projectRoot: string;
  readonly completedPath: string;
  readonly now?: string;
  readonly seams?: CompleteAdvanceSeams;
}): CompleteAdvanceResult {
  const root = resolve(input.projectRoot);
  try {
    if (!existsSync(planSequencePath(root))) {
      return result("no-sequence", "no .deft/plan-sequence.json in this checkout");
    }
    const sequence = readPlanSequence(root);
    if (sequence === null) {
      return result("no-sequence", "no .deft/plan-sequence.json in this checkout");
    }
    const origins = (input.seams?.collectOrigins ?? collectTerminalLifecycleOrigins)(root);
    const briefRel = relPosix(root, input.completedPath);
    // Same checkout scan; the basename fallback covers a realpath'd lifecycle root.
    const own =
      origins.find((o) => o.path === briefRel) ??
      origins.find(
        (o) => o.folder === "completed" && basename(o.path) === basename(input.completedPath),
      );
    const matched =
      own === undefined
        ? []
        : sequence.entries.filter((entry) => findFinishingOrigin(entry, [own]) !== null);
    if (matched.length === 0) {
      return result("no-entry", `${briefRel} matches no plan entry`);
    }
    const cursor = derivePlanCursor(sequence, origins);
    const finishedHere = cursor.derivedFinished.filter((d) => d.originPath === own?.path);
    if (finishedHere.length === 0) {
      const ids = matched.map((e) => `${e.kind}:${e.id}`).join(", ");
      return result("not-current", `${ids} is not the entry the plan had reached`);
    }
    const next =
      cursor.entry === null
        ? "exhausted"
        : `current ${cursor.entry.kind}:${cursor.entry.id} index=${String(cursor.index)}`;
    if ((input.seams?.isPlanTracked ?? isPlanSequenceTracked)(root)) {
      return result("derived-only", `tracked plan not written; readers derive ${next}`);
    }
    const materialized = materializeDerivedCursor(sequence, cursor, input.now);
    const wrote = (input.seams?.writePlan ?? writePlanSequence)(
      root,
      materialized,
      sequence.generation,
    );
    if (!wrote.ok) {
      return result("store-failed", `${wrote.message}; readers still derive ${next}`);
    }
    return result("advanced", `${next} generation=${String(wrote.sequence.generation)}`);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return result("store-failed", `${detail}; the completion stands and readers derive`);
  }
}
