import { randomBytes } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Default event log location (project-local). */
export const DEFAULT_EVENT_LOG = join(".deft-cache", "events.jsonl");

const BEHAVIORAL_CATEGORY = "behavioral";

const REQUIRED_BEHAVIORAL_PAYLOAD: Readonly<Record<string, readonly string[]>> = {
  "session:interrupted": ["session_id", "reason"],
  "session:resumed": ["session_id", "interrupted_id"],
  "plan:approved": ["plan_ref", "approver"],
  "legacy:detected": ["title", "source", "range", "size_bytes"],
};

let behavioralRegistryCache: {
  names: ReadonlySet<string>;
  required: Readonly<Record<string, readonly string[]>>;
} | null = null;

function defaultRegistryPath(): string {
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
  return join(repoRoot, "events", "registry.json");
}

function loadBehavioralRegistry(): {
  names: ReadonlySet<string>;
  required: Readonly<Record<string, readonly string[]>>;
} {
  if (behavioralRegistryCache !== null) {
    return behavioralRegistryCache;
  }
  const data = JSON.parse(readFileSync(defaultRegistryPath(), "utf8")) as Record<string, unknown>;
  const events = data.events;
  const behavioralNames = new Set<string>();
  if (Array.isArray(events)) {
    for (const event of events) {
      if (
        typeof event === "object" &&
        event !== null &&
        !Array.isArray(event) &&
        (event as Record<string, unknown>).category === BEHAVIORAL_CATEGORY
      ) {
        const name = (event as Record<string, unknown>).name;
        if (typeof name === "string") {
          behavioralNames.add(name);
        }
      }
    }
  }
  behavioralRegistryCache = {
    names: behavioralNames,
    required: REQUIRED_BEHAVIORAL_PAYLOAD,
  };
  return behavioralRegistryCache;
}

function registeredBehavioralNames(): ReadonlySet<string> {
  return loadBehavioralRegistry().names;
}

function requiredPayloadMap(): Readonly<Record<string, readonly string[]>> {
  return loadBehavioralRegistry().required;
}

/** Reset the in-process registry cache. Used by tests. */
export function clearRegistryCache(): void {
  behavioralRegistryCache = null;
}

class LazyKnownEvents {
  private resolved(): ReadonlySet<string> {
    return registeredBehavioralNames();
  }

  has(item: unknown): boolean {
    return this.resolved().has(item as string);
  }

  [Symbol.iterator](): Iterator<string> {
    return this.resolved()[Symbol.iterator]() as Iterator<string>;
  }

  get size(): number {
    return this.resolved().size;
  }

  equals(other: unknown): boolean {
    if (!(other instanceof Set) && !(other instanceof LazyKnownEvents)) {
      return false;
    }
    const left = [...this.resolved()].sort();
    const right =
      other instanceof LazyKnownEvents ? [...other.resolved()].sort() : [...other].sort();
    return left.length === right.length && left.every((v, i) => v === right[i]);
  }
}

class LazyRequiredPayload {
  private resolved(): Readonly<Record<string, readonly string[]>> {
    return requiredPayloadMap();
  }

  has(item: unknown): boolean {
    if (typeof item !== "string") {
      return false;
    }
    return Object.hasOwn(this.resolved(), item);
  }

  get(key: string): readonly string[] {
    return this.resolved()[key] ?? [];
  }

  entries(): [string, readonly string[]][] {
    return Object.entries(this.resolved());
  }

  keys(): string[] {
    return Object.keys(this.resolved());
  }

  values(): readonly (readonly string[])[] {
    return Object.values(this.resolved());
  }

  get size(): number {
    return Object.keys(this.resolved()).length;
  }
}

/** Lazy proxy for behavioral event names from the unified registry. */
export const KNOWN_EVENTS = new LazyKnownEvents();

/** Lazy proxy for per-event required payload fields. */
export const REQUIRED_PAYLOAD = new LazyRequiredPayload();

function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortKeysDeep);
  }
  if (value !== null && typeof value === "object") {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      sorted[key] = sortKeysDeep((value as Record<string, unknown>)[key]);
    }
    return sorted;
  }
  return value;
}

function jsonStringifySorted(value: unknown): string {
  return JSON.stringify(sortKeysDeep(value));
}

function resolveLogPath(logPath?: string | null): string {
  if (logPath !== undefined && logPath !== null) {
    return resolve(logPath);
  }
  const envPath = process.env.DEFT_EVENT_LOG;
  if (envPath !== undefined && envPath.length > 0) {
    return resolve(envPath);
  }
  return resolve(DEFAULT_EVENT_LOG);
}

function newEventId(): string {
  const wallNs = BigInt(Date.now()) * 1_000_000n;
  return `${wallNs}-${randomBytes(4).toString("hex")}`;
}

export interface BehavioralEventRecord {
  readonly event: string;
  readonly id: string;
  readonly detected_at: string;
  readonly payload: Record<string, unknown>;
}

/** Append a behavioral event record to the JSONL log and return it. */
export function emit(
  name: string,
  payload: Record<string, unknown>,
  options: { logPath?: string | null; detectedAt?: string | null } = {},
): BehavioralEventRecord {
  const behavioralNames = registeredBehavioralNames();
  if (!behavioralNames.has(name)) {
    throw new Error(
      `unknown event '${name}'; expected one of ${[...behavioralNames]
        .sort()
        .map((n) => `'${n}'`)
        .join(", ")}`,
    );
  }
  const required = requiredPayloadMap()[name] ?? [];
  const missing = required.filter((key) => !(key in payload));
  if (missing.length > 0) {
    throw new Error(`event '${name}' payload missing required fields: ${JSON.stringify(missing)}`);
  }

  const iso = new Date().toISOString();
  const record: BehavioralEventRecord = {
    event: name,
    id: newEventId(),
    detected_at: options.detectedAt ?? `${iso.slice(0, 19)}Z`,
    payload: { ...payload },
  };

  const target = resolveLogPath(options.logPath);
  mkdirSync(dirname(target), { recursive: true });
  appendFileSync(target, `${jsonStringifySorted(record)}\n`, "utf8");
  return record;
}

