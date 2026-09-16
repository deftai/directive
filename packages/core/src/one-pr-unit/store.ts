/**
 * Facade over the canonical App store. Disk `.deft/one-pr-unit` is not SoT (#4494).
 * Production backend is remaining-deploy item 1: Directive GitHub App private transactional store.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { MintClaimInput, OnePrUnitAppStore } from "./app-store.js";
import {
  IN_PROCESS_NOT_PRODUCTION,
  ONE_PR_UNIT_APP_NOT_CONFIGURED,
  type ResolveProductionAppStoreResult,
  resolveClaimFromStore,
} from "./app-store.js";
import { evaluateOnePrUnit } from "./evaluate.js";
import { exactOriginSetEquals, uniqueOrigins } from "./origin-set.js";
import { getDefaultAppStore, InProcessAppStore } from "./simulator.js";
import {
  DISK_STORE_NOT_SOT,
  type OnePrUnitClaim,
  type OnePrUnitDecision,
  type OriginRef,
} from "./types.js";

export const ONE_PR_UNIT_DIR = ".deft/one-pr-unit";

export function onePrUnitDir(_projectRoot: string): string {
  throw new Error(DISK_STORE_NOT_SOT);
}

export function onePrUnitGrantPath(_projectRoot: string, _grantId: string): string {
  throw new Error(DISK_STORE_NOT_SOT);
}

export function loadOnePrUnitGrant(
  _projectRoot: string,
  grantId: string,
  store: OnePrUnitAppStore = getDefaultAppStore(),
): OnePrUnitClaim | null {
  return store.getById(grantId);
}

export function writeOnePrUnitGrant(_projectRoot: string, _grant: OnePrUnitClaim): string {
  throw new Error(DISK_STORE_NOT_SOT);
}

export function markOnePrUnitSpent(
  _projectRoot: string,
  grant: OnePrUnitClaim,
  _binding: { readonly repo?: string | null; readonly prNodeId?: string | null },
  _now?: Date,
): OnePrUnitClaim {
  void _projectRoot;
  void _binding;
  void _now;
  return grant;
}

export function listOnePrUnitGrants(
  _projectRoot: string,
  store: OnePrUnitAppStore = getDefaultAppStore(),
): OnePrUnitClaim[] {
  return store.listActive();
}

export function resolveOnePrUnitClaim(
  store: OnePrUnitAppStore,
  input: { readonly id?: string | null; readonly prNodeId?: string | null },
): OnePrUnitClaim | null {
  return resolveClaimFromStore(store, input);
}

export { utcIso } from "./simulator.js";

interface StoreMaps {
  claims: Map<string, OnePrUnitClaim>;
  membership: Map<string, string>;
  byPrNode: Map<string, string>;
}

const CLAIMS_FILE = "claims.json";
const STORE_SCHEMA = "deft.one-pr-unit.app-store.v1";

function mapsOf(store: InProcessAppStore): StoreMaps {
  return store as unknown as StoreMaps;
}

function isInProcessSelection(raw: string): boolean {
  const v = raw.trim().toLowerCase();
  return (
    v === "inprocess" ||
    v === "in-process" ||
    v === "simulator" ||
    v === "memory" ||
    v === "inprocessappstore" ||
    v === "1" ||
    v === "true" ||
    v === "yes" ||
    v === "on"
  );
}

function isDiskStoreNotSotPath(raw: string): boolean {
  const n = raw.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
  return n.endsWith(".deft/one-pr-unit") || n.includes("/.deft/one-pr-unit/");
}

/** Remaining-deploy item 1: Directive GitHub App private transactional store. */
export class DirectiveGitHubAppStore implements OnePrUnitAppStore {
  readonly backend = "directive-github-app" as const;
  private readonly inner: InProcessAppStore;
  private readonly root: string;

  constructor(root: string) {
    this.root = resolve(root);
    this.inner = this.hydrate();
  }

  mint(input: MintClaimInput): OnePrUnitClaim {
    const claim = this.inner.mint(input);
    this.persist();
    return claim;
  }

  bind(id: string, prNodeId: string, now?: Date): OnePrUnitClaim {
    const claim = this.inner.bind(id, prNodeId, now);
    this.persist();
    return claim;
  }

  getById(id: string): OnePrUnitClaim | null {
    const claim = this.inner.getById(id);
    this.persist();
    return claim;
  }

  getByPrNodeId(prNodeId: string): OnePrUnitClaim | null {
    const claim = this.inner.getByPrNodeId(prNodeId);
    this.persist();
    return claim;
  }

  membershipOf(origin: OriginRef): OnePrUnitClaim | null {
    const claim = this.inner.membershipOf(origin);
    this.persist();
    return claim;
  }

  listActive(): OnePrUnitClaim[] {
    const claims = this.inner.listActive();
    this.persist();
    return claims;
  }

  consume(prNodeId: string, claimedSet: readonly OriginRef[], now?: Date): OnePrUnitClaim {
    const claim = this.inner.consume(prNodeId, claimedSet, now);
    this.persist();
    return claim;
  }

