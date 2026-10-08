#!/usr/bin/env node
/**
 * design-critique:spend-resolve — callable spend front door (#5466 Prefer-A).
 * Records closed spend-recommend: + resolved spend:/spend-ask: via
 * parseOperatorSpend / evaluateSpendRecord. Bare arc requires --recommend;
 * never asks; never defaults N=1. Does not copy run-posture missing-token
 * auto-resolve onto spend.
 */
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  clearArcSpendState,
  openArcSpendGate,
  resolveDesignCritiqueSpend,
} from "@deftai/directive-core/dist/design-critique/spend.js";

export const DESIGN_CRITIQUE_SPEND_RESOLVE_HELP = `design-critique:spend-resolve — record spend-recommend then resolve (#5466)

Usage:
  deft design-critique:spend-resolve --utterance <text> --recommend N=1|N≥3 [--project-root PATH] [--session-id ID] [--json]
  deft design-critique:spend-resolve --open-gate [--utterance <text>] [--project-root PATH] [--session-id ID]
  deft design-critique:spend-resolve --clear [--project-root PATH] [--session-id ID]
  deft design-critique:spend-resolve --utterance <text> --unclosable-recommend [--project-root PATH] [--session-id ID]

Options:
  --utterance TEXT          Operator chat utterance (required except --open-gate/--clear)
  --recommend N=1|N≥3       Closed Dual-stop recommendation (required on bare arc)
  --unclosable-recommend    Parent-declared unclosable recommend; permit lawful ask
  --open-gate               Open deny-default session-scoped arc-spend-state at arc start
  --clear                   Clear session arc-spend-state when the arc ends or is abandoned
  --session-id ID           Session that owns arc-spend-state (default: DEFT_SESSION_ID / env)
  --project-root PATH       Project root for arc-spend-state scratch (default: cwd)
  --json                    Emit structured result

Exit codes:
  0  Resolved / gate opened / cleared
  1  Refused (missing/invalid recommend, ambiguous, or unclosable ask path)
  2  Config / usage error
`;

export interface DesignCritiqueSpendResolveArgs {
  utterance: string | null;
  recommend: string | null;
  projectRoot: string;
  sessionId: string | null;
  emitJson: boolean;
  help: boolean;
  openGate: boolean;
  clear: boolean;
  unclosableRecommend: boolean;
  error?: string;
}

export function parseDesignCritiqueSpendResolveArgs(
  argv: readonly string[],
): DesignCritiqueSpendResolveArgs {
  const acc: DesignCritiqueSpendResolveArgs = {
    utterance: null,
    recommend: null,
    projectRoot: ".",
    sessionId: null,
    emitJson: false,
    help: false,
    openGate: false,
    clear: false,
    unclosableRecommend: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    // Accept a lone go-task / deft separator so documented `-- --utterance` forms work.
    if (arg === "--") {
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      return { ...acc, help: true };
    }
    if (arg === "--json") {
      acc.emitJson = true;
      continue;
    }
    if (arg === "--open-gate") {
      acc.openGate = true;
      continue;
    }
    if (arg === "--clear") {
      acc.clear = true;
      continue;
    }
    if (arg === "--unclosable-recommend") {
      acc.unclosableRecommend = true;
      continue;
    }
    if (arg === "--utterance") {
      const value = argv[i + 1];
      if (value === undefined) {
        return { ...acc, error: "argument --utterance: expected one argument" };
      }
      acc.utterance = value;
      i += 1;
      continue;
    }
    if (arg?.startsWith("--utterance=")) {
      acc.utterance = arg.slice("--utterance=".length);
      continue;
    }
    if (arg === "--recommend") {
      const value = argv[i + 1];
      if (value === undefined) {
        return { ...acc, error: "argument --recommend: expected one argument" };
      }
      acc.recommend = value;
      i += 1;
      continue;
    }
    if (arg?.startsWith("--recommend=")) {
      acc.recommend = arg.slice("--recommend=".length);
      continue;
    }
    if (arg === "--session-id") {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("--")) {
        return { ...acc, error: "argument --session-id: expected one argument" };
      }
      acc.sessionId = value;
      i += 1;
      continue;
    }
    if (arg?.startsWith("--session-id=")) {
      acc.sessionId = arg.slice("--session-id=".length);
      continue;
    }
    if (arg === "--project-root") {
      const value = argv[i + 1];
      if (value === undefined) {
        return { ...acc, error: "argument --project-root: expected one argument" };
      }
      acc.projectRoot = value;
      i += 1;
      continue;
    }
    if (arg?.startsWith("--project-root=")) {
      acc.projectRoot = arg.slice("--project-root=".length);
      continue;
    }
    return { ...acc, error: `unknown argument: ${arg}` };
  }
  return acc;
}

export function run(argv: readonly string[]): number {
  const args = parseDesignCritiqueSpendResolveArgs(argv);
  if (args.help) {
    process.stdout.write(`${DESIGN_CRITIQUE_SPEND_RESOLVE_HELP}\n`);
    return 0;
  }
  if (args.error !== undefined) {
    process.stderr.write(`design-critique:spend-resolve: ${args.error}\n`);
    return 2;
  }

  const projectRoot = resolve(args.projectRoot);
  const sessionId = args.sessionId;

  if (args.clear) {
    const removed = clearArcSpendState(projectRoot, { sessionId });
    if (args.emitJson) {
      process.stdout.write(`${JSON.stringify({ ok: true, cleared: removed }, null, 2)}\n`);
    } else {
      process.stdout.write(
        removed
          ? "design-critique:spend-resolve: cleared arc-spend-state\n"
          : "design-critique:spend-resolve: no arc-spend-state to clear\n",
      );
    }
    return 0;
  }

  if (args.openGate) {
    const state = openArcSpendGate(projectRoot, { utterance: args.utterance, sessionId });
    if (args.emitJson) {
      process.stdout.write(`${JSON.stringify({ ok: true, opened: true, state }, null, 2)}\n`);
    } else {
      process.stdout.write(
        "design-critique:spend-resolve: opened arc spend gate (ask denied until --recommend or lawful ask)\n",
      );
    }
    return 0;
  }

  if (args.utterance === null || args.utterance.trim().length === 0) {
    process.stderr.write(
      "design-critique:spend-resolve: --utterance is required\n" +
        "Remediation: deft design-critique:spend-resolve --utterance <text> --recommend N=1|N≥3\n",
    );
    return 2;
  }

  const result = resolveDesignCritiqueSpend({
    utterance: args.utterance,
    recommendRaw: args.recommend,
    unclosableRecommend: args.unclosableRecommend,
    projectRoot,
    sessionId,
  });

  if (args.emitJson) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else if (result.ok) {
    process.stdout.write(`${result.lines.join("\n")}\n`);
  } else {
    process.stderr.write(`${result.message}\n`);
  }

  return result.ok ? 0 : 1;
}

export function main(argv: readonly string[]): number {
  return run(argv);
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exit(run(process.argv.slice(2)));
}
