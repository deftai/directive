#!/usr/bin/env node
/**
 * Parent write surface for deft.subagent.steer.v1 (#5278 / #4286).
 * Wraps writeSteer so status steers are reachable before pre-cancel.
 * Writer authority is checked against child occupancy / heartbeat — not self-attested.
 */
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  defaultSteerDir,
  isSafeAgentId,
  STEER_KINDS,
  STEER_WRITER_KINDS,
  type SteerKind,
  type SteerWriterKind,
  writeSteer,
} from "@deftai/directive-core/orchestration";
import { liveOccupant, readChildOccupancyLease } from "@deftai/directive-core/session";

export const EXIT_STEER_WRITE_OK = 0 * 1;
export const EXIT_STEER_WRITE_CONFIG = 2 * 1;

export const SUBAGENT_STEER_WRITE_HELP = `subagent:steer — write a closed parent-steer inbox (#5278 / #4286)

Usage:
  task subagent:steer -- --agent <id> --writer-id <id> --kind <kind> --text <text> [options]

Options:
  --agent ID              Child agent_id (inbox file stem)
  --writer-id ID          Writer identity (must match independent parent/owner record)
  --writer-kind KIND      occupancy-owner | dispatching-parent (default: dispatching-parent)
  --kind KIND             constraint | correction | halt | note
  --text TEXT             Steer body (≤2000 chars)
  --steer-id ID           Optional stable steer id (default: uuid)
  --ttl-seconds N         Expiry TTL (default: 1800)
  --target-id PATH        Worktree root for dest inbox
  --steer-dir PATH        Inbox directory override
  --scratch-dir PATH      Heartbeat dir (not used for writer authority)
  --parent-id ID          Must match child occupancy lease parentId
  --occupancy-owner-id ID Must match live occupancy session under --target-id
  --json                  Emit written record

Exit codes:
  0  Wrote inbox
  2  Config / validation error
`;

export interface SubagentSteerWriteArgs {
  agentId: string | null;
  writerId: string | null;
  writerKind: SteerWriterKind;
  kind: SteerKind | null;
  text: string | null;
  steerId: string | null;
  ttlSeconds: number | null;
  targetId: string | null;
  steerDir: string | null;
  scratchDir: string | null;
  parentId: string | null;
  occupancyOwnerId: string | null;
  emitJson: boolean;
  help: boolean;
  error?: string;
}

/**
 * Resolve parent/owner from dispatcher-recorded child occupancy + live occupancy.
 * Heartbeat alone is never authority (caller-selected --scratch-dir cannot mint parent_id).
 */
export function resolveIndependentSteerAuthority(input: {
  root: string;
  agentId: string;
  writerKind: SteerWriterKind;
  writerId: string;
  claimedParentId?: string | null;
  claimedOccupancyOwnerId?: string | null;
}): { parentId?: string; occupancyOwnerId?: string; error?: string } {
  const writerId = input.writerId.trim();
  const lease = readChildOccupancyLease(input.root, input.agentId);
  const occupancy = liveOccupant(input.root);

  if (input.writerKind === "dispatching-parent") {
    const expected = (lease?.parentId ?? "").trim();
    if (expected.length === 0) {
      return {
        error:
          "dispatching-parent requires child occupancy lease parentId under --target-id (heartbeat alone is not authority)",
      };
    }
    if (writerId !== expected) {
      return {
        error: `dispatching-parent writer_id ${JSON.stringify(writerId)} does not match child occupancy parent ${JSON.stringify(expected)}`,
      };
    }
    const claimed = input.claimedParentId?.trim() ?? "";
    if (claimed.length > 0 && claimed !== expected) {
      return {
        error: `--parent-id ${JSON.stringify(claimed)} does not match child occupancy parent ${JSON.stringify(expected)}`,
      };
    }
    return { parentId: expected };
  }

  // occupancy-owner: liveOccupant (TTL/age-cap) is SoT; expired/stale leases refuse.
  const liveOwner = (occupancy?.sessionId ?? "").trim();
  if (liveOwner.length === 0) {
    return {
      error: "occupancy-owner requires a live (non-expired) occupancy session under --target-id",
    };
  }
  const leaseOwner = (lease?.occupancyOwner ?? "").trim();
  if (leaseOwner.length > 0 && leaseOwner !== liveOwner) {
    return {
      error: `child occupancy owner ${JSON.stringify(leaseOwner)} is superseded by live occupancy ${JSON.stringify(liveOwner)}`,
    };
  }
  if (writerId !== liveOwner) {
    return {
      error: `occupancy-owner writer_id ${JSON.stringify(writerId)} does not match live occupancy ${JSON.stringify(liveOwner)}`,
    };
  }
  const claimedOwner = input.claimedOccupancyOwnerId?.trim() ?? "";
  if (claimedOwner.length > 0 && claimedOwner !== liveOwner) {
    return {
      error: `--occupancy-owner-id ${JSON.stringify(claimedOwner)} does not match live occupancy ${JSON.stringify(liveOwner)}`,
    };
  }
  return { occupancyOwnerId: liveOwner };
}

