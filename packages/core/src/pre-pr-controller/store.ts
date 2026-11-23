/**
 * Private pre-PR execution store (#4912 Limb 1).
 * Reuses the Directive App/operator private-store boundary with a distinct
 * execution record. Disk `.deft/pre-pr-controller` is not SoT.
 * Author-supplied run ids are lookup hints. Publisher credentials never
 * leave this module's factory.
 */

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, lstatSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  ContainedWriteError,
  ContainedWriteErrorCode,
  containedChmod,
  containedRemove,
  containedWrite,
} from "../fs/contained-write.js";
import {
  DISK_STORE_NOT_SOT,
  deny,
  PRE_PR_EXECUTION_SCHEMA,
  type PrePrDecision,
  type PrePrExecutionRecord,
  RUN_ID_LOOKUP_HINT,
} from "./types.js";

/** Controller-owned private store. Distinct from presented `.deft/pre-pr-controller`. */
export const PRE_PR_PRIVATE_STORE_DIR = "pre-pr-execution-private";
/** Store-local HMAC secret. Never the presented `.deft/pre-pr-controller` path. */
export const PRE_PR_STORE_MAC_SECRET_NAME = "hmac-secret";
export const PRE_PR_STORE_MAC_SCHEMA = "deft.pre-pr-store-mac.v1" as const;
export const PRE_PR_STORE_SECRET_MODE = Number.parseInt("384", 10);

export function privatePrePrStoreDir(projectRoot: string): string {
  return join(projectRoot, ".deft", PRE_PR_PRIVATE_STORE_DIR);
}

const PUBLISHER_BRAND = Symbol("deft.pre-pr.publisher");

export interface PrePrPublisher {
  readonly [PUBLISHER_BRAND]: true;
}

export interface PrePrExecutionStore {
  put(record: PrePrExecutionRecord): PrePrDecision;
  getById(id: string): PrePrExecutionRecord | null;
  getByPrNodeId(prNodeId: string): PrePrExecutionRecord | null;
  list(): readonly PrePrExecutionRecord[];
}

export class InProcessPrePrStore implements PrePrExecutionStore {
  private readonly records = new Map<string, PrePrExecutionRecord>();

  put(record: PrePrExecutionRecord): PrePrDecision {
    this.records.set(record.id, record);
    return { ok: true, code: "allow-pass", message: `stored ${record.id}` };
  }

  getById(id: string): PrePrExecutionRecord | null {
    return this.records.get(id) ?? null;
  }

  getByPrNodeId(prNodeId: string): PrePrExecutionRecord | null {
    return newestMatchingPrNode(this.list(), prNodeId);
  }

  list(): readonly PrePrExecutionRecord[] {
    return [...this.records.values()];
  }
}

export function prePrStoreRecordFileName(id: string): string {
  return `${Buffer.from(id, "utf8").toString("hex")}.json`;
}

/** Newest matching record by startedAt, then completedAt. */
export function prePrRecordIsNewer(a: PrePrExecutionRecord, b: PrePrExecutionRecord): boolean {
  const aStart = a.startedAt ?? "";
  const bStart = b.startedAt ?? "";
  if (aStart !== bStart) return aStart > bStart;
  const aDone = a.completedAt ?? "";
  const bDone = b.completedAt ?? "";
  return aDone > bDone;
}

function newestMatchingPrNode(
  records: readonly PrePrExecutionRecord[],
  prNodeId: string,
): PrePrExecutionRecord | null {
  const want = prNodeId.trim();
  if (want.length === 0) return null;
  let best: PrePrExecutionRecord | null = null;
  for (const rec of records) {
    if (rec.prNodeId !== want) continue;
    if (best === null || prePrRecordIsNewer(rec, best)) best = rec;
  }
  return best;
}

function isExclusiveCreateRace(err: unknown): boolean {
  if (err instanceof ContainedWriteError && err.code === ContainedWriteErrorCode.EXISTS) {
    return true;
  }
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as NodeJS.ErrnoException).code === "EEXIST"
  );
}

/** Unix HMAC secrets load only at 0600. Windows does not preserve POSIX mode bits. */
function hmacSecretModeIsPrivate(mode: number): boolean {
  if (process.platform === "win32") return true;
  return (mode & 0o777) === PRE_PR_STORE_SECRET_MODE;
}

