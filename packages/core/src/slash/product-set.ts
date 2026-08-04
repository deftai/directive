/**
 * Locked product slash-command table for native multi-host registration (#3052 / epic #55).
 *
 * Authoritative locks: LockedDecisions L1–L10 on #55 (especially L1 names, L2 set of 13,
 * L3 no native aliases, L4 logical-id ↔ hyphen filename map).
 *
 * Emitters (#3053) and deposit (#3054) MUST consume this table (or the generator IR built
 * from it) — do not maintain a second product name list.
 */

/** Primary load path on slash invoke (L5: one clear artifact). */
export type SlashDispatchKind = "strategy" | "skill" | "commands" | "resilience" | "session";

/**
 * One canonical product slash command (L2).
 *
 * `logicalId` is the external slash form (host display / autocomplete).
 * `filenameStem` is the portable on-disk name without extension (L4).
 * `dispatchPath` is content-root-relative; emitters may prefix deposit roots
 * (e.g. `.deft/core/`) without changing this table.
 */
export interface ProductCommand {
  readonly logicalId: string;
  readonly filenameStem: string;
  readonly description: string;
  readonly dispatchKind: SlashDispatchKind;
  readonly dispatchPath: string;
  readonly argumentHint?: string;
}

/** Locked product-set cardinality (L2). */
export const PRODUCT_COMMAND_COUNT = 13 as const;

/**
 * Canonical L2 product command set — exactly 13 entries, stable order.
 *
 * ⊗ Expand without a product decision that amends L2 on #55.
 * ⊗ Emit native alias files for legacy `/deft:change` forms (L3).
 */
export const PRODUCT_COMMANDS: readonly ProductCommand[] = Object.freeze([
  {
    logicalId: "/deft:directive:change",
    filenameStem: "deft-directive-change",
    description: "Create a scoped change proposal under history/changes/",
    dispatchKind: "commands",
    dispatchPath: "commands.md",
    argumentHint: "<name>",
  },
  {
    logicalId: "/deft:directive:change:apply",
    filenameStem: "deft-directive-change-apply",
    description: "Implement tasks from the active change proposal",
    dispatchKind: "commands",
    dispatchPath: "commands.md",
  },
  {
    logicalId: "/deft:directive:change:verify",
    filenameStem: "deft-directive-change-verify",
    description: "Verify the active change against acceptance criteria",
    dispatchKind: "commands",
    dispatchPath: "commands.md",
  },
  {
    logicalId: "/deft:directive:change:archive",
    filenameStem: "deft-directive-change-archive",
    description: "Archive the completed change under history/archive/",
    dispatchKind: "commands",
    dispatchPath: "commands.md",
  },
  {
    logicalId: "/deft:directive:run:interview",
    filenameStem: "deft-directive-run-interview",
    description: "Structured interview with Light/Full sizing gate",
    dispatchKind: "strategy",
    dispatchPath: "strategies/interview.md",
    argumentHint: "<name>",
  },
  {
    logicalId: "/deft:directive:run:yolo",
    filenameStem: "deft-directive-run-yolo",
    description: "Auto-pilot interview; agent picks options",
    dispatchKind: "strategy",
    dispatchPath: "strategies/yolo.md",
    argumentHint: "<name>",
  },
  {
    logicalId: "/deft:directive:run:map",
    filenameStem: "deft-directive-run-map",
    description: "Brownfield codebase mapping strategy",
    dispatchKind: "strategy",
    dispatchPath: "strategies/map.md",
  },
  {
    logicalId: "/deft:directive:run:discuss",
    filenameStem: "deft-directive-run-discuss",
    description: "Feynman-style alignment and decision locking",
    dispatchKind: "strategy",
    dispatchPath: "strategies/discuss.md",
    argumentHint: "<topic>",
  },
  {
    logicalId: "/deft:directive:run:research",
    filenameStem: "deft-directive-run-research",
    description: "Research domain before planning (don't hand-roll)",
    dispatchKind: "strategy",
    dispatchPath: "strategies/research.md",
    argumentHint: "<domain>",
  },
  {
    logicalId: "/deft:directive:run:speckit",
    filenameStem: "deft-directive-run-speckit",
    description: "Five-phase large/complex specification workflow",
    dispatchKind: "strategy",
    dispatchPath: "strategies/speckit.md",
    argumentHint: "<name>",
  },
  {
    logicalId: "/deft:directive:run:probe",
    filenameStem: "deft-directive-run-probe",
    description: "Adversarial one-question plan stress-testing",
    dispatchKind: "skill",
    dispatchPath: "skills/deft-directive-probe/SKILL.md",
  },
  {
    logicalId: "/deft:continue",
    filenameStem: "deft-continue",
    description: "Resume from the continue checkpoint",
    dispatchKind: "resilience",
    dispatchPath: "resilience/continue-here.md",
  },
  {
    logicalId: "/deft:checkpoint",
    filenameStem: "deft-checkpoint",
    // description documents the save path; wrappers load the strategy doc (same as continue).
    // ⊗ Point dispatchPath at xbrief/continue.xbrief.json — that file is the checkpoint *output*,
    // not the instruction doc; first invoke fails when it does not exist yet (#3105).
    description: "Save session state to xbrief/continue.xbrief.json",
    dispatchKind: "session",
    dispatchPath: "resilience/continue-here.md",
  },
] satisfies readonly ProductCommand[]);

/**
 * Map a canonical logical slash id to the portable hyphen filename stem (L4).
 *
 * `/deft:directive:run:interview` → `deft-directive-run-interview`
 * `/deft:continue` → `deft-continue`
 */
export function logicalIdToFilenameStem(logicalId: string): string {
  const trimmed = logicalId.trim();
  if (!trimmed.startsWith("/")) {
    throw new Error(`logicalId must start with '/': ${logicalId}`);
  }
  return trimmed.slice(1).replace(/:/g, "-");
}

/** Filename with `.md` extension for host command deposit (L4). */
export function logicalIdToFilename(logicalId: string): string {
  return `${logicalIdToFilenameStem(logicalId)}.md`;
}

/** Frozen product table for emitters (#3053) — single source of truth. */
export function listProductCommands(): readonly ProductCommand[] {
  return PRODUCT_COMMANDS;
}

/** Look up one product command by logical id, or undefined. */
export function getProductCommand(logicalId: string): ProductCommand | undefined {
  return PRODUCT_COMMANDS.find((c) => c.logicalId === logicalId);
}