export function parseSubagentSteerWriteArgs(argv: readonly string[]): SubagentSteerWriteArgs {
  const acc: SubagentSteerWriteArgs = {
    agentId: null,
    writerId: null,
    writerKind: "dispatching-parent",
    kind: null,
    text: null,
    steerId: null,
    ttlSeconds: null,
    targetId: null,
    steerDir: null,
    scratchDir: null,
    parentId: null,
    occupancyOwnerId: null,
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
    } else if (arg === "--agent" || arg === "--agent-id") {
      const value = argv[i + 1];
      if (value === undefined) return { ...acc, error: `argument ${arg}: expected one argument` };
      acc.agentId = value;
      i += 1;
    } else if (arg?.startsWith("--agent=") || arg?.startsWith("--agent-id=")) {
      acc.agentId = arg.slice(arg.indexOf("=") + 1);
    } else if (arg === "--writer-id") {
      const value = argv[i + 1];
      if (value === undefined)
        return { ...acc, error: "argument --writer-id: expected one argument" };
      acc.writerId = value;
      i += 1;
    } else if (arg?.startsWith("--writer-id=")) {
      acc.writerId = arg.slice("--writer-id=".length);
    } else if (arg === "--writer-kind") {
      const value = argv[i + 1];
      if (value === undefined)
        return { ...acc, error: "argument --writer-kind: expected one argument" };
      if (!(STEER_WRITER_KINDS as readonly string[]).includes(value)) {
        return { ...acc, error: `writer-kind must be one of ${STEER_WRITER_KINDS.join(", ")}` };
      }
      acc.writerKind = value as SteerWriterKind;
      i += 1;
    } else if (arg?.startsWith("--writer-kind=")) {
      const value = arg.slice("--writer-kind=".length);
      if (!(STEER_WRITER_KINDS as readonly string[]).includes(value)) {
        return { ...acc, error: `writer-kind must be one of ${STEER_WRITER_KINDS.join(", ")}` };
      }
      acc.writerKind = value as SteerWriterKind;
    } else if (arg === "--kind") {
      const value = argv[i + 1];
      if (value === undefined) return { ...acc, error: "argument --kind: expected one argument" };
      if (!(STEER_KINDS as readonly string[]).includes(value)) {
        return { ...acc, error: `kind must be one of ${STEER_KINDS.join(", ")}` };
      }
      acc.kind = value as SteerKind;
      i += 1;
    } else if (arg?.startsWith("--kind=")) {
      const value = arg.slice("--kind=".length);
      if (!(STEER_KINDS as readonly string[]).includes(value)) {
        return { ...acc, error: `kind must be one of ${STEER_KINDS.join(", ")}` };
      }
      acc.kind = value as SteerKind;
    } else if (arg === "--text") {
      const value = argv[i + 1];
      if (value === undefined) return { ...acc, error: "argument --text: expected one argument" };
      acc.text = value;
      i += 1;
    } else if (arg?.startsWith("--text=")) {
      acc.text = arg.slice("--text=".length);
    } else if (arg === "--steer-id") {
      const value = argv[i + 1];
      if (value === undefined)
        return { ...acc, error: "argument --steer-id: expected one argument" };
      acc.steerId = value;
      i += 1;
    } else if (arg?.startsWith("--steer-id=")) {
      acc.steerId = arg.slice("--steer-id=".length);
    } else if (arg === "--ttl-seconds") {
      const value = argv[i + 1];
      if (value === undefined)
        return { ...acc, error: "argument --ttl-seconds: expected one argument" };
      acc.ttlSeconds = Number(value);
      i += 1;
    } else if (arg?.startsWith("--ttl-seconds=")) {
      acc.ttlSeconds = Number(arg.slice("--ttl-seconds=".length));
    } else if (arg === "--target-id" || arg === "--target") {
      const value = argv[i + 1];
      if (value === undefined) return { ...acc, error: `argument ${arg}: expected one argument` };
      acc.targetId = value;
      i += 1;
    } else if (arg?.startsWith("--target-id=") || arg?.startsWith("--target=")) {
      acc.targetId = arg.slice(arg.indexOf("=") + 1);
    } else if (arg === "--steer-dir") {
      const value = argv[i + 1];
      if (value === undefined)
        return { ...acc, error: "argument --steer-dir: expected one argument" };
      acc.steerDir = value;
      i += 1;
    } else if (arg?.startsWith("--steer-dir=")) {
      acc.steerDir = arg.slice("--steer-dir=".length);
    } else if (arg === "--scratch-dir") {
      const value = argv[i + 1];
      if (value === undefined)
        return { ...acc, error: "argument --scratch-dir: expected one argument" };
      acc.scratchDir = value;
      i += 1;
    } else if (arg?.startsWith("--scratch-dir=")) {
      acc.scratchDir = arg.slice("--scratch-dir=".length);
    } else if (arg === "--parent-id") {
      const value = argv[i + 1];
      if (value === undefined)
        return { ...acc, error: "argument --parent-id: expected one argument" };
      acc.parentId = value;
      i += 1;
    } else if (arg?.startsWith("--parent-id=")) {
      acc.parentId = arg.slice("--parent-id=".length);
    } else if (arg === "--occupancy-owner-id") {
      const value = argv[i + 1];
      if (value === undefined) {
        return { ...acc, error: "argument --occupancy-owner-id: expected one argument" };
      }
      acc.occupancyOwnerId = value;
      i += 1;
    } else if (arg?.startsWith("--occupancy-owner-id=")) {
      acc.occupancyOwnerId = arg.slice("--occupancy-owner-id=".length);
    } else if (arg?.startsWith("-")) {
      return { ...acc, error: `unrecognized argument: ${arg}` };
    } else {
      return { ...acc, error: `unrecognized argument: ${arg}` };
    }
  }

  return acc;
}