function hmacHex(secret: Buffer, payload: string): string {
  return createHmac("sha256", secret).update(payload, "utf8").digest("hex");
}

function macMatches(secret: Buffer, payload: string, macHex: string): boolean {
  if (typeof macHex !== "string" || macHex.length === 0) return false;
  const expected = Buffer.from(hmacHex(secret, payload), "hex");
  let given: Buffer;
  try {
    given = Buffer.from(macHex, "hex");
  } catch {
    return false;
  }
  if (given.length !== expected.length || given.length === 0) return false;
  return timingSafeEqual(given, expected);
}

function asExecutionRecord(value: unknown): PrePrExecutionRecord | null {
  if (value === null || typeof value !== "object") return null;
  const rec = value as PrePrExecutionRecord;
  if (rec.schema !== PRE_PR_EXECUTION_SCHEMA) return null;
  if (typeof rec.id !== "string" || rec.id.length === 0) return null;
  return rec;
}

/**
 * Unsigned JSON is not a pass record. Envelope MAC must match the store secret.
 */
export function parseStoredRecord(raw: string, secret: Buffer): PrePrExecutionRecord | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object") return null;
    const envelope = parsed as {
      schema?: unknown;
      payload?: unknown;
      mac?: unknown;
    };
    if (envelope.schema === PRE_PR_EXECUTION_SCHEMA) return null;
    if (envelope.schema !== PRE_PR_STORE_MAC_SCHEMA) return null;
    if (typeof envelope.payload !== "string" || envelope.payload.length === 0) return null;
    if (typeof envelope.mac !== "string") return null;
    if (!macMatches(secret, envelope.payload, envelope.mac)) return null;
    return asExecutionRecord(JSON.parse(envelope.payload));
  } catch {
    return null;
  }
}

/**
 * Process-surviving private store. Path is `.deft/pre-pr-execution-private`,
 * never the agent-presented `.deft/pre-pr-controller` JSON (#4912 Limb 1).
 */
export class FileBackedPrePrStore implements PrePrExecutionStore {
  constructor(readonly projectRoot: string) {}

  private dir(): string {
    return privatePrePrStoreDir(this.projectRoot);
  }

  private recordPath(id: string): string {
    return join(this.dir(), prePrStoreRecordFileName(id));
  }

  private secretPath(): string {
    return join(this.dir(), PRE_PR_STORE_MAC_SECRET_NAME);
  }

  private loadSecret(): Buffer | null {
    const path = this.secretPath();
    if (!existsSync(path)) return null;
    try {
      const st = lstatSync(path);
      if (!st.isFile() || !hmacSecretModeIsPrivate(st.mode)) return null;
    } catch {
      return null;
    }
    const hex = readFileSync(path, "utf8").trim();
    if (hex.length === 0) return null;
    const buf = Buffer.from(hex, "hex");
    if (buf.length === 0) return null;
    return buf;
  }

  private loadOrCreateSecret(): Buffer | null {
    const existing = this.loadSecret();
    if (existing !== null) return existing;
    const root = resolve(this.projectRoot);
    const target = this.secretPath();
    try {
      containedWrite({
        root,
        target,
        data: `${randomBytes(32).toString("hex")}\n`,
        mode: "create",
      });
    } catch (err) {
      if (isExclusiveCreateRace(err)) {
        // EXISTS race: do not delete the winner. Load only at 0600.
        return this.loadSecret();
      }
      return null;
    }
    // This process created the secret; no records are signed yet.
    try {
      containedChmod({ root, target, mode: PRE_PR_STORE_SECRET_MODE });
    } catch {
      try {
        containedChmod({ root, target, mode: PRE_PR_STORE_SECRET_MODE });
      } catch {
        /* retry exhausted */
      }
    }
    const loaded = this.loadSecret();
    if (loaded !== null) return loaded;
    try {
      containedRemove({ root, target });
    } catch {
      /* leftover unusable 0644; next start can exclusive-create */
    }
    return null;
  }

  put(record: PrePrExecutionRecord): PrePrDecision {
    const root = resolve(this.projectRoot);
    const secret = this.loadOrCreateSecret();
    if (secret === null) {
      return deny("deny-missing-record", "pre-PR private store HMAC secret could not be created");
    }
    const payload = JSON.stringify(record);
    const envelope = JSON.stringify({
      schema: PRE_PR_STORE_MAC_SCHEMA,
      payload,
      mac: hmacHex(secret, payload),
    });
    containedWrite({
      root,
      target: this.recordPath(record.id),
      data: `${envelope}\n`,
      mode: "replace",
    });
    return { ok: true, code: "allow-pass", message: `stored ${record.id}` };
  }

