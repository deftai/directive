#!/usr/bin/env node
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CEREMONY_DEPTHS,
  type CeremonyDepth,
  type CeremonyDialInputs,
  normalizeCeremonyModelTier,
  normalizeCeremonyProjectShape,
  normalizeCeremonyTaskSize,
  selectCeremonyDepth,
} from "@deftai/directive-core/policy";
import {
  COLD_CEREMONY_TIER,
  parseDeferrals,
  READ_ONLY_POSTURE,
  REARM_CEREMONY_TIER,
  resolveProductionHostEffortDescriptor,
  ritualStatePath,
  runSessionStart,
  SESSION_CEREMONY_TIERS,
  type SessionCeremonyTier,
} from "@deftai/directive-core/session";

export interface ParsedSessionStartArgs {
  projectRoot: string;
  deferValues: string[];
  emitJson: boolean;
  noHistory: boolean;
  readOnly: boolean;
  /** #2991: opt into optional network (release probe + triage cache hydrate). */
  withNetwork: boolean;
  /** #2992: cold (full) vs rearm (clock/HEAD refresh without fat path). */
  ceremonyTier: SessionCeremonyTier;
  /** #3214: optional dial inputs for ritual-depth selection. */
  ceremonyDialInputs: CeremonyDialInputs;
  /**
   * #3214: force depth for this session only (does not persist policy).
   * Applied as resolve inputs via a one-shot config override in run().
   */
  ceremonyDepthOverride: CeremonyDepth | null;
  /**
   * #3266: host/CLI effort-budget cap fields for bank-the-pass guidance.
   * Merged with DEFT_HOST_EFFORT_BUDGET JSON when present.
   */
  effortBudgetHost: {
    maxTurns?: number;
    maxBudget?: number;
    hardBudget?: boolean;
  };
  error?: string;
}

function parseCeremonyDepth(raw: string): CeremonyDepth | null {
  const value = raw.trim().toLowerCase();
  if ((CEREMONY_DEPTHS as readonly string[]).includes(value)) {
    return value as CeremonyDepth;
  }
  return null;
}

function parseCeremonyTier(raw: string): SessionCeremonyTier | null {
  const value = raw.trim().toLowerCase();
  if ((SESSION_CEREMONY_TIERS as readonly string[]).includes(value)) {
    return value as SessionCeremonyTier;
  }
  return null;
}

