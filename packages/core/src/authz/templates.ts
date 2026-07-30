/**
 * AFK grant templates (#1095 Wave 4 + #871 Wave 5).
 *
 * Templates are **presets** on the Wave 1 mint path only:
 * they call mintHumanOriginGrant / operator-cli origin.
 *
 * ⊗ Do not invent a second authorization SoT under ~/.deft/session-auth
 *   that agents can self-mint as alternate permission.
 */

import { type MintGrantInput, mintHumanOriginGrant } from "./actions.js";
import { normaliseClosedVerbTarget, targetSurfaceCandidates } from "./closed-verb.js";
import type { AuthzOperation, HumanOriginGrant } from "./types.js";
import {
  builtinReleaseVerbClassification,
  getVerbRow,
  type VerbClassificationTable,
} from "./verb-classification.js";

/** Canonical AFK template names for Wave 4 release-class closed verbs. */
export const CLOSED_VERB_TEMPLATE_NAMES = [
  "release-cut",
  "release-publish",
  "release-rollback",
] as const;

export type ClosedVerbTemplateName = (typeof CLOSED_VERB_TEMPLATE_NAMES)[number];

/** Walk-away finish-loop template (#871 Wave 5) — not a release closed-verb. */
export const FINISH_LOOP_TEMPLATE_NAME = "finish-loop" as const;

/** All AFK templates accepted by `authz:grant --template`. */
export const AFK_TEMPLATE_NAMES = [
  ...CLOSED_VERB_TEMPLATE_NAMES,
  FINISH_LOOP_TEMPLATE_NAME,
] as const;

export type AfkTemplateName = (typeof AFK_TEMPLATE_NAMES)[number];

/**
 * AuthzOperation set covered by the finish-loop template.
 * Release-class ops are explicitly carved out (operator must mint a release-* grant).
 */
export const FINISH_LOOP_OPERATIONS: readonly AuthzOperation[] = [
  "edit",
  "push",
  "pr",
  "merge",
] as const;

/** Default AFK window for finish-loop (matches issue #871 walk-away notes). */
export const FINISH_LOOP_DEFAULT_EXPIRY_HOURS = 8;

export function isClosedVerbTemplateName(name: string): name is ClosedVerbTemplateName {
  return (CLOSED_VERB_TEMPLATE_NAMES as readonly string[]).includes(name.trim().toLowerCase());
}

export function isFinishLoopTemplateName(name: string): boolean {
  return name.trim().toLowerCase() === FINISH_LOOP_TEMPLATE_NAME;
}

export function isAfkTemplateName(name: string): name is AfkTemplateName {
  return (AFK_TEMPLATE_NAMES as readonly string[]).includes(name.trim().toLowerCase());
}

export interface MintClosedVerbTemplateInput {
  readonly projectRoot: string;
  readonly template: string;
  /** Version / tag target the template binds into grant.surfaces. */
  readonly target: string;
  readonly actor?: string;
  readonly expiresAt?: string | null;
  readonly singleUse?: boolean;
  readonly planRef?: string | null;
  readonly repo?: string | null;
  readonly branch?: string | null;
  readonly now?: Date;
  readonly classification?: VerbClassificationTable;
  /** Optional extra mint fields forwarded to mintHumanOriginGrant. */
  readonly pinActive?: boolean;
  readonly eventRef?: string | null;
}

export interface MintFinishLoopTemplateInput {
  readonly projectRoot: string;
  readonly actor?: string;
  readonly expiresAt?: string | null;
  readonly singleUse?: boolean;
  readonly planRef?: string | null;
  readonly repo?: string | null;
  readonly branch?: string | null;
  readonly surfaces?: readonly string[];
  readonly storyIds?: readonly string[];
  readonly issueIds?: readonly number[];
  readonly cohortId?: string | null;
  readonly now?: Date;
  readonly pinActive?: boolean;
  readonly eventRef?: string | null;
  /** Duration hours when expiresAt omitted (default 8). */
  readonly durationHours?: number;
}

function parseExpiryHours(defaultExpiry: string): number {
  const m = /^(\d+)\s*h$/i.exec(defaultExpiry.trim());
  if (m !== null) return Number(m[1]);
  return 1;
}