export function run(argv: readonly string[], cwd: string = process.cwd()): number {
  const args = parseSubagentSteerWriteArgs(argv);
  if (args.help) {
    process.stdout.write(SUBAGENT_STEER_WRITE_HELP);
    return EXIT_STEER_WRITE_OK;
  }
  if (args.error !== undefined) {
    process.stderr.write(`subagent:steer: ${args.error}\n`);
    return EXIT_STEER_WRITE_CONFIG;
  }
  if (args.agentId === null || !isSafeAgentId(args.agentId)) {
    process.stderr.write(
      "subagent:steer: --agent is required and must be a filesystem-safe slug\n",
    );
    return EXIT_STEER_WRITE_CONFIG;
  }
  if (args.writerId === null || args.writerId.trim().length === 0) {
    process.stderr.write("subagent:steer: --writer-id is required\n");
    return EXIT_STEER_WRITE_CONFIG;
  }
  if (args.kind === null) {
    process.stderr.write(`subagent:steer: --kind is required (${STEER_KINDS.join("|")})\n`);
    return EXIT_STEER_WRITE_CONFIG;
  }
  if (args.text === null || args.text.trim().length === 0) {
    process.stderr.write("subagent:steer: --text is required\n");
    return EXIT_STEER_WRITE_CONFIG;
  }
  if (args.ttlSeconds !== null && (!Number.isFinite(args.ttlSeconds) || args.ttlSeconds <= 0)) {
    process.stderr.write("subagent:steer: --ttl-seconds must be positive\n");
    return EXIT_STEER_WRITE_CONFIG;
  }

  const root =
    args.targetId !== null && args.targetId.trim().length > 0 ? resolve(cwd, args.targetId) : cwd;
  const steerDir = resolve(root, args.steerDir ?? defaultSteerDir(root));
  const writerId = args.writerId.trim();

  const authority = resolveIndependentSteerAuthority({
    root,
    agentId: args.agentId,
    writerKind: args.writerKind,
    writerId,
    claimedParentId: args.parentId,
    claimedOccupancyOwnerId: args.occupancyOwnerId,
  });
  if (authority.error !== undefined) {
    process.stderr.write(`subagent:steer: ${authority.error}\n`);
    return EXIT_STEER_WRITE_CONFIG;
  }

  try {
    const record = writeSteer(steerDir, {
      agentId: args.agentId,
      writerKind: args.writerKind,
      writerId,
      kind: args.kind,
      text: args.text,
      steerId: args.steerId ?? undefined,
      ttlSeconds: args.ttlSeconds ?? undefined,
      parentId: authority.parentId,
      occupancyOwnerId: authority.occupancyOwnerId,
    });
    if (args.emitJson) {
      process.stdout.write(`${JSON.stringify(record, null, 2)}\n`);
    } else {
      process.stdout.write(
        `subagent:steer: wrote ${record.agent_id} steer_id=${record.steer_id} kind=${record.kind}\n`,
      );
    }
    return EXIT_STEER_WRITE_OK;
  } catch (err: unknown) {
    process.stderr.write(`subagent:steer: ${String((err as Error).message ?? err)}\n`);
    return EXIT_STEER_WRITE_CONFIG;
  }
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exit(run(process.argv.slice(2)));
}
