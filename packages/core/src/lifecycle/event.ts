import { resolve } from "node:path";
import { type BehavioralEventRecord, emit, main as eventsMain, readEvents } from "./events.js";

const APPROVAL_PHRASES = new Set(["yes", "confirmed", "approve", "other"]);

function parseBooleanFlag(value: string): boolean {
  return ["1", "true", "yes"].includes(value.toLowerCase());
}

interface ParsedEmitInvocation {
  readonly name: string;
  readonly payload: Record<string, unknown>;
  readonly log?: string;
}

function repositoryFromPlanRef(planRef: string): string | undefined {
  const match = /^https?:\/\/github\.com\/([^/]+\/[^/]+)\/pull\/\d+/i.exec(planRef.trim());
  return match?.[1];
}

function dedupeKey(payload: Record<string, unknown>): string | null {
  const planRef = payload.plan_ref;
  const approver = payload.approver;
  if (typeof planRef !== "string" || typeof approver !== "string") {
    return null;
  }
  const parts = [planRef, approver];
  if (typeof payload.pr_number === "number") {
    parts.push(String(payload.pr_number));
  }
  if (typeof payload.head_sha === "string" && payload.head_sha.length > 0) {
    parts.push(payload.head_sha);
  }
  return parts.join("|");
}

function findExistingPlanApproved(
  key: string,
  logPath?: string | null,
): BehavioralEventRecord | null {
  for (const record of readEvents(logPath)) {
    if (record.event !== "plan:approved") {
      continue;
    }
    if (dedupeKey(record.payload) === key) {
      return record;
    }
  }
  return null;
}

function validatePlanApprovedPayload(payload: Record<string, unknown>): void {
  const phrase = payload.approval_phrase;
  if (phrase === undefined) {
    return;
  }
  if (typeof phrase !== "string") {
    throw new Error("approval_phrase must be a string");
  }
  const normalized = phrase.toLowerCase();
  if (!APPROVAL_PHRASES.has(normalized)) {
    throw new Error(
      `invalid approval_phrase '${phrase}'; expected one of yes, confirmed, approve, other`,
    );
  }
}

/** Parse `emit <event> ...` argv for lifecycle:event approval recording. */
export function parseEmitInvocation(args: readonly string[]): ParsedEmitInvocation {
  const payload: Record<string, unknown> = {};
  let name: string | undefined;
  let log: string | undefined;
  let i = 0;
  if (args.length > 0 && !args[0]?.startsWith("--")) {
    name = args[0];
    i = 1;
  }
  if (name === undefined) {
    throw new Error("event name required");
  }
  while (i < args.length) {
    const arg = args[i];
    if (arg === "--payload") {
      const raw = args[i + 1];
      if (raw === undefined) {
        throw new Error("--payload requires a value");
      }
      const data = JSON.parse(raw) as unknown;
      if (typeof data !== "object" || data === null || Array.isArray(data)) {
        throw new Error("--payload must be a JSON object");
      }
      Object.assign(payload, data);
      i += 2;
      continue;
    }
    if (arg === "--log") {
      log = args[i + 1];
      i += 2;
      continue;
    }
    const flagMap: Record<string, string> = {
      "--plan-ref": "plan_ref",
      "--approver": "approver",
      "--approval-phrase": "approval_phrase",
      "--head-sha": "head_sha",
    };
    if (arg === "--pr-number") {
      payload.pr_number = Number.parseInt(args[i + 1] ?? "", 10);
      i += 2;
      continue;
    }
    const field = flagMap[arg ?? ""];
    if (field !== undefined) {
      payload[field] = args[i + 1];
      i += 2;
      continue;
    }
    if (arg === "--inline") {
      payload.inline = parseBooleanFlag(args[i + 1] ?? "");
      i += 2;
      continue;
    }
    throw new Error(`unrecognized arguments: ${arg}`);
  }
  return { name, payload, log };
}

function enrichPlanApprovedPayload(payload: Record<string, unknown>): Record<string, unknown> {
  const next = { ...payload };
  if (typeof next.plan_ref === "string" && next.repository === undefined) {
    const repository = repositoryFromPlanRef(next.plan_ref);
    if (repository !== undefined) {
      next.repository = repository;
    }
  }
  return next;
}

function emitPlanApprovedIdempotent(
  payload: Record<string, unknown>,
  options: { logPath?: string | null } = {},
): BehavioralEventRecord {
  const enriched = enrichPlanApprovedPayload(payload);
  validatePlanApprovedPayload(enriched);
  const key = dedupeKey(enriched);
  if (key !== null) {
    const existing = findExistingPlanApproved(key, options.logPath ?? null);
    if (existing !== null) {
      return existing;
    }
  }
  return emit("plan:approved", enriched, options);
}

/** CLI entry for `lifecycle:event` / review-cycle approval recorder (#2631). */
export function runLifecycleEvent(
  argv: readonly string[],
  options: { projectRoot?: string } = {},
): number {
  if (options.projectRoot !== undefined) {
    process.chdir(resolve(options.projectRoot));
  }
  if (argv.length === 0 || argv[0] === "-h" || argv[0] === "--help" || argv[0] === "help") {
    process.stderr.write(
      "usage: lifecycle:event emit plan:approved --plan-ref <url> --approver <login> " +
        "[--approval-phrase yes|confirmed|approve] [--pr-number N] [--head-sha SHA]\n",
    );
    return argv.length === 0 ? 2 : 0;
  }
  if (argv[0] !== "emit") {
    return eventsMain(argv);
  }
  if (argv[1] !== "plan:approved") {
    return eventsMain(argv);
  }
  try {
    const parsed = parseEmitInvocation(argv.slice(1));
    const record = emitPlanApprovedIdempotent(parsed.payload, { logPath: parsed.log ?? null });
    process.stdout.write(`${JSON.stringify(record)}\n`);
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`lifecycle:event failed: ${message}\n`);
    return 2;
  }
}

/** Process entrypoint mirroring other lifecycle CLI modules. */
export function main(argv: readonly string[] = process.argv.slice(2)): number {
  return runLifecycleEvent(argv);
}
