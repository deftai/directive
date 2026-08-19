#!/usr/bin/env node
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type DirectivePosture,
  emitBypassWarning,
  emitVerifyJson,
  formatCacheFreshDeferSoftPath,
  formatRitualRecoveryInstruction,
  type VerifyResult,
  verifySessionRitual,
} from "@deftai/directive-core/session";

export interface VerifySessionRitualRunDeps {
  readonly verifySessionRitual?: (
    projectRoot: string,
    options: { tier: "quick" | "gated"; posture?: DirectivePosture },
  ) => VerifyResult;
}

interface ParsedArgs {
  projectRoot: string;
  tier: "quick" | "gated";
  posture: DirectivePosture | null;
  emitJson: boolean;
  error?: string;
}

function parsePosture(value: string): DirectivePosture | null {
  if (value === "read-only") return "read-only";
  if (value === "mutation" || value === "mutating") return "mutation";
  return null;
}

/** Parse verify-session-ritual CLI args, mirroring scripts/verify_session_ritual.py. */
export function parseArgs(argv: string[]): ParsedArgs {
  const parsed: ParsedArgs = {
    projectRoot: ".",
    tier: "quick",
    posture: null,
    emitJson: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--") {
      continue;
    }
    if (arg === "--json") {
      parsed.emitJson = true;
    } else if (arg === "--project-root") {
      const value = argv[i + 1];
      if (value === undefined) {
        return { ...parsed, error: "argument --project-root: expected one argument" };
      }
      parsed.projectRoot = value;
      i += 1;
    } else if (arg?.startsWith("--project-root=")) {
      parsed.projectRoot = arg.slice("--project-root=".length);
    } else if (arg === "--tier") {
      const value = argv[i + 1];
      if (value === undefined) {
        return { ...parsed, error: "argument --tier: expected one argument" };
      }
      if (value !== "quick" && value !== "gated") {
        return { ...parsed, error: `argument --tier: invalid choice: '${value}'` };
      }
      parsed.tier = value;
      i += 1;
    } else if (arg?.startsWith("--tier=")) {
      const value = arg.slice("--tier=".length);
      if (value !== "quick" && value !== "gated") {
        return { ...parsed, error: `argument --tier: invalid choice: '${value}'` };
      }
      parsed.tier = value;
    } else if (arg === "--posture") {
      const value = argv[i + 1];
      if (value === undefined) {
        return { ...parsed, error: "argument --posture: expected one argument" };
      }
      const posture = parsePosture(value);
      if (posture === null) {
        return {
          ...parsed,
          error: `argument --posture: invalid choice: '${value}' (expected read-only|mutation)`,
        };
      }
      parsed.posture = posture;
      i += 1;
    } else if (arg?.startsWith("--posture=")) {
      const value = arg.slice("--posture=".length);
      const posture = parsePosture(value);
      if (posture === null) {
        return {
          ...parsed,
          error: `argument --posture: invalid choice: '${value}' (expected read-only|mutation)`,
        };
      }
      parsed.posture = posture;
    } else {
      return { ...parsed, error: `unrecognized argument: ${arg}` };
    }
  }
  return parsed;
}

/** Run the gate and return the process exit code. */
export function run(argv: string[], deps: VerifySessionRitualRunDeps = {}): number {
  const args = parseArgs(argv);
  if (args.error !== undefined) {
    process.stderr.write(`verify_session_ritual: ${args.error}\n`);
    return 2;
  }
  const projectRoot = resolve(args.projectRoot);
  const verify = deps.verifySessionRitual ?? verifySessionRitual;
  const result = verify(projectRoot, {
    tier: args.tier,
    posture: args.posture ?? undefined,
  });
  const warning = emitBypassWarning(result);
  const warningNeeded = result.bypassed && result.wouldFailCode !== null;

  if (args.emitJson) {
    process.stdout.write(`${emitVerifyJson(result)}\n`);
  } else if (result.code === 0) {
    if (!warningNeeded) {
      process.stdout.write(`${result.message}\n`);
    }
  } else if (result.code === 1) {
    const recovery = formatRitualRecoveryInstruction(result.recoveryTier ?? "cold");
    process.stderr.write(`${result.message}\n${recovery}\n${formatCacheFreshDeferSoftPath()}\n`);
  } else {
    process.stderr.write(`${result.message}\n`);
  }
  if (warning.length > 0) {
    process.stderr.write(`${warning}\n`);
  }
  return result.code;
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exit(run(process.argv.slice(2)));
}