/** Parse session:start CLI args, mirroring scripts/session_start.py. */
export function parseArgs(argv: readonly string[]): ParsedSessionStartArgs {
  const parsed: ParsedSessionStartArgs = {
    projectRoot: ".",
    deferValues: [],
    emitJson: false,
    noHistory: false,
    readOnly: false,
    withNetwork: false,
    ceremonyTier: COLD_CEREMONY_TIER,
    ceremonyDialInputs: {},
    ceremonyDepthOverride: null,
    effortBudgetHost: {},
  };
  const dialInputs: {
    taskSize?: ReturnType<typeof normalizeCeremonyTaskSize>;
    modelTier?: ReturnType<typeof normalizeCeremonyModelTier>;
    projectShape?: ReturnType<typeof normalizeCeremonyProjectShape>;
  } = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--json") {
      parsed.emitJson = true;
    } else if (arg === "--no-history") {
      parsed.noHistory = true;
    } else if (arg === "--read-only") {
      parsed.readOnly = true;
    } else if (arg === "--with-network") {
      parsed.withNetwork = true;
    } else if (arg === "--rearm") {
      // #2992: shortcut for --tier=rearm
      parsed.ceremonyTier = REARM_CEREMONY_TIER;
    } else if (arg === "--tier") {
      const value = argv[i + 1];
      if (value === undefined) {
        return { ...parsed, error: "argument --tier: expected one argument (cold|rearm)" };
      }
      const tier = parseCeremonyTier(value);
      if (tier === null) {
        return {
          ...parsed,
          error: `argument --tier: expected cold|rearm, got ${JSON.stringify(value)}`,
        };
      }
      parsed.ceremonyTier = tier;
      i += 1;
    } else if (arg?.startsWith("--tier=")) {
      const value = arg.slice("--tier=".length);
      const tier = parseCeremonyTier(value);
      if (tier === null) {
        return {
          ...parsed,
          error: `argument --tier: expected cold|rearm, got ${JSON.stringify(value)}`,
        };
      }
      parsed.ceremonyTier = tier;
    } else if (arg === "--project-root") {
      const value = argv[i + 1];
      if (value === undefined) {
        return { ...parsed, error: "argument --project-root: expected one argument" };
      }
      parsed.projectRoot = value;
      i += 1;
    } else if (arg?.startsWith("--project-root=")) {
      parsed.projectRoot = arg.slice("--project-root=".length);
    } else if (arg === "--defer") {
      const value = argv[i + 1];
      if (value === undefined) {
        return { ...parsed, error: "argument --defer: expected one argument" };
      }
      parsed.deferValues.push(value);
      i += 1;
    } else if (arg?.startsWith("--defer=")) {
      parsed.deferValues.push(arg.slice("--defer=".length));
    } else if (arg === "--task-size" || arg === "--ceremony-task-size") {
      const value = argv[i + 1];
      if (value === undefined) {
        return { ...parsed, error: `argument ${arg}: expected one argument (S|M|L|XL)` };
      }
      const size = normalizeCeremonyTaskSize(value);
      if (size === null) {
        return {
          ...parsed,
          error: `argument ${arg}: expected S|M|L|XL (or small|medium|large), got ${JSON.stringify(value)}`,
        };
      }
      dialInputs.taskSize = size;
      i += 1;
    } else if (arg?.startsWith("--task-size=") || arg?.startsWith("--ceremony-task-size=")) {
      const value = arg.slice(arg.indexOf("=") + 1);
      const size = normalizeCeremonyTaskSize(value);
      if (size === null) {
        return {
          ...parsed,
          error: `argument --task-size: expected S|M|L|XL, got ${JSON.stringify(value)}`,
        };
      }
      dialInputs.taskSize = size;
    } else if (arg === "--model-tier" || arg === "--ceremony-model-tier") {
      const value = argv[i + 1];
      if (value === undefined) {
        return {
          ...parsed,
          error: `argument ${arg}: expected one argument (frontier|mid|low)`,
        };
      }
      const tier = normalizeCeremonyModelTier(value);
      if (tier === null) {
        return {
          ...parsed,
          error: `argument ${arg}: expected frontier|mid|low, got ${JSON.stringify(value)}`,
        };
      }
      dialInputs.modelTier = tier;
      i += 1;
    } else if (arg?.startsWith("--model-tier=") || arg?.startsWith("--ceremony-model-tier=")) {
      const value = arg.slice(arg.indexOf("=") + 1);
      const tier = normalizeCeremonyModelTier(value);
      if (tier === null) {
        return {
          ...parsed,
          error: `argument --model-tier: expected frontier|mid|low, got ${JSON.stringify(value)}`,
        };
      }
      dialInputs.modelTier = tier;
    } else if (arg === "--project-shape" || arg === "--ceremony-project-shape") {
      const value = argv[i + 1];
      if (value === undefined) {
        return {
          ...parsed,
          error: `argument ${arg}: expected one argument (project|non-project)`,
        };
      }
      const shape = normalizeCeremonyProjectShape(value);
      if (shape === null) {
        return {
          ...parsed,
          error: `argument ${arg}: expected project|non-project, got ${JSON.stringify(value)}`,
        };
      }
      dialInputs.projectShape = shape;
      i += 1;
    } else if (
      arg?.startsWith("--project-shape=") ||
      arg?.startsWith("--ceremony-project-shape=")
    ) {
      const value = arg.slice(arg.indexOf("=") + 1);
      const shape = normalizeCeremonyProjectShape(value);
      if (shape === null) {
        return {
          ...parsed,
          error: `argument --project-shape: expected project|non-project, got ${JSON.stringify(value)}`,
        };
      }
      dialInputs.projectShape = shape;
    } else if (arg === "--ceremony-depth") {
      const value = argv[i + 1];
      if (value === undefined) {
        return {
          ...parsed,
          error:
            "argument --ceremony-depth: expected one argument (minimal|rapid|standard|elevated)",
        };
      }
      const depth = parseCeremonyDepth(value);
      if (depth === null) {
        return {
          ...parsed,
          error: `argument --ceremony-depth: expected minimal|rapid|standard|elevated, got ${JSON.stringify(value)}`,
        };
      }
      parsed.ceremonyDepthOverride = depth;
      i += 1;
    } else if (arg?.startsWith("--ceremony-depth=")) {
      const value = arg.slice("--ceremony-depth=".length);
      const depth = parseCeremonyDepth(value);
      if (depth === null) {
        return {
          ...parsed,
          error: `argument --ceremony-depth: expected minimal|rapid|standard|elevated, got ${JSON.stringify(value)}`,
        };
      }
      parsed.ceremonyDepthOverride = depth;
    } else if (arg === "--max-turns") {
      // #3266: harness hard turn budget for bank-the-pass guidance
      const value = argv[i + 1];
      if (value === undefined) {
        return { ...parsed, error: "argument --max-turns: expected one argument" };
      }
      const n = Number(value);
      if (!Number.isFinite(n) || n < 0) {
        return {
          ...parsed,
          error: `argument --max-turns: expected non-negative number, got ${JSON.stringify(value)}`,
        };
      }
      parsed.effortBudgetHost.maxTurns = n;
      i += 1;
    } else if (arg?.startsWith("--max-turns=")) {
      const value = arg.slice("--max-turns=".length);
      const n = Number(value);
      if (!Number.isFinite(n) || n < 0) {
        return {
          ...parsed,
          error: `argument --max-turns: expected non-negative number, got ${JSON.stringify(value)}`,
        };
      }
      parsed.effortBudgetHost.maxTurns = n;
    } else if (arg === "--max-budget") {
      const value = argv[i + 1];
      if (value === undefined) {
        return { ...parsed, error: "argument --max-budget: expected one argument" };
      }
      const n = Number(value);
      if (!Number.isFinite(n) || n < 0) {
        return {
          ...parsed,
          error: `argument --max-budget: expected non-negative number, got ${JSON.stringify(value)}`,
        };
      }
      parsed.effortBudgetHost.maxBudget = n;
      i += 1;
    } else if (arg?.startsWith("--max-budget=")) {
      const value = arg.slice("--max-budget=".length);
      const n = Number(value);
      if (!Number.isFinite(n) || n < 0) {
        return {
          ...parsed,
          error: `argument --max-budget: expected non-negative number, got ${JSON.stringify(value)}`,
        };
      }
      parsed.effortBudgetHost.maxBudget = n;
    } else if (arg === "--hard-budget") {
      parsed.effortBudgetHost.hardBudget = true;
    } else {
      return { ...parsed, error: `unrecognized argument: ${arg}` };
    }
  }
  parsed.ceremonyDialInputs = {
    taskSize: dialInputs.taskSize ?? null,
    modelTier: dialInputs.modelTier ?? null,
    projectShape: dialInputs.projectShape ?? null,
  };
  return parsed;
}

