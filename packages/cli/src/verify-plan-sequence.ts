#!/usr/bin/env node
/**
 * verify:plan-sequence (#2402) — fail closed unless target matches current entry.
 */
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type PlanTargetKind,
  readPlanSequence,
  verifyPlanTarget,
} from "@deftai/directive-core/plan-sequence";

interface Parsed {
  projectRoot: string;
  targetKind: PlanTargetKind | null;
  target: string | null;
  emitJson: boolean;
  error?: string;
}

const KINDS: readonly PlanTargetKind[] = [
  "pr",
  "issue",
  "story",
  "task",
  "phase",
  "checklist",
  "review",
];

function parseArgs(argv: string[]): Parsed {
  const parsed: Parsed = {
    projectRoot: ".",
    targetKind: null,
    target: null,
    emitJson: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === undefined) continue;
    if (arg === "--json") {
      parsed.emitJson = true;
    } else if (arg === "--project-root") {
      const value = argv[++i];
      if (value === undefined) return { ...parsed, error: "--project-root requires a value" };
      parsed.projectRoot = value;
    } else if (arg.startsWith("--project-root=")) {
      parsed.projectRoot = arg.slice("--project-root=".length);
    } else if (arg === "--target-kind") {
      const value = argv[++i];
      if (value === undefined || !KINDS.includes(value as PlanTargetKind)) {
        return { ...parsed, error: `--target-kind must be one of ${KINDS.join("|")}` };
      }
      parsed.targetKind = value as PlanTargetKind;
    } else if (arg.startsWith("--target-kind=")) {
      const value = arg.slice("--target-kind=".length);
      if (!KINDS.includes(value as PlanTargetKind)) {
        return { ...parsed, error: `--target-kind must be one of ${KINDS.join("|")}` };
      }
      parsed.targetKind = value as PlanTargetKind;
    } else if (arg === "--target") {
      const value = argv[++i];
      if (value === undefined) return { ...parsed, error: "--target requires a value" };
      parsed.target = value;
    } else if (arg.startsWith("--target=")) {
      parsed.target = arg.slice("--target=".length);
    } else if (arg.startsWith("-")) {
      return { ...parsed, error: `unknown flag: ${arg}` };
    }
  }
  if (parsed.targetKind === null || parsed.target === null) {
    return {
      ...parsed,
      error: "usage: verify:plan-sequence -- --target-kind <kind> --target <id-or-title>",
    };
  }
  return parsed;
}

export function main(argv: string[] = process.argv.slice(2)): number {
  const parsed = parseArgs(argv);
  if (parsed.error || parsed.targetKind === null || parsed.target === null) {
    process.stderr.write(`${parsed.error ?? "usage error"}\n`);
    return 2;
  }
  const seq = readPlanSequence(resolve(parsed.projectRoot));
  // No sequence: allow (caller may have explicit operator approval); warn on stderr.
  if (seq === null) {
    if (parsed.emitJson) {
      process.stdout.write(
        `${JSON.stringify({ ok: true, skipped: true, reason: "no-active-sequence" }, null, 2)}\n`,
      );
    } else {
      process.stdout.write("OK verify:plan-sequence skipped (no active ordered-plan sequence)\n");
    }
    return 0;
  }
  const result = verifyPlanTarget(seq, {
    targetKind: parsed.targetKind,
    target: parsed.target,
  });
  if (parsed.emitJson) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else if (result.ok) {
    process.stdout.write(
      `OK verify:plan-sequence matched ${result.entry.kind}:${result.entry.id} (index=${result.index})\n`,
    );
  } else {
    process.stderr.write(`${result.message}\n`);
  }
  return result.ok ? 0 : 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(main());
}
