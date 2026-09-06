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

export interface Parsed {
  projectRoot: string;
  targetKind: PlanTargetKind | null;
  target: string | null;
  emitJson: boolean;
  /** Typed `--help` / `-h` (#4203); main() prints usage on stdout and exits 0. */
  help?: boolean;
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

const USAGE = "usage: verify:plan-sequence -- --target-kind <kind> --target <id-or-title>";

export function parseArgs(argv: string[]): Parsed {
  const parsed: Parsed = {
    projectRoot: ".",
    targetKind: null,
    target: null,
    emitJson: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === undefined || arg === "--") continue;
    if (arg === "--help" || arg === "-h") {
      return { ...parsed, help: true };
    }
    if (arg === "--json") {
      parsed.emitJson = true;
    } else if (arg === "--project-root") {
      const value = argv[++i];
      if (value === undefined || value === "--") {
        return { ...parsed, error: "--project-root requires a value" };
      }
      parsed.projectRoot = value;
    } else if (arg.startsWith("--project-root=")) {
      parsed.projectRoot = arg.slice("--project-root=".length);
    } else if (arg === "--target-kind") {
      const value = argv[++i];
      if (value === undefined || value === "--" || !KINDS.includes(value as PlanTargetKind)) {
        return { ...parsed, error: `--target-kind must be one of ${KINDS.join("|")}` };
      }
      parsed.targetKind = value as PlanTargetKind;
    } else if (arg.startsWith("--target-kind=")) {
      const value = arg.slice("--target-kind=".length);
      if (value === "--" || !KINDS.includes(value as PlanTargetKind)) {
        return { ...parsed, error: `--target-kind must be one of ${KINDS.join("|")}` };
      }
      parsed.targetKind = value as PlanTargetKind;
    } else if (arg === "--target") {
      const value = argv[++i];
      if (value === undefined || value === "--") {
        return { ...parsed, error: "--target requires a value" };
      }
      parsed.target = value;
    } else if (arg.startsWith("--target=")) {
      const value = arg.slice("--target=".length);
      if (value.length === 0 || value === "--") {
        return { ...parsed, error: "--target requires a value" };
      }
      parsed.target = value;
    } else if (arg.startsWith("-")) {
      return { ...parsed, error: `unknown flag: ${arg}` };
    }
  }
  if (parsed.help) return parsed;
  if (parsed.targetKind === null || parsed.target === null) {
    return {
      ...parsed,
      error: USAGE,
    };
  }
  return parsed;
}

export function main(argv: string[] = process.argv.slice(2)): number {
  const parsed = parseArgs(argv);
  if (parsed.help) {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }
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
