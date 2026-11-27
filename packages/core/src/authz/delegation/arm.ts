/**
 * The one core arming verb (#7420 B1).
 *
 * Host adapters (Claude `UserPromptSubmit`; Antigravity `PreInvocation` after
 * #7332) pass only the prompt text and the host session id. Every check and
 * the record format live here.
 *
 * Order, all inside one store lock:
 *   1. verify the code against the enrolled secret (drift window);
 *   2. a step at or below `lastAcceptedStep` is a quiet no-op (nothing written);
 *   3. set `lastAcceptedStep` to the matched step (burned on sight, even when
 *      the rest of the command is refused);
 *   4. validate the rest of the command (TTL, session id, UAT, kill record);
 *   5. write the record in the same state write.
 * A wrong or missing code writes nothing.
 */

import { randomBytes } from "node:crypto";
import type { GitRunner } from "../../session/git.js";
import {
  appendDelegationAudit,
  killRecordPresent,
  loadDelegationState,
  readEnrolledSecret,
  resolveDelegationSecretPath,
  resolveDelegationStoreRoot,
  saveDelegationState,
  uatActiveOrUnreadable,
  utcIsoSeconds,
  withDelegationLock,
} from "./store.js";
import { verifyTotpCode } from "./totp.js";
import {
  DELEGABLE_HOOK_ALLOWS,
  DELEGABLE_MINT_VERBS,
  DELEGABLE_RELEASE_TEMPLATES,
  DELEGATED_TOTP_PROVENANCE,
  DELEGATION_DEFAULT_TTL_HOURS,
  DELEGATION_MAX_TTL_HOURS,
  DELEGATION_MIN_TTL_HOURS,
  DELEGATION_SCHEMA_VERSION,
  DELEGATION_TOTP_DIGITS,
  type DelegationRecord,
} from "./types.js";

const MS_PER_HOUR = 3600 * 1000;

/** Parsed arm command, or null when the prompt holds no arm command. */
export interface ParsedArmCommand {
  /** The 6-digit code, or null when none was typed. */
  readonly code: string | null;
  /** Requested TTL in hours, or null for the default. */
  readonly ttlHours: number | null;
  /** Why the rest of the command is refused (code may still be burned), or null. */
  readonly commandError: string | null;
}

const ARM_LINE = /^\s*deft\s+delegate\s+on\b(.*)$/im;
const CODE_TOKEN = new RegExp(`^\\d{${DELEGATION_TOTP_DIGITS}}$`);
const TTL_TOKEN = /^(\d+)h$/i;

/**
 * Find `deft delegate on [<ttl>] <code>` on its own line. Extra tokens refuse
 * the command but a valid code among them is still read (and burned).
 */
export function parseArmCommand(promptText: string): ParsedArmCommand | null {
  const m = ARM_LINE.exec(promptText);
  if (m === null) return null;
  const tokens = (m[1] ?? "")
    .trim()
    .split(/\s+/)
    .filter((t) => t.length > 0);
  let code: string | null = null;
  let ttlHours: number | null = null;
  const errors: string[] = [];
  for (const token of tokens) {
    if (CODE_TOKEN.test(token)) {
      if (code !== null) errors.push("more than one code");
      code = token;
      continue;
    }
    const ttl = TTL_TOKEN.exec(token);
    if (ttl !== null && code === null && ttlHours === null) {
      ttlHours = Number(ttl[1]);
      continue;
    }
    errors.push(`unexpected token '${token.slice(0, 16)}'`);
  }
  if (ttlHours !== null) {
    if (ttlHours > DELEGATION_MAX_TTL_HOURS) {
      errors.push(`ttl ${ttlHours}h is over the ${DELEGATION_MAX_TTL_HOURS}h maximum`);
    } else if (ttlHours < DELEGATION_MIN_TTL_HOURS) {
      errors.push(`ttl ${ttlHours}h is under the ${DELEGATION_MIN_TTL_HOURS}h minimum`);
    }
  }
  return { code, ttlHours, commandError: errors.length > 0 ? errors.join("; ") : null };
}

export type ArmOutcome =
  /** No arm command in the prompt. Nothing read or written. */
  | { readonly kind: "not-a-command" }
  /** A step at or below lastAcceptedStep (replay or repeat). Nothing written. */
  | { readonly kind: "noop-replay"; readonly step: number }
  /** Wrong, missing or unverifiable code. Nothing written. */
  | { readonly kind: "refused-no-write"; readonly reason: string }
  /** Valid code burned (lastAcceptedStep advanced) but the command refused; no record. */
  | { readonly kind: "refused-burned"; readonly step: number; readonly reason: string }
  /** Armed: record written in the same locked step. */
  | { readonly kind: "armed"; readonly record: DelegationRecord };

export interface ArmDelegationInput {
  readonly projectRoot: string;
  readonly promptText: string;
  readonly hostSessionId: string;
  /** Host adapter label for the record and audit (e.g. `claude`). */
  readonly host: string;
  readonly now?: Date;
  /** Seams (tests): secret file path, store root, git runner, id factory. */
  readonly secretPath?: string;
  readonly storeRoot?: string;
  readonly runGit?: GitRunner;
  readonly newDelegationId?: () => string;
}

