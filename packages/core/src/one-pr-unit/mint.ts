/**
 * Human-presence mint UX for one-PR-unit claims (#4494).
 * `deft authz:grant` / `refuseNonInteractiveMint` call this, which calls the App store.
 * Opaque id is not a bearer. Disk `.deft/one-pr-unit` is not written.
 */

import { evidenceSatisfiesImplementationApproval, isHumanOrigin } from "../authz/origin.js";
import type { HumanOriginGrant } from "../authz/types.js";
import type { MintClaimInput, OnePrUnitAppStore } from "./app-store.js";
import { getDefaultAppStore } from "./simulator.js";
import { resolveProductionAppStore } from "./store.js";
import type { OnePrUnitClaim } from "./types.js";

export interface MintOnePrUnitInput extends MintClaimInput {
  readonly store?: OnePrUnitAppStore;
  /**
   * @deprecated disk path is not SoT. Ignored.
   */
  readonly projectRoot?: string;
}

function probeHumanOrigin(input: MintClaimInput): HumanOriginGrant {
  const mintedAt = (input.now ?? new Date()).toISOString();
  return {
    schemaVersion: 1,
    id: "one-pr-unit-mint-probe",
    origin: {
      kind: "operator-cli",
      actor: input.actor,
      mintedAt,
      mintedVia: "authz:grant/one-pr-unit",
      eventRef: input.approvalRef,
    },
    scope: {
      planRef: null,
      repo: input.repo,
      branch: null,
      worktree: null,
      surfaces: [],
      operations: [],
      storyIds: [],
      issueIds: input.origins.map((o) => o.issueId),
      cohortId: null,
    },
    semantics: { expiresAt: null, singleUse: true, usedAt: null, revokedAt: null },
  };
}

export function mintOnePrUnitGrant(input: MintOnePrUnitInput): OnePrUnitClaim {
  const probe = probeHumanOrigin(input);
  if (!isHumanOrigin(probe.origin) || !evidenceSatisfiesImplementationApproval({ grant: probe })) {
    throw new Error(
      "one-pr-unit mint requires operator-cli origin; evidenceSatisfiesImplementationApproval rejected #1378/allocation/implement-list evidence",
    );
  }
  const store = input.store ?? mintStoreFromEnv();
  return store.mint(input);
}

function mintStoreFromEnv(): OnePrUnitAppStore {
  const resolved = resolveProductionAppStore(process.env);
  if (resolved.ok) return resolved.store;
  return getDefaultAppStore();
}
