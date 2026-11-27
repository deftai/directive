import { createHash } from "node:crypto";
import type { AgentHookInspection } from "../init-deposit/agent-hooks.js";
import type { LockDeps } from "../slice/lock.js";
import type { AgentHookCommandIdentity } from "../verify-env/agent-hooks-live-probe.js";
import { mutateRitualStateLocked } from "./ritual-sentinel.js";
import { resolveSessionRitualStalenessHours } from "./staleness.js";

/**
 * Per-host `agent_hooks` ritual entries and the one-timeout allowance (#7416).
 *
 * A timeout proves neither a broken nor a working hook. One timeout on the applying host is
 * admitted, with a warning, only right after a `functional` result on the same hook command
 * and registration. Any newer non-functional, unavailable or structural result closes the
 * allowance until a new `functional` result, and taking it is one step inside the ritual lock.
 */

const MS_PER_HOUR = 60 * 60 * 1000;

export type AgentHookHostStatus =
  | "functional"
  | "non-functional"
  | "unavailable"
  | "timed-out"
  | "structural";

const HOST_STATUSES: readonly AgentHookHostStatus[] = [
  "functional",
  "non-functional",
  "unavailable",
  "timed-out",
  "structural",
];

/** Resolved hook-command identity as stored in ritual state. */
export interface AgentHookIdentityRecord {
  readonly path: string;
  readonly size: number;
  readonly mtime_ms: number;
}

/** The last `functional` result a host entry keeps; a timeout never renews it. */
export interface AgentHookFunctionalRecord {
  readonly ts: string;
  readonly identity: AgentHookIdentityRecord | null;
  readonly registration_digest: string | null;
}

export interface AgentHookHostEntry {
  readonly status: AgentHookHostStatus;
  /** Whether this result let the step pass (a timeout admitted or warned on counts). */
  readonly ok: boolean;
  readonly ts: string;
  readonly functional: AgentHookFunctionalRecord | null;
  readonly allowance_open: boolean;
  readonly warning?: string;
}

export interface AgentHookObservation {
  readonly status: AgentHookHostStatus;
  readonly ok: boolean;
  readonly identity: AgentHookCommandIdentity | null;
  readonly registrationDigest: string | null;
  readonly warning?: string;
}

export function identityRecord(
  identity: AgentHookCommandIdentity | null | undefined,
): AgentHookIdentityRecord | null {
  return identity === null || identity === undefined
    ? null
    : { path: identity.path, size: identity.size, mtime_ms: identity.mtimeMs };
}

/** Digest of one host's structural registration inspection. */
export function registrationDigest(
  host: string,
  registrations: readonly AgentHookInspection[],
): string | null {
  const entry = registrations.find((candidate) => candidate.host === host);
  if (entry === undefined) return null;
  return createHash("sha256").update(JSON.stringify(entry)).digest("hex");
}

/**
 * Grace window for the timeout allowance: the ritual freshness window, read from the same
 * `sessionRitualStalenessHours` setting so it can never be longer than that window.
 */
