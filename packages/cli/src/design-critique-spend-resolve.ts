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
import { resolveDesignCritiqueSpend } from "@deftai/directive-core/dist/design-critique/spend.js";

export const EXIT_SPEND_RESOLVE_OK = 0;
export const EXIT_SPEND_RESOLVE_REFUSED = 1;
export const EXIT_SPEND_RESOLVE_CONFIG = 2;

export const DESIGN_CRITIQUE_SPEND_RESOLVE_HELP = `design-critique:spend-resolve — record spend-recommend then resolve (#5466)

Usage:
  task design-critique:spend-resolve -- --utterance <text> --recommend N=1|N≥3 [--project-root PATH] [--json]

Options:
  --utterance TEXT     Operator chat utterance (required)
  --recommend N=1|N≥3  Closed Dual-stop recommendation (required on bare arc)
  --project-root PATH  Project root for arc-spend-state scratch (default: cwd)
  --json               Emit structured result

Exit codes:
  0  Resolved; printed spend-recommend: / spend: / spend-ask: resolved
  1  Refused (missing/invalid recommend, or ambiguous utterance)
  2  Config / usage error
`;

export interface DesignCritiqueSpendResolveArgs {
  utterance: string | null;
  recommend: string | null;
  projectRoot: string;
  emitJson: boolean;
  help: boolean;
  error?: string;
}

export function parseDesignCritiqueSpendResolveArgs(
  argv: readonly string[],
): DesignCritiqueSpendResolveArgs {
  const acc: DesignCritiqueSpendResolveArgs = {
    utterance: null,
    recommend: null,
    projectRoot: ".",
    emitJson: false,
    help: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      return { ...acc, help: true };
    }
    if (arg === "--json") {
      acc.emitJson = true;
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
    return EXIT_SPEND_RESOLVE_OK;
  }
  if (args.error !== undefined) {
    process.stderr.write(`design-critique:spend-resolve: ${args.error}\n`);
    return EXIT_SPEND_RESOLVE_CONFIG;
  }
  if (args.utterance === null || args.utterance.trim().length === 0) {
    process.stderr.write(
      "design-critique:spend-resolve: --utterance is required\n" +
        "Remediation: task design-critique:spend-resolve -- --utterance <text> --recommend N=1|N≥3\n",
    );
    return EXIT_SPEND_RESOLVE_CONFIG;
  }

  const result = resolveDesignCritiqueSpend({
    utterance: args.utterance,
    recommendRaw: args.recommend,
    projectRoot: resolve(args.projectRoot),
  });

  if (args.emitJson) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else if (result.ok) {
    process.stdout.write(`${result.lines.join("\n")}\n`);
  } else {
    process.stderr.write(`${result.message}\n`);
  }

  return result.ok ? EXIT_SPEND_RESOLVE_OK : EXIT_SPEND_RESOLVE_REFUSED;
}

export function main(argv: readonly string[]): number {
  return run(argv);
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exit(run(process.argv.slice(2)));
}