function isoExpiry(now: Date, hours: number): string {
  return new Date(now.getTime() + hours * 3600 * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");
}

/**
 * Resolve template → mint input (operations + surfaces). Pure; no I/O.
 * Always routes operations through Wave 1 AuthzOperation names.
 */
export function resolveClosedVerbTemplate(input: {
  readonly template: string;
  readonly target: string;
  readonly now?: Date;
  readonly expiresAt?: string | null;
  readonly classification?: VerbClassificationTable;
}): {
  operations: AuthzOperation[];
  surfaces: string[];
  expiresAt: string | null;
  template: ClosedVerbTemplateName;
} {
  const name = input.template.trim().toLowerCase();
  if (!isClosedVerbTemplateName(name)) {
    throw new Error(
      `unknown closed-verb template '${input.template}'; expected one of: ${CLOSED_VERB_TEMPLATE_NAMES.join(", ")}` +
        (isFinishLoopTemplateName(input.template)
          ? ` (use resolveFinishLoopTemplate / mintFinishLoopTemplateGrant for finish-loop)`
          : ""),
    );
  }
  const target = input.target.trim();
  if (target.length === 0) {
    throw new Error(`template ${name} requires a non-empty --target`);
  }
  const table = input.classification ?? builtinReleaseVerbClassification();
  const row = getVerbRow(table, name);
  if (row === null) {
    throw new Error(`verb classification missing row for template ${name}`);
  }
  // Prefer the precise closed-verb operation (least privilege); deployment is
  // accepted at evaluate time as a broader alternative but not minted by default.
  const op = name as AuthzOperation;
  const surfaces = targetSurfaceCandidates(target);
  // Prefer canonical version form without forcing only-v prefix ambiguity.
  const norm = normaliseClosedVerbTarget(target);
  const surfaceList =
    surfaces.length > 0 ? surfaces : norm !== null ? [norm, `v${norm}`] : [target];

  let expiresAt = input.expiresAt ?? null;
  if (expiresAt === null || expiresAt === undefined) {
    const hours = parseExpiryHours(row.default_expiry);
    const now = input.now ?? new Date();
    expiresAt = isoExpiry(now, hours);
  }

  return {
    operations: [op],
    surfaces: surfaceList,
    expiresAt,
    template: name,
  };
}

/**
 * Resolve finish-loop AFK template → mint ops (edit/push/pr/merge). Pure; no I/O.
 * Does not mint release-class operations.
 */
export function resolveFinishLoopTemplate(input: {
  readonly now?: Date;
  readonly expiresAt?: string | null;
  readonly durationHours?: number;
  readonly surfaces?: readonly string[];
}): {
  operations: AuthzOperation[];
  surfaces: string[];
  expiresAt: string | null;
  template: typeof FINISH_LOOP_TEMPLATE_NAME;
} {
  let expiresAt = input.expiresAt ?? null;
  if (expiresAt === null || expiresAt === undefined) {
    const hours =
      input.durationHours !== undefined && Number.isFinite(input.durationHours)
        ? Math.max(1, Math.floor(input.durationHours))
        : FINISH_LOOP_DEFAULT_EXPIRY_HOURS;
    expiresAt = isoExpiry(input.now ?? new Date(), hours);
  }
  return {
    operations: [...FINISH_LOOP_OPERATIONS],
    surfaces: input.surfaces !== undefined ? [...input.surfaces] : [],
    expiresAt,
    template: FINISH_LOOP_TEMPLATE_NAME,
  };
}

/**
 * Mint a human-origin grant for an AFK closed-verb template.
 * **Sole mint path:** mintHumanOriginGrant (operator-cli). No session-auth SoT.
 */
export function mintClosedVerbTemplateGrant(input: MintClosedVerbTemplateInput): HumanOriginGrant {
  // Production dual-mint guard: templates never open an independent session-auth mint.
  const dualMint = assertNoIndependentSessionAuthMint();
  if (dualMint.sessionAuthIsAuthority || dualMint.mintPath !== "mintHumanOriginGrant") {
    throw new Error(
      "closed-verb template mint refused: dual authorization SoT is forbidden (#1095)",
    );
  }
  const resolved = resolveClosedVerbTemplate({
    template: input.template,
    target: input.target,
    now: input.now,
    expiresAt: input.expiresAt,
    classification: input.classification,
  });
  const mintInput: MintGrantInput = {
    projectRoot: input.projectRoot,
    actor: input.actor ?? "operator",
    operations: resolved.operations,
    surfaces: resolved.surfaces,
    expiresAt: resolved.expiresAt,
    singleUse: input.singleUse === true,
    planRef: input.planRef ?? null,
    repo: input.repo ?? null,
    branch: input.branch ?? null,
    pinActive: input.pinActive,
    eventRef: input.eventRef ?? `template:${resolved.template}`,
    now: input.now,
  };
  return mintHumanOriginGrant(mintInput);
}

/**
 * Mint a human-origin grant for the walk-away finish-loop template (#871).
 * Covers edit/push/pr/merge only — never release-cut / release-publish / release-rollback.
 * **Sole mint path:** mintHumanOriginGrant (operator-cli).
 */
export function mintFinishLoopTemplateGrant(input: MintFinishLoopTemplateInput): HumanOriginGrant {
  const dualMint = assertNoIndependentSessionAuthMint();
  if (dualMint.sessionAuthIsAuthority || dualMint.mintPath !== "mintHumanOriginGrant") {
    throw new Error(
      "finish-loop template mint refused: dual authorization SoT is forbidden (#871 / #1095)",
    );
  }
  const resolved = resolveFinishLoopTemplate({
    now: input.now,
    expiresAt: input.expiresAt,
    durationHours: input.durationHours,
    surfaces: input.surfaces,
  });
  const mintInput: MintGrantInput = {
    projectRoot: input.projectRoot,
    actor: input.actor ?? "operator",
    operations: resolved.operations,
    surfaces: resolved.surfaces,
    expiresAt: resolved.expiresAt,
    singleUse: input.singleUse === true,
    planRef: input.planRef ?? null,
    repo: input.repo ?? null,
    branch: input.branch ?? null,
    storyIds: input.storyIds,
    issueIds: input.issueIds,
    cohortId: input.cohortId ?? null,
    pinActive: input.pinActive,
    eventRef: input.eventRef ?? `template:${FINISH_LOOP_TEMPLATE_NAME}`,
    now: input.now,
  };
  return mintHumanOriginGrant(mintInput);
}

/**
 * Dispatch AFK template mint by name. Closed-verb templates require target;
 * finish-loop does not.
 */
export function mintAfkTemplateGrant(input: {
  readonly projectRoot: string;
  readonly template: string;
  readonly target?: string | null;
  readonly actor?: string;
  readonly expiresAt?: string | null;
  readonly singleUse?: boolean;
  readonly planRef?: string | null;
  readonly repo?: string | null;
  readonly branch?: string | null;
  readonly surfaces?: readonly string[];
  readonly storyIds?: readonly string[];
  readonly issueIds?: readonly number[];
  readonly cohortId?: string | null;
  readonly now?: Date;
  readonly classification?: VerbClassificationTable;
  readonly pinActive?: boolean;
  readonly eventRef?: string | null;
  readonly durationHours?: number;
}): HumanOriginGrant {
  const name = input.template.trim().toLowerCase();
  if (isFinishLoopTemplateName(name)) {
    return mintFinishLoopTemplateGrant({
      projectRoot: input.projectRoot,
      actor: input.actor,
      expiresAt: input.expiresAt,
      singleUse: input.singleUse,
      planRef: input.planRef,
      repo: input.repo,
      branch: input.branch,
      surfaces: input.surfaces,
      storyIds: input.storyIds,
      issueIds: input.issueIds,
      cohortId: input.cohortId,
      now: input.now,
      pinActive: input.pinActive,
      eventRef: input.eventRef,
      durationHours: input.durationHours,
    });
  }
  if (!isClosedVerbTemplateName(name)) {
    throw new Error(
      `unknown AFK template '${input.template}'; expected one of: ${AFK_TEMPLATE_NAMES.join(", ")}`,
    );
  }
  if (input.target === null || input.target === undefined || input.target.trim().length === 0) {
    throw new Error(`template ${name} requires a non-empty --target`);
  }
  return mintClosedVerbTemplateGrant({
    projectRoot: input.projectRoot,
    template: name,
    target: input.target,
    actor: input.actor,
    expiresAt: input.expiresAt,
    singleUse: input.singleUse,
    planRef: input.planRef,
    repo: input.repo,
    branch: input.branch,
    now: input.now,
    classification: input.classification,
    pinActive: input.pinActive,
    eventRef: input.eventRef,
  });
}

/**
 * Assert that authorization for closed verbs must not use an independent
 * session-auth mint engine. Used by unit tests as a dual-mint guard.
 */
export function assertNoIndependentSessionAuthMint(): {
  mintPath: "mintHumanOriginGrant";
  sessionAuthIsAuthority: false;
} {
  return {
    mintPath: "mintHumanOriginGrant",
    sessionAuthIsAuthority: false,
  };
}