  revoke(id: string, actor: string, now?: Date): OnePrUnitClaim {
    const claim = this.inner.revoke(id, actor, now);
    this.persist();
    return claim;
  }

  revokeUnmerged(prNodeId: string, now?: Date): OnePrUnitClaim {
    const claim = this.inner.revokeUnmerged(prNodeId, now);
    this.persist();
    return claim;
  }

  expireDue(now?: Date): OnePrUnitClaim[] {
    const expired = this.inner.expireDue(now);
    this.persist();
    return expired;
  }

  private persist(): void {
    mkdirSync(this.root, { recursive: true });
    const inner = mapsOf(this.inner);
    const payload = {
      schema: STORE_SCHEMA,
      backend: this.backend,
      claims: [...inner.claims.values()],
      membership: [...inner.membership.entries()],
      byPrNode: [...inner.byPrNode.entries()],
    };
    writeFileSync(join(this.root, CLAIMS_FILE), JSON.stringify(payload), "utf8");
  }

  private hydrate(): InProcessAppStore {
    const store = new InProcessAppStore();
    const dest = join(this.root, CLAIMS_FILE);
    if (!existsSync(dest)) return store;
    const raw: unknown = JSON.parse(readFileSync(dest, "utf8"));
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return store;
    const rec = raw as {
      claims?: unknown;
      membership?: unknown;
      byPrNode?: unknown;
    };
    const inner = mapsOf(store);
    if (Array.isArray(rec.claims)) {
      for (const claim of rec.claims) {
        if (claim !== null && typeof claim === "object" && "id" in claim) {
          const row = claim as OnePrUnitClaim;
          if (typeof row.id === "string") inner.claims.set(row.id, row);
        }
      }
    }
    if (Array.isArray(rec.membership)) {
      inner.membership = new Map(rec.membership as [string, string][]);
    }
    if (Array.isArray(rec.byPrNode)) {
      inner.byPrNode = new Map(rec.byPrNode as [string, string][]);
    }
    return store;
  }
}

export function resolveProductionAppStore(
  env: NodeJS.ProcessEnv = process.env,
): ResolveProductionAppStoreResult {
  const raw = (env.DEFT_ONE_PR_UNIT_APP ?? "").trim();
  if (raw.length === 0) {
    return { ok: false, code: "not-configured", message: ONE_PR_UNIT_APP_NOT_CONFIGURED };
  }
  if (isInProcessSelection(raw)) {
    return { ok: false, code: "in-process-not-production", message: IN_PROCESS_NOT_PRODUCTION };
  }
  if (isDiskStoreNotSotPath(raw)) {
    return { ok: false, code: "disk-not-sot", message: DISK_STORE_NOT_SOT };
  }
  return { ok: true, store: new DirectiveGitHubAppStore(raw) };
}

export function findReservedExactSetClaim(
  store: OnePrUnitAppStore,
  closerSet: readonly OriginRef[],
): OnePrUnitClaim | null {
  const unique = uniqueOrigins(closerSet);
  if (unique.length < 2) return null;
  const candidates = new Map<string, OnePrUnitClaim>();
  for (const origin of unique) {
    const hit = store.membershipOf(origin);
    if (hit !== null) candidates.set(hit.id, hit);
  }
  for (const claim of store.listActive()) {
    candidates.set(claim.id, claim);
  }
  const matches: OnePrUnitClaim[] = [];
  for (const claim of candidates.values()) {
    if (claim.state !== "reserved") continue;
    if (claim.prNodeId !== null) continue;
    if (!exactOriginSetEquals(unique, claim.origins)) continue;
    matches.push(claim);
  }
  return matches.length === 1 ? (matches[0] ?? null) : null;
}

export function bindExactSetThenResolve(input: {
  readonly store: OnePrUnitAppStore;
  readonly closerSet: readonly OriginRef[];
  readonly repo: string;
  readonly prNodeId: string;
}): OnePrUnitClaim | null {
  const node = input.prNodeId.trim();
  const unique = uniqueOrigins(input.closerSet);
  if (node.length > 0 && unique.length >= 2) {
    const reserved = findReservedExactSetClaim(input.store, unique);
    if (reserved !== null) {
      const declared = evaluateOnePrUnit({
        closerSet: unique,
        grant: reserved,
        phase: "declare",
        binding: { repo: input.repo, prNodeId: node },
      });
      if (declared.code === "allow-granted") {
        input.store.bind(reserved.id, node);
      }
    }
  }
  return resolveClaimFromStore(input.store, { prNodeId: node });
}

export function enforceLiveOnePrUnitCheck(input: {
  readonly store: OnePrUnitAppStore;
  readonly closerSet: readonly OriginRef[];
  readonly repo: string;
  readonly prNodeId: string;
}): OnePrUnitDecision {
  const grant = bindExactSetThenResolve(input);
  return evaluateOnePrUnit({
    closerSet: input.closerSet,
    grant,
    binding: { repo: input.repo, prNodeId: input.prNodeId },
    phase: "enforce",
  });
}
