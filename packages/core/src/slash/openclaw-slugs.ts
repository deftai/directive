/**
 * Stable logicalId → OpenClaw slug map for L2 product commands (#3064 D2).
 *
 * OpenClaw sanitizes skill/command names to `a-z0-9_` (max 32). Colons in
 * `/deft:directive:run:interview` cannot survive raw. This table is the single
 * bijective map for the L2 set of 13 — do not invent ad-hoc sanitize at emit time.
 *
 * Example: `/deft:directive:run:interview` → `deft_run_interview`
 *
 * ⊗ Add `openclaw` to HOST_COMMAND_LAYOUTS / SLASH_EMITTER_HOSTS as a fake
 *   project file emitter (L6 / #3064 non-goal).
 */

import { listProductCommands, PRODUCT_COMMAND_COUNT, type ProductCommand } from "./product-set.js";

/** OpenClaw skill/command name max length (host sanitize). */
export const OPENCLAW_SLUG_MAX_LEN = 32 as const;

/** Regex for a valid OpenClaw skill slug. */
export const OPENCLAW_SLUG_PATTERN = /^[a-z0-9_]+$/;

/**
 * Router skill slug — preferred native-menu entry (D3).
 * Keep short for Telegram BOT_COMMANDS budget.
 */
export const OPENCLAW_ROUTER_SLUG = "deft" as const;

/**
 * Stable logical slash id → OpenClaw slug for the L2 product set.
 *
 * Derived from product-set order; shorter than hyphen-stem → underscore so
 * every entry stays well under 32 chars (D2 example pattern).
 */
const OPENCLAW_SLUG_BY_LOGICAL_ID_INNER: Readonly<Record<string, string>> = Object.freeze({
  "/deft:directive:change": "deft_change",
  "/deft:directive:change:apply": "deft_change_apply",
  "/deft:directive:change:verify": "deft_change_verify",
  "/deft:directive:change:archive": "deft_change_archive",
  "/deft:directive:run:interview": "deft_run_interview",
  "/deft:directive:run:yolo": "deft_run_yolo",
  "/deft:directive:run:map": "deft_run_map",
  "/deft:directive:run:discuss": "deft_run_discuss",
  "/deft:directive:run:research": "deft_run_research",
  "/deft:directive:run:speckit": "deft_run_speckit",
  "/deft:directive:run:probe": "deft_run_probe",
  "/deft:continue": "deft_continue",
  "/deft:checkpoint": "deft_checkpoint",
});

/** Public frozen map (logicalId → openClawSlug). */
export const OPENCLAW_SLUG_BY_LOGICAL_ID: Readonly<Record<string, string>> =
  OPENCLAW_SLUG_BY_LOGICAL_ID_INNER;

/** Reverse map for dispatch / router lookup. */
export const OPENCLAW_LOGICAL_ID_BY_SLUG: Readonly<Record<string, string>> = Object.freeze(
  Object.fromEntries(
    Object.entries(OPENCLAW_SLUG_BY_LOGICAL_ID_INNER).map(([logicalId, slug]) => [slug, logicalId]),
  ),
);

export interface OpenClawSlugEntry {
  readonly logicalId: string;
  readonly openClawSlug: string;
  readonly filenameStem: string;
  readonly description: string;
}

/** Assert slug shape: a-z0-9_, length 1..32, no colons. */
export function isValidOpenClawSlug(slug: string): boolean {
  if (slug.length === 0 || slug.length > OPENCLAW_SLUG_MAX_LEN) return false;
  if (slug.includes(":")) return false;
  return OPENCLAW_SLUG_PATTERN.test(slug);
}

/**
 * Look up the OpenClaw slug for a product logical id.
 * Throws when the id is not in the L2 map (no ad-hoc sanitize fallback).
 */
export function logicalIdToOpenClawSlug(logicalId: string): string {
  const slug = OPENCLAW_SLUG_BY_LOGICAL_ID_INNER[logicalId];
  if (slug === undefined) {
    throw new Error(`No OpenClaw slug mapping for logicalId: ${logicalId}`);
  }
  return slug;
}

/** Reverse lookup slug → logical id, or undefined. */
export function openClawSlugToLogicalId(slug: string): string | undefined {
  return OPENCLAW_LOGICAL_ID_BY_SLUG[slug];
}

/**
 * Stable ordered list of L2 slug entries (count === PRODUCT_COMMAND_COUNT).
 * Built from {@link listProductCommands} so the name table is not duplicated.
 */
export function listOpenClawSlugEntries(
  commands: readonly ProductCommand[] = listProductCommands(),
): readonly OpenClawSlugEntry[] {
  return commands.map((c) => ({
    logicalId: c.logicalId,
    openClawSlug: logicalIdToOpenClawSlug(c.logicalId),
    filenameStem: c.filenameStem,
    description: c.description,
  }));
}

/**
 * Validate the L2 map: cardinality, bijectivity, slug shape, product-set coverage.
 * Throws on any violation (used by unit tests and deposit preflight).
 */
export function assertOpenClawSlugMapIntegrity(
  commands: readonly ProductCommand[] = listProductCommands(),
): void {
  if (commands.length !== PRODUCT_COMMAND_COUNT) {
    throw new Error(
      `OpenClaw slug map expects ${PRODUCT_COMMAND_COUNT} product commands, got ${commands.length}`,
    );
  }
  const entries = listOpenClawSlugEntries(commands);
  if (entries.length !== PRODUCT_COMMAND_COUNT) {
    throw new Error(`OpenClaw slug map size ${entries.length} !== ${PRODUCT_COMMAND_COUNT}`);
  }

  const slugs = new Set<string>();
  for (const e of entries) {
    if (!isValidOpenClawSlug(e.openClawSlug)) {
      throw new Error(`Invalid OpenClaw slug for ${e.logicalId}: ${e.openClawSlug}`);
    }
    if (slugs.has(e.openClawSlug)) {
      throw new Error(`Duplicate OpenClaw slug: ${e.openClawSlug}`);
    }
    slugs.add(e.openClawSlug);
    if (OPENCLAW_LOGICAL_ID_BY_SLUG[e.openClawSlug] !== e.logicalId) {
      throw new Error(`Reverse map mismatch for slug ${e.openClawSlug}`);
    }
  }

  if (slugs.has(OPENCLAW_ROUTER_SLUG)) {
    throw new Error(
      `Router slug "${OPENCLAW_ROUTER_SLUG}" collides with an L2 product slug (reserve for router)`,
    );
  }
  if (!isValidOpenClawSlug(OPENCLAW_ROUTER_SLUG)) {
    throw new Error(`Invalid router slug: ${OPENCLAW_ROUTER_SLUG}`);
  }

  // Map keys must cover exactly the product set (no orphans, no missing).
  const mapKeys = new Set(Object.keys(OPENCLAW_SLUG_BY_LOGICAL_ID_INNER));
  for (const c of commands) {
    if (!mapKeys.has(c.logicalId)) {
      throw new Error(`Product command missing OpenClaw slug map entry: ${c.logicalId}`);
    }
    mapKeys.delete(c.logicalId);
  }
  if (mapKeys.size > 0) {
    throw new Error(`OpenClaw slug map has orphan keys: ${[...mapKeys].join(", ")}`);
  }
}