export function resolveAgentHookAllowanceGraceMs(projectRoot: string): number {
  return resolveSessionRitualStalenessHours(projectRoot).hours * MS_PER_HOUR;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseIdentity(value: unknown): AgentHookIdentityRecord | null {
  if (!isObject(value)) return null;
  const { path, size, mtime_ms: mtime } = value;
  return typeof path === "string" && typeof size === "number" && typeof mtime === "number"
    ? { path, size, mtime_ms: mtime }
    : null;
}

/** Parse a stored host entry; anything malformed is treated as absent (no allowance). */
export function parseAgentHookHostEntry(value: unknown): AgentHookHostEntry | null {
  if (!isObject(value)) return null;
  const { status, ok, ts, functional, allowance_open: open } = value;
  if (
    typeof status !== "string" ||
    !HOST_STATUSES.includes(status as AgentHookHostStatus) ||
    typeof ok !== "boolean" ||
    typeof ts !== "string" ||
    Number.isNaN(Date.parse(ts)) ||
    typeof open !== "boolean"
  ) {
    return null;
  }
  let record: AgentHookFunctionalRecord | null = null;
  if (isObject(functional) && typeof functional.ts === "string") {
    record = {
      ts: functional.ts,
      identity: parseIdentity(functional.identity),
      registration_digest:
        typeof functional.registration_digest === "string" ? functional.registration_digest : null,
    };
  }
  return {
    status: status as AgentHookHostStatus,
    ok,
    ts,
    functional: record,
    allowance_open: open,
    ...(typeof value.warning === "string" ? { warning: value.warning } : {}),
  };
}

/** Per-host entries of a stored `agent_hooks` step. */
export function readAgentHookHostEntries(
  step: Record<string, unknown> | undefined | null,
): Record<string, AgentHookHostEntry> {
  const out: Record<string, AgentHookHostEntry> = {};
  const hosts = step?.hosts;
  if (!isObject(hosts)) return out;
  for (const [host, raw] of Object.entries(hosts)) {
    const entry = parseAgentHookHostEntry(raw);
    if (entry !== null) out[host] = entry;
  }
  return out;
}

/**
 * The entry a result produces. Only `functional` records a new functional result and opens the
 * allowance. A timeout keeps the earlier functional record and closes the allowance; any other
 * result also closes it until a new `functional` result.
 */
export function nextAgentHookHostEntry(
  prev: AgentHookHostEntry | null,
  observation: AgentHookObservation,
  now: Date,
): AgentHookHostEntry {
  const ts = now.toISOString();
  if (observation.status === "functional") {
    return {
      status: "functional",
      ok: observation.ok,
      ts,
      functional: {
        ts,
        identity: identityRecord(observation.identity),
        registration_digest: observation.registrationDigest,
      },
      // An allowance needs an identity and a digest to compare against later.
      allowance_open: observation.identity !== null && observation.registrationDigest !== null,
      ...(observation.warning === undefined ? {} : { warning: observation.warning }),
    };
  }
  return {
    status: observation.status,
    ok: observation.ok,
    ts,
    functional: prev?.functional ?? null,
    allowance_open: false,
    ...(observation.warning === undefined ? {} : { warning: observation.warning }),
  };
}

export interface AgentHookAllowanceCurrent {
  readonly identity: AgentHookCommandIdentity | null;
  readonly registrationDigest: string | null;
}

export interface AgentHookAllowanceDecision {
  readonly admit: boolean;
  readonly reason: string;
}

function sameIdentity(
  stored: AgentHookIdentityRecord | null,
  current: AgentHookCommandIdentity | null,
): boolean {
  return (
    stored !== null &&
    current !== null &&
    stored.path === current.path &&
    stored.size === current.size &&
    stored.mtime_ms === current.mtimeMs
  );
}

/** Pure admission rule for one applying-host timeout. */
export function decideAgentHookTimeoutAllowance(
  entry: AgentHookHostEntry | null,
  current: AgentHookAllowanceCurrent,
  now: Date,
  graceMs: number,
): AgentHookAllowanceDecision {
  if (entry === null || entry.functional === null) {
    return { admit: false, reason: "no earlier functional result is recorded for this host" };
  }
  if (!entry.allowance_open) {
    return {
      admit: false,
      reason: "the timeout allowance is closed until a new functional result",
    };
  }
  if (!sameIdentity(entry.functional.identity, current.identity)) {
    return { admit: false, reason: "the hook command changed since the functional result" };
  }
  if (
    current.registrationDigest === null ||
    entry.functional.registration_digest !== current.registrationDigest
  ) {
    return { admit: false, reason: "the hook registration changed since the functional result" };
  }
  const age = now.getTime() - Date.parse(entry.functional.ts);
  if (!(age < graceMs)) {
    return { admit: false, reason: "the functional result is older than the allowance window" };
  }
  return { admit: true, reason: "one timeout after a recent functional result" };
}

export interface AgentHookAllowanceTake {
  readonly admitted: boolean;
  /** The entry the lock step saved on admission; null when nothing was saved. */
  readonly entry: AgentHookHostEntry | null;
  readonly reason: string;
  /** True when the step could not be saved; the write is refused. */
  readonly saveFailed: boolean;
}

/**
 * Check and close the allowance as one step inside the ritual-state lock: re-read the host's
 * current entry, admit only if it is still open, and record the timeout, which closes it.
 */
export function takeAgentHookTimeoutAllowance(
  projectRoot: string,
  host: string,
  current: AgentHookAllowanceCurrent,
  now: Date,
  graceMs: number,
  deps: LockDeps = {},
): AgentHookAllowanceTake {
  try {
    return mutateRitualStateLocked<AgentHookAllowanceTake>(
      projectRoot,
      (state) => {
        const step = state?.gatedSteps.agent_hooks;
        if (state === null || step === undefined) {
          return {
            payload: null,
            result: {
              admitted: false,
              entry: null,
              reason: "no agent_hooks record exists in ritual state",
              saveFailed: false,
            },
          };
        }
        const hosts = readAgentHookHostEntries(step);
        const prev = hosts[host] ?? null;
        const decision = decideAgentHookTimeoutAllowance(prev, current, now, graceMs);
        if (!decision.admit) {
          return {
            payload: null,
            result: { admitted: false, entry: null, reason: decision.reason, saveFailed: false },
          };
        }
        const entry = nextAgentHookHostEntry(
          prev,
          {
            status: "timed-out",
            ok: true,
            identity: current.identity,
            registrationDigest: current.registrationDigest,
            warning: `${host} hook probe timed out; admitted once after a recent functional result`,
          },
          now,
        );
        const gated = { ...(state.raw.gated_steps as Record<string, Record<string, unknown>>) };
        gated.agent_hooks = { ...step, hosts: { ...asRawHosts(step.hosts), [host]: entry } };
        return {
          payload: { ...state.raw, gated_steps: gated },
          result: { admitted: true, entry, reason: decision.reason, saveFailed: false },
        };
      },
      deps,
    );
  } catch (cause) {
    return {
      admitted: false,
      entry: null,
      reason: `could not save the timeout allowance step: ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
      saveFailed: true,
    };
  }
}

function asRawHosts(value: unknown): Record<string, unknown> {
  return isObject(value) ? value : {};
}
