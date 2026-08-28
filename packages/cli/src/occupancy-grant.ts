#!/usr/bin/env node
import { resolve } from "node:path";
import {
  grantOccupancyMembership,
  OCCUPANCY_JOIN_PROTOCOLS,
  type OccupancyJoinProtocol,
  revokeOccupancyMembership,
} from "@deftai/directive-core/session";

export interface GrantArgs {
  projectRoot: string;
  sessionId?: string;
  childSessionId?: string;
  role?: string;
  worktree?: string;
  ttlMinutes?: number;
  host?: string;
  address?: string;
  joinProtocol?: OccupancyJoinProtocol;
  revoke: boolean;
  error?: string;
}

const VALUE_FLAGS = [
  "--project-root",
  "--session-id",
  "--child-session-id",
  "--role",
  "--worktree",
  "--ttl-minutes",
  "--host",
  "--address",
  "--join-protocol",
] as const;

type ValueFlag = (typeof VALUE_FLAGS)[number];

function readValue(
  argv: readonly string[],
  index: number,
  flag: ValueFlag,
): { value: string; next: number } | { error: string } {
  const arg = argv[index] ?? "";
  const inline = `${flag}=`;
  const raw = arg.startsWith(inline) ? arg.slice(inline.length) : argv[index + 1];
  if (raw === undefined || raw.startsWith("--")) {
    return { error: `argument ${flag}: expected one argument` };
  }
  const value = raw.trim();
  if (value.length === 0) {
    return { error: `argument ${flag}: expected a non-empty value` };
  }
  return { value, next: arg.startsWith(inline) ? index : index + 1 };
}

export function parseArgs(argv: readonly string[]): GrantArgs {
  const parsed: GrantArgs = { projectRoot: ".", revoke: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] ?? "";
    if (arg === "--revoke") continue;
    const flag = VALUE_FLAGS.find((name) => arg === name || arg.startsWith(`${name}=`));
    if (flag === undefined) {
      return {
        ...parsed,
        revoke: argv.includes("--revoke"),
        error: `unrecognized argument: ${arg}`,
      };
    }
    const read = readValue(argv, i, flag);
    if ("error" in read) return { ...parsed, revoke: argv.includes("--revoke"), error: read.error };
    i = read.next;
    switch (flag) {
      case "--project-root":
        parsed.projectRoot = read.value;
        break;
      case "--session-id":
        parsed.sessionId = read.value;
        break;
      case "--child-session-id":
        parsed.childSessionId = read.value;
        break;
      case "--role":
        parsed.role = read.value;
        break;
      case "--worktree":
        parsed.worktree = read.value;
        break;
      case "--host":
        parsed.host = read.value;
        break;
      case "--address":
        parsed.address = read.value;
        break;
      case "--ttl-minutes": {
        const minutes = Number(read.value);
        if (!Number.isFinite(minutes) || minutes <= 0) {
          return {
            ...parsed,
            revoke: argv.includes("--revoke"),
            error: "argument --ttl-minutes: expected a positive number of minutes",
          };
        }
        parsed.ttlMinutes = minutes;
        break;
      }
      case "--join-protocol": {
        if (!(OCCUPANCY_JOIN_PROTOCOLS as readonly string[]).includes(read.value)) {
          return {
            ...parsed,
            revoke: argv.includes("--revoke"),
            error: `argument --join-protocol: expected one of ${OCCUPANCY_JOIN_PROTOCOLS.join(", ")}`,
          };
        }
        parsed.joinProtocol = read.value as OccupancyJoinProtocol;
        break;
      }
    }
  }
  return { ...parsed, revoke: argv.includes("--revoke") };
}

export function run(argv: readonly string[]): number {
  const args = parseArgs(argv);
  if (args.error !== undefined) {
    process.stderr.write(`occupancy:grant: ${args.error}\n`);
    return 2;
  }
  const projectRoot = resolve(args.projectRoot);
  const input = {
    sessionId: args.sessionId,
    childSessionId: args.childSessionId,
    role: args.role,
    worktreePath: args.worktree,
    ttlMs: args.ttlMinutes === undefined ? undefined : args.ttlMinutes * 60 * 1000,
    host: args.host,
    address: args.address,
    joinProtocol: args.joinProtocol,
    env: process.env,
  };
  const result = args.revoke
    ? revokeOccupancyMembership(projectRoot, input)
    : grantOccupancyMembership(projectRoot, input);
  const sink = result.code === 0 ? process.stdout : process.stderr;
  sink.write(`${result.message}\n`);
  return result.code;
}