function defaultDelegationId(): string {
  return `delegation-${randomBytes(8).toString("hex")}`;
}

/** The one core arming verb. Never throws for ordinary refusals. */
export function armDelegation(input: ArmDelegationInput): ArmOutcome {
  const parsed = parseArmCommand(input.promptText);
  if (parsed === null) return { kind: "not-a-command" };
  if (parsed.code === null) return { kind: "refused-no-write", reason: "missing code" };
  const now = input.now ?? new Date();
  const secretPath = input.secretPath ?? resolveDelegationSecretPath();
  const secret = readEnrolledSecret(secretPath);
  if (secret === null) {
    return {
      kind: "refused-no-write",
      reason:
        "no TOTP secret enrolled; a person runs `deft delegate enroll --confirm` at a terminal",
    };
  }
  const step = verifyTotpCode({ secretBase32: secret.secretBase32, code: parsed.code, now });
  if (step === null) return { kind: "refused-no-write", reason: "wrong code" };

  const storeRoot = input.storeRoot ?? resolveDelegationStoreRoot(input.projectRoot, input.runGit);
  const locked = withDelegationLock(storeRoot, (): ArmOutcome => {
    const load = loadDelegationState(storeRoot);
    if (!load.ok) return { kind: "refused-no-write", reason: load.reason };
    const state = load.state;
    if (step <= state.lastAcceptedStep) return { kind: "noop-replay", step };

    // Burn the step whatever happens to the rest of the command.
    const refusal =
      parsed.commandError ??
      (input.hostSessionId.trim().length === 0 ? "no host session id" : null) ??
      (uatActiveOrUnreadable(storeRoot) || uatActiveOrUnreadable(input.projectRoot)
        ? "a UAT lease is active"
        : null) ??
      (killRecordPresent(storeRoot) || killRecordPresent(input.projectRoot)
        ? "a kill record is present"
        : null);

    if (refusal !== null) {
      saveDelegationState(storeRoot, { ...state, lastAcceptedStep: step });
      appendDelegationAudit(storeRoot, {
        schemaVersion: DELEGATION_SCHEMA_VERSION,
        ts: utcIsoSeconds(now),
        event: "arm-refused",
        provenance: DELEGATED_TOTP_PROVENANCE,
        delegationId: null,
        hostSessionId: input.hostSessionId.trim() || null,
        detail: `code step ${step} burned; ${refusal}`,
      });
      return { kind: "refused-burned", step, reason: refusal };
    }

    const ttlHours = parsed.ttlHours ?? DELEGATION_DEFAULT_TTL_HOURS;
    const rec: DelegationRecord = {
      schemaVersion: DELEGATION_SCHEMA_VERSION,
      delegationId: (input.newDelegationId ?? defaultDelegationId)(),
      hostSessionId: input.hostSessionId.trim(),
      host: input.host,
      armedAt: utcIsoSeconds(now),
      expiresAt: utcIsoSeconds(new Date(now.getTime() + ttlHours * MS_PER_HOUR)),
      armedStep: step,
      allowlist: {
        verbs: [...DELEGABLE_MINT_VERBS],
        templates: [...DELEGABLE_RELEASE_TEMPLATES],
        hookAllows: [...DELEGABLE_HOOK_ALLOWS],
      },
      provenance: DELEGATED_TOTP_PROVENANCE,
      endedAt: null,
      endedReason: null,
    };
    saveDelegationState(storeRoot, {
      schemaVersion: DELEGATION_SCHEMA_VERSION,
      lastAcceptedStep: step,
      record: rec,
    });
    appendDelegationAudit(storeRoot, {
      schemaVersion: DELEGATION_SCHEMA_VERSION,
      ts: utcIsoSeconds(now),
      event: "arm",
      provenance: DELEGATED_TOTP_PROVENANCE,
      delegationId: rec.delegationId,
      hostSessionId: rec.hostSessionId,
      detail: `armed via ${input.host} until ${rec.expiresAt}`,
    });
    return { kind: "armed", record: rec };
  });
  if (!locked.ok) return { kind: "refused-no-write", reason: locked.reason };
  return locked.value;
}

/** One chat-facing line for an arm outcome; null for a quiet outcome. */
export function formatArmOutcomeLine(outcome: ArmOutcome): string | null {
  switch (outcome.kind) {
    case "not-a-command":
    case "noop-replay":
      return null;
    case "refused-no-write":
      return `[delegated-totp] delegation not armed: ${outcome.reason}.`;
    case "refused-burned":
      return `[delegated-totp] delegation not armed: ${outcome.reason}. The code is used; wait for the next code.`;
    case "armed":
      return (
        `[delegated-totp] delegation armed until ${outcome.record.expiresAt} ` +
        `(id ${outcome.record.delegationId}). It allows approved-scope and the four release ` +
        "grants only. End it with `deft delegate off`."
      );
  }
}
