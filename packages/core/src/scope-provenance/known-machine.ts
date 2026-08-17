/**
 * Known-machine vs extracted classification for plan.* (#3376 R1 / #3385 F1).
 *
 * Seeded from the #3376 corpus inventory (capacity stamps, completion
 * provenance, swarm readiness, tags-as-label-mirror). Growing this list MUST
 * land with a writer annotation in KNOWN_MACHINE_WRITERS (same-PR CI rule)
 * and MUST NOT change existing intent digests.
 */

export type KeyClass = "extract" | "extract-partial" | "machine" | "unknown";

/** Recursive walk nodes (not pinned wholesale). */
export const PARTIAL_NODES = new Set<string>(["", "metadata", "metadata.swarm"]);

/** plan.* keys that are machine space (never hash inputs). */
export const PLAN_MACHINE_KEYS = new Set<string>([
  "status",
  "updated",
  "created",
  "createdAt",
  "updatedAt",
  "completed",
  "percentComplete",
  "tags",
  "planRef",
  "plan_ref",
]);

/** plan.metadata.* machine keys / wholesale machine subtrees. */
export const METADATA_MACHINE_KEYS = new Set<string>([
  "capacityBucket",
  "capacityBucketSource",
  "completionProvenance",
  "deliveryDisposition",
  "handoffState",
  "parent_lineage",
  "parentLineage",
  "x-migrator",
]);

/** plan.metadata.swarm.* machine keys. */
export const SWARM_MACHINE_KEYS = new Set<string>([
  "readiness",
  "parallel_safe",
  "verify_commands",
  "expected_outputs",
  "depends_on",
  "conflict_group",
  "size",
  "file_scope_confidence",
  "model_tier",
]);

/** plan.items[] machine keys (raw planRef is machine; parentId is extracted). */
export const ITEM_MACHINE_KEYS = new Set<string>([
  "status",
  "completed",
  "percentComplete",
  "effort",
  "updated",
  "created",
  "planRef",
  "plan_ref",
]);

/** reference fields that are never extracted. */
export const REFERENCE_MACHINE_KEYS = new Set<string>(["TrustLevel", "trustLevel"]);

/** Item fields copied into the preimage when present. */
export const ITEM_EXTRACT_KEYS = ["id", "title", "summary", "narrative", "type"] as const;

/** Swarm fields extracted as intent (prose + file_scope for review). */
export const SWARM_EXTRACT_KEYS = new Set<string>([
  "file_scope",
  "missing_traces_justification",
  "acceptance_criteria_justification",
  "notes",
]);

/**
 * Writer annotation for each known-machine key. Adding a key without an entry
 * fails the same-PR writer-discipline test (#3385 F1).
 */
