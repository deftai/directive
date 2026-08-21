#!/usr/bin/env node
/**
 * plan-sequence CLI (#2402): set | current | clear | advance
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  advancePlanSequence,
  clearPlanSequence,
  createPlanSequence,
  type PlanSequence,
  type PlanSequenceEntry,
  type PlanSequenceKind,
  parsePlanSequence,
  readPlanSequence,
  writePlanSequence,
} from "@deftai/directive-core/plan-sequence";

interface Parsed {
  projectRoot: string;
  action: "set" | "current" | "clear" | "advance" | null;
  file: string | null;
  jsonInline: string | null;
  emitJson: boolean;
  error?: string;
}

export function parseArgs(argv: string[]): Parsed {
  const parsed: Parsed = {
    projectRoot: ".",
    action: null,
    file: null,
    jsonInline: null,
    emitJson: false,
  };
  const positionals: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === undefined) continue;
    if (arg === "--") continue;
    if (arg === "--json") {
      parsed.emitJson = true;
    } else if (arg === "--project-root") {
      const value = argv[++i];
      if (value === undefined) {
        return { ...parsed, error: "--project-root requires a value" };
      }
      parsed.projectRoot = value;
    } else if (arg.startsWith("--project-root=")) {
      parsed.projectRoot = arg.slice("--project-root=".length);
    } else if (arg === "--file") {
      const value = argv[++i];
      if (value === undefined) {
        return { ...parsed, error: "--file requires a path" };
      }
      parsed.file = value;
    } else if (arg.startsWith("--file=")) {
      parsed.file = arg.slice("--file=".length);
    } else if (arg === "--from-json") {
      const value = argv[++i];
      if (value === undefined) {
        return { ...parsed, error: "--from-json requires a JSON string" };
      }
      parsed.jsonInline = value;
    } else if (arg.startsWith("-")) {
      return { ...parsed, error: `unknown flag: ${arg}` };
    } else {
      positionals.push(arg);
    }
  }
  const action = positionals[0];
  if (action === "set" || action === "current" || action === "clear" || action === "advance") {
    parsed.action = action;
  } else if (action !== undefined) {
    return { ...parsed, error: `unknown action: ${action} (set|current|clear|advance)` };
  } else {
    parsed.error =
      "usage: plan-sequence <set|current|clear|advance> [--file path] [--project-root path]";
  }
  return parsed;
}

function loadSetPayload(parsed: Parsed, root: string): PlanSequence {
  const text = parsed.file ? readFileSync(resolve(root, parsed.file), "utf8") : parsed.jsonInline;
  if (text === null || text === undefined) {
    throw new Error("plan-sequence set requires --file <path> or --from-json <json>");
  }
  const payload: unknown = JSON.parse(text);
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    throw new Error("plan-sequence set: --file/--from-json must contain a JSON object");
  }
  const raw = payload as Record<string, unknown>;
  if (typeof raw.current_index === "number" || raw.exhausted === true) {
    return parsePlanSequence(raw);
  }
  return createPlanSequence({
    sequence_id: String(raw.sequence_id),
    sequence_kind: raw.sequence_kind as PlanSequenceKind,
    entries: raw.entries as PlanSequenceEntry[],
    authorized_by: String(raw.authorized_by ?? ""),
    batching_allowed: raw.batching_allowed === true,
    continuation_past_final: raw.continuation_past_final === true,
  });
}

export function main(argv: string[] = process.argv.slice(2)): number {
  const parsed = parseArgs(argv);
  if (parsed.error || parsed.action === null) {
    process.stderr.write(`${parsed.error ?? "usage error"}\n`);
    return 2;
  }
  const root = resolve(parsed.projectRoot);
  try {
    if (parsed.action === "set") {
      const seq = loadSetPayload(parsed, root);
      const path = writePlanSequence(root, seq);
      if (parsed.emitJson) {
        process.stdout.write(`${JSON.stringify({ ok: true, path, sequence: seq }, null, 2)}\n`);
      } else {
        process.stdout.write(
          `OK plan-sequence set ${seq.sequence_id} (${seq.entries.length} entries, index=${seq.current_index})\n`,
        );
      }
      return 0;
    }
    if (parsed.action === "current") {
      const seq = readPlanSequence(root);
      if (seq === null) {
        process.stderr.write(
          "No active ordered-plan sequence (.deft/plan-sequence.json missing).\n",
        );
        return 1;
      }
      if (parsed.emitJson) {
        process.stdout.write(`${JSON.stringify(seq, null, 2)}\n`);
      } else {
        const cur = seq.exhausted ? null : seq.entries[seq.current_index];
        process.stdout.write(
          `sequence_id=${seq.sequence_id} kind=${seq.sequence_kind} index=${seq.current_index} exhausted=${String(seq.exhausted)}\n`,
        );
        if (cur) {
          const issue = cur.issue !== undefined ? ` (#${cur.issue})` : "";
          process.stdout.write(`current: ${cur.kind}:${cur.id}${issue}\n`);
        } else {
          process.stdout.write("current: (exhausted — fresh approval required)\n");
        }
      }
      return 0;
    }
    if (parsed.action === "clear") {
      const cleared = clearPlanSequence(root);
      process.stdout.write(
        cleared ? "OK plan-sequence cleared\n" : "OK plan-sequence already absent\n",
      );
      return 0;
    }
    const seq = readPlanSequence(root);
    if (seq === null) {
      process.stderr.write("No active ordered-plan sequence to advance.\n");
      return 1;
    }
    const next = advancePlanSequence(seq);
    writePlanSequence(root, next);
    if (parsed.emitJson) {
      process.stdout.write(`${JSON.stringify(next, null, 2)}\n`);
    } else if (next.exhausted) {
      process.stdout.write(
        "OK advanced; sequence exhausted. Fresh operator approval required before another unit.\n",
      );
    } else {
      const cur = next.entries[next.current_index];
      process.stdout.write(
        `OK advanced to index=${next.current_index} (${cur?.kind}:${cur?.id})\n`,
      );
    }
    return 0;
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(main());
}
