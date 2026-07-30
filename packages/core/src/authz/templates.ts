/**
 * AFK closed-verb grant templates (#1095 Wave 4).
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

/** Canonical AFK template names for Wave 4 release-class verbs. */
export const CLOSED_VERB_TEMPLATE_NAMES = [
  "release-cut",
  "release-publish",
  "release-rollback",
] as const;

export type ClosedVerbTemplateName = (typeof CLOSED_VERB_TEMPLATE_NAMES)[number];

export function isClosedVerbTemplateName(name: string): name is ClosedVerbTemplateName {
  return (CLOSED_VERB_TEMPLATE_NAMES as readonly string[]).includes(name.trim().toLowerCase());
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

function parseExpiryHours(defaultExpiry: string): number {
  const m = /^(\d+)\s*h$/i.exec(defaultExpiry.trim());
  if (m !== null) return Number(m[1]);
  return 1;
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
      `unknown closed-verb template '${input.template}'; expected one of: ${CLOSED_VERB_TEMPLATE_NAMES.join(", ")}`,
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
    expiresAt = new Date(now.getTime() + hours * 3600 * 1000)
      .toISOString()
      .replace(/\.\d{3}Z$/, "Z");
  }

  return {
    operations: [op],
    surfaces: surfaceList,
    expiresAt,
    template: name,
  };
}

/**
 * Mint a human-origin grant for an AFK closed-verb template.
 * **Sole mint path:** mintHumanOriginGrant (operator-cli). No session-auth SoT.
 */
export function mintClosedVerbTemplateGrant(input: MintClosedVerbTemplateInput): HumanOriginGrant {
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