  getById(id: string): PrePrExecutionRecord | null {
    const path = this.recordPath(id);
    if (!existsSync(path)) return null;
    const secret = this.loadSecret();
    if (secret === null) return null;
    return parseStoredRecord(readFileSync(path, "utf8"), secret);
  }

  getByPrNodeId(prNodeId: string): PrePrExecutionRecord | null {
    return newestMatchingPrNode(this.list(), prNodeId);
  }

  list(): readonly PrePrExecutionRecord[] {
    const dir = this.dir();
    if (!existsSync(dir)) return [];
    const secret = this.loadSecret();
    if (secret === null) return [];
    const out: PrePrExecutionRecord[] = [];
    for (const name of readdirSync(dir)) {
      if (!name.endsWith(".json")) continue;
      const rec = parseStoredRecord(readFileSync(join(dir, name), "utf8"), secret);
      if (rec !== null) out.push(rec);
    }
    return out;
  }
}

/**
 * #6902: one cached file-backed store, keyed by the absolute root resolved at
 * call time and built from that same absolute root. An injected store
 * (set/reset) wins for any root until {@link clearDefaultPrePrStore}.
 */
let cachedStore: { readonly root: string; readonly store: PrePrExecutionStore } | null = null;
let injectedStore: PrePrExecutionStore | null = null;

export function getDefaultPrePrStore(projectRoot: string = process.cwd()): PrePrExecutionStore {
  if (injectedStore !== null) return injectedStore;
  const root = resolve(projectRoot);
  if (cachedStore === null || cachedStore.root !== root) {
    cachedStore = { root, store: new FileBackedPrePrStore(root) };
  }
  return cachedStore.store;
}

export function setDefaultPrePrStore(store: PrePrExecutionStore): void {
  injectedStore = store;
}

export function resetDefaultPrePrStore(): InProcessPrePrStore {
  const next = new InProcessPrePrStore();
  injectedStore = next;
  return next;
}

/** Drop the cached root-keyed store and any injected test store (#6902). */
export function clearDefaultPrePrStore(): void {
  cachedStore = null;
  injectedStore = null;
}

/**
 * Publisher factory. Implementing-agent APIs never receive this object.
 * Tests and the controller complete path hold it.
 */
export function mintPublisher(): PrePrPublisher {
  return { [PUBLISHER_BRAND]: true };
}

export function isPublisher(value: unknown): value is PrePrPublisher {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { [PUBLISHER_BRAND]?: unknown })[PUBLISHER_BRAND] === true
  );
}

export function requirePublisher(value: unknown): PrePrDecision {
  if (isPublisher(value)) {
    return { ok: true, code: "allow-pass", message: "publisher present" };
  }
  return deny(
    "deny-publisher-required",
    "passing pre-PR records require controller publisher credentials",
  );
}

export function opaqueRunId(explicit?: string): string {
  const given = explicit?.trim() ?? "";
  if (given.length > 0) return given;
  return `ppr_${randomBytes(8).toString("hex")}`;
}

export function resolveRecordFromStore(
  store: PrePrExecutionStore,
  input: { readonly id?: string | null; readonly prNodeId?: string | null },
): PrePrExecutionRecord | null {
  const id = input.id?.trim() ?? "";
  if (id.length > 0) {
    const byId = store.getById(id);
    if (byId !== null) return byId;
  }
  const node = input.prNodeId?.trim() ?? "";
  if (node.length > 0) return store.getByPrNodeId(node);
  return null;
}

export function loadPrePrRecord(
  _projectRoot: string,
  runId: string,
  store: PrePrExecutionStore = getDefaultPrePrStore(),
): PrePrExecutionRecord | null {
  return store.getById(runId);
}

export function writePrePrRecordDisk(
  _projectRoot: string,
  _record: PrePrExecutionRecord,
): PrePrDecision {
  return deny("deny-disk-not-sot", DISK_STORE_NOT_SOT);
}

export function prePrDir(_projectRoot: string): PrePrDecision {
  return deny("deny-disk-not-sot", DISK_STORE_NOT_SOT);
}

export { RUN_ID_LOOKUP_HINT };