/** Native session:start handler (#2032 — replaces framework-commands Python bridge). */
export function run(argv: readonly string[]): number {
  const args = parseArgs(argv);
  if (args.error !== undefined) {
    process.stderr.write(`session_start: ${args.error}\n`);
    return 2;
  }

  const projectRoot = resolve(args.projectRoot);
  const { deferrals, errors } = parseDeferrals(args.deferValues);
  if (errors.length > 0) {
    for (const error of errors) {
      process.stderr.write(`${error}\n`);
    }
    return 2;
  }

  const capturedStdout: string[] = [];
  const prevWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((
    chunk: string | Uint8Array,
    encoding?: BufferEncoding | ((err?: Error | null) => void),
    callback?: (err?: Error | null) => void,
  ): boolean => {
    capturedStdout.push(String(chunk));
    const cb = typeof encoding === "function" ? encoding : callback;
    if (typeof cb === "function") {
      cb();
    }
    return true;
  }) as typeof process.stdout.write;

  // #3266: production host adapter — native harness env + DEFT_HOST_EFFORT_BUDGET + CLI flags.
  const hostDescriptor: Record<string, unknown> = {
    ...resolveProductionHostEffortDescriptor(process.env),
  };
  if (args.effortBudgetHost.maxTurns !== undefined) {
    hostDescriptor.maxTurns = args.effortBudgetHost.maxTurns;
  }
  if (args.effortBudgetHost.maxBudget !== undefined) {
    hostDescriptor.maxBudget = args.effortBudgetHost.maxBudget;
  }
  if (args.effortBudgetHost.hardBudget === true) {
    hostDescriptor.hardBudget = true;
  }

  let result: ReturnType<typeof runSessionStart>;
  try {
    // #3214: --ceremony-depth forces this session only (not persisted to policy).
    result = runSessionStart(projectRoot, {
      deferrals,
      writeHistory: !args.noHistory,
      posture: args.readOnly ? READ_ONLY_POSTURE : undefined,
      allowOptionalNetwork: args.withNetwork ? true : undefined,
      ceremonyTier: args.ceremonyTier,
      ceremonyDialInputs: args.ceremonyDialInputs,
      effortBudgetSeams: { hostDescriptor, environ: process.env },
      ...(args.ceremonyDepthOverride !== null
        ? {
            ceremonyDial: selectCeremonyDepth({
              config: { enabled: true, override: args.ceremonyDepthOverride },
              inputs: args.ceremonyDialInputs,
            }),
          }
        : {}),
    });
  } finally {
    process.stdout.write = prevWrite;
  }

  const lines = [...result.lines];
  const stray = capturedStdout.join("").trim();
  if (stray) {
    lines.push(stray);
  }

  if (args.emitJson) {
    const sorted = Object.keys(result.payload)
      .sort()
      .reduce<Record<string, unknown>>((acc, key) => {
        acc[key] = result.payload[key];
        return acc;
      }, {});
    process.stdout.write(`${JSON.stringify(sorted)}\n`);
    return result.code;
  }

  const sink = result.code === 0 ? process.stdout : process.stderr;
  for (const line of lines) {
    sink.write(`${line}\n`);
  }
  if (result.code === 0) {
    const posture = result.payload.posture;
    if (posture === READ_ONLY_POSTURE) {
      process.stdout.write(`[deft] ${String(result.payload.message)}\n`);
    } else {
      process.stdout.write(
        `[deft] session ritual recorded at ${ritualStatePath(projectRoot)} (diagnostic-only; not posture authority)\n`,
      );
    }
  }
  return result.code;
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exit(run(process.argv.slice(2)));
}