/** Return all events from the log in emission order. */
export function readEvents(logPath?: string | null): BehavioralEventRecord[] {
  const target = resolveLogPath(logPath);
  if (!existsSync(target)) {
    return [];
  }
  const out: BehavioralEventRecord[] = [];
  const text = readFileSync(target, "utf8");
  for (const line of text.split(/\r?\n/)) {
    const stripped = line.trim();
    if (stripped.length === 0) {
      continue;
    }
    try {
      out.push(JSON.parse(stripped) as BehavioralEventRecord);
    } catch {}
  }
  return out;
}

/** Return orphan session:resumed records. */
export function validatePairing(
  events?: readonly BehavioralEventRecord[] | null,
  options: { logPath?: string | null } = {},
): BehavioralEventRecord[] {
  const stream = events ?? readEvents(options.logPath);
  const openInterrupts = new Set<string>();
  const orphans: BehavioralEventRecord[] = [];
  for (const record of stream) {
    if (record.event === "session:interrupted") {
      if (typeof record.id === "string") {
        openInterrupts.add(record.id);
      }
    } else if (record.event === "session:resumed") {
      const ref = record.payload?.interrupted_id;
      if (typeof ref === "string" && openInterrupts.has(ref)) {
        openInterrupts.delete(ref);
      } else {
        orphans.push(record);
      }
    }
  }
  return orphans;
}

interface ParsedEmitArgs {
  readonly name?: string;
  readonly payload: Record<string, unknown>;
  readonly log?: string;
}

function parseBooleanFlag(value: string): boolean {
  return ["1", "true", "yes"].includes(value.toLowerCase());
}

function parseEmitArgs(args: readonly string[]): ParsedEmitArgs {
  const payload: Record<string, unknown> = {};
  let name: string | undefined;
  let log: string | undefined;
  let i = 0;
  if (args.length > 0 && !args[0]?.startsWith("--")) {
    name = args[0];
    i = 1;
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
      "--session-id": "session_id",
      "--reason": "reason",
      "--interrupted-id": "interrupted_id",
      "--plan-ref": "plan_ref",
      "--approver": "approver",
      "--approval-phrase": "approval_phrase",
      "--detail": "detail",
      "--title": "title",
      "--source": "source",
      "--range": "range",
      "--sidecar": "sidecar",
    };
    if (arg === "--pr-number") {
      payload.pr_number = Number.parseInt(args[i + 1] ?? "", 10);
      i += 2;
      continue;
    }
    if (arg === "--size-bytes") {
      payload.size_bytes = Number.parseInt(args[i + 1] ?? "", 10);
      i += 2;
      continue;
    }
    if (arg === "--inline") {
      payload.inline = parseBooleanFlag(args[i + 1] ?? "");
      i += 2;
      continue;
    }
    if (arg === "--flagged") {
      payload.flagged = parseBooleanFlag(args[i + 1] ?? "");
      i += 2;
      continue;
    }
    const field = flagMap[arg ?? ""];
    if (field !== undefined) {
      payload[field] = args[i + 1];
      i += 2;
      continue;
    }
    throw new Error(`unrecognized arguments: ${arg}`);
  }
  return { name, payload, log };
}

/** CLI entrypoint mirroring scripts/_events.py. */
export function main(argv: readonly string[] = process.argv.slice(2)): number {
  if (argv.length === 0) {
    process.stderr.write("usage: events emit|list|validate-pairing ...\n");
    return 2;
  }
  const cmd = argv[0];
  const rest = argv.slice(1);

  if (cmd === "emit") {
    try {
      const parsed = parseEmitArgs(rest);
      if (parsed.name === undefined) {
        process.stderr.write("emit failed: event name required\n");
        return 2;
      }
      const record = emit(parsed.name, parsed.payload, { logPath: parsed.log ?? null });
      process.stdout.write(`${JSON.stringify(record)}\n`);
      return 0;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`emit failed: ${message}\n`);
      return 2;
    }
  }

  if (cmd === "list") {
    let log: string | undefined;
    for (let i = 0; i < rest.length; i += 1) {
      if (rest[i] === "--log") {
        log = rest[i + 1];
      }
    }
    for (const record of readEvents(log ?? null)) {
      process.stdout.write(`${jsonStringifySorted(record)}\n`);
    }
    return 0;
  }

  if (cmd === "validate-pairing") {
    let log: string | undefined;
    for (let i = 0; i < rest.length; i += 1) {
      if (rest[i] === "--log") {
        log = rest[i + 1];
      }
    }
    const orphans = validatePairing(null, { logPath: log ?? null });
    if (orphans.length > 0) {
      const ids = orphans.map((r) => r.id);
      process.stderr.write(
        `orphan session:resumed records (${orphans.length}): ${JSON.stringify(ids)}\n`,
      );
      return 1;
    }
    process.stdout.write("ok\n");
    return 0;
  }

  process.stderr.write("usage: events emit|list|validate-pairing ...\n");
  return 2;
}
