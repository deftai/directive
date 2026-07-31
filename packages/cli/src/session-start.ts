#!/usr/bin/env node
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  parseDeferrals,
  READ_ONLY_POSTURE,
  ritualStatePath,
  runSessionStart,
} from "@deftai/directive-core/session";

export interface ParsedSessionStartArgs {
  projectRoot: string;
  deferValues: string[];
  emitJson: boolean;
  noHistory: boolean;
  readOnly: boolean;
  /** #2991: opt into optional network (release probe + triage cache hydrate). */
  withNetwork: boolean;
  error?: string;
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
  };
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
    } else {
      return { ...parsed, error: `unrecognized argument: ${arg}` };
    }
  }
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

  let result: ReturnType<typeof runSessionStart>;
  try {
    result = runSessionStart(projectRoot, {
      deferrals,
      writeHistory: !args.noHistory,
      posture: args.readOnly ? READ_ONLY_POSTURE : undefined,
      allowOptionalNetwork: args.withNetwork ? true : undefined,
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