export const KNOWN_MACHINE_WRITERS: Readonly<Record<string, { writer: string }>> = {
  "plan.status": { writer: "packages/core/src/scope/transition.ts" },
  "plan.updated": { writer: "packages/core/src/scope/transition.ts" },
  "plan.created": { writer: "packages/core/src/scope/transition.ts" },
  "plan.createdAt": { writer: "packages/core/src/scope/transition.ts" },
  "plan.updatedAt": { writer: "packages/core/src/scope/transition.ts" },
  "plan.completed": { writer: "packages/core/src/scope/transition.ts" },
  "plan.percentComplete": { writer: "packages/core/src/scope/transition.ts" },
  "plan.tags": { writer: "packages/core/src/intake/issue-ingest.ts" },
  "plan.planRef": { writer: "packages/core/src/scope/decomposed-refs.ts" },
  "plan.plan_ref": { writer: "packages/core/src/scope/decomposed-refs.ts" },
  "plan.metadata.capacityBucket": { writer: "packages/core/src/scope/capacity-stamp.ts" },
  "plan.metadata.capacityBucketSource": { writer: "packages/core/src/scope/capacity-stamp.ts" },
  "plan.metadata.completionProvenance": { writer: "packages/core/src/scope/delivery-evidence.ts" },
  "plan.metadata.deliveryDisposition": { writer: "packages/core/src/scope/delivery-evidence.ts" },
  "plan.metadata.handoffState": { writer: "packages/core/src/scope/delivery-evidence.ts" },
  "plan.metadata.parent_lineage": { writer: "packages/core/src/scope/parent-lineage.ts" },
  "plan.metadata.parentLineage": { writer: "packages/core/src/scope/parent-lineage.ts" },
  "plan.metadata.x-migrator": { writer: "packages/core/src/xbrief-migrate" },
  "plan.metadata.swarm.readiness": { writer: "packages/core/src/swarm/complete-cohort.ts" },
  "plan.metadata.swarm.parallel_safe": { writer: "packages/core/src/swarm/complete-cohort.ts" },
  "plan.metadata.swarm.verify_commands": { writer: "packages/core/src/swarm/launch.ts" },
  "plan.metadata.swarm.expected_outputs": { writer: "packages/core/src/swarm/launch.ts" },
  "plan.metadata.swarm.depends_on": { writer: "packages/core/src/swarm/launch.ts" },
  "plan.metadata.swarm.conflict_group": { writer: "packages/core/src/swarm/launch.ts" },
  "plan.metadata.swarm.size": { writer: "packages/core/src/swarm/launch.ts" },
  "plan.metadata.swarm.file_scope_confidence": { writer: "packages/core/src/swarm/launch.ts" },
  "plan.metadata.swarm.model_tier": { writer: "packages/core/src/swarm/launch.ts" },
  "plan.items[].status": { writer: "packages/core/src/scope/transition.ts" },
  "plan.items[].completed": { writer: "packages/core/src/scope/transition.ts" },
  "plan.items[].percentComplete": { writer: "packages/core/src/scope/transition.ts" },
  "plan.items[].effort": { writer: "packages/core/src/scope/transition.ts" },
  "plan.items[].updated": { writer: "packages/core/src/scope/transition.ts" },
  "plan.items[].created": { writer: "packages/core/src/scope/transition.ts" },
  "plan.items[].planRef": { writer: "packages/core/src/scope/decomposed-refs.ts" },
  "plan.items[].plan_ref": { writer: "packages/core/src/scope/decomposed-refs.ts" },
  "plan.references[].TrustLevel": { writer: "packages/core/src/intake/issue-ingest.ts" },
  "plan.references[].trustLevel": { writer: "packages/core/src/intake/issue-ingest.ts" },
};

export function classifyPlanPath(path: string): KeyClass {
  if (PARTIAL_NODES.has(path)) return "extract-partial";
  if (
    path === "items" ||
    path === "references" ||
    path === "metadata" ||
    path === "metadata.swarm"
  ) {
    return "extract-partial";
  }
  if (PLAN_MACHINE_KEYS.has(path)) return "machine";
  if (path.startsWith("metadata.") && METADATA_MACHINE_KEYS.has(path.slice("metadata.".length))) {
    return "machine";
  }
  if (path.startsWith("metadata.swarm.")) {
    const leaf = path.slice("metadata.swarm.".length);
    if (SWARM_MACHINE_KEYS.has(leaf)) return "machine";
    if (SWARM_EXTRACT_KEYS.has(leaf)) return "extract";
    return "unknown";
  }
  if (path === "edges" || path === "title" || path === "narratives" || path === "acceptance") {
    return "extract";
  }
  if (path === "architecture" || path === "id") return "extract";
  return "unknown";
}

export function classifyItemKey(key: string): KeyClass {
  if (ITEM_MACHINE_KEYS.has(key)) return "machine";
  if ((ITEM_EXTRACT_KEYS as readonly string[]).includes(key)) return "extract";
  return "unknown";
}

export function classifyReferenceKey(key: string): KeyClass {
  if (REFERENCE_MACHINE_KEYS.has(key)) return "machine";
  return "extract";
}

/** Every known-machine leaf that the writer-discipline test enumerates. */
export function allKnownMachineLeaves(): string[] {
  return Object.keys(KNOWN_MACHINE_WRITERS).sort((a, b) => a.localeCompare(b));
}
