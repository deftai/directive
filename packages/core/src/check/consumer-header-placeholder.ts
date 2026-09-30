/**
 * Check-surface runner for the first-ship AGENTS header placeholder gate (#4544).
 *
 * Product-mutation completion is the durable
 * `.deft/cache/product-mutation-completion.json` marker written on intentional
 * markWrite (survives release). Occupancy last_write_at alone is not enough.
 * Exact unmanaged-header one-liner only; Process-only and custom headers pass.
 * Unreadable/malformed Prefer-A marker fails closed (not Process-only).
 * Returned failure — no throw.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  evaluateFirstShipHeaderPlaceholderGate,
  type FirstShipHeaderPlaceholderResult,
} from "../platform/agents-consumer-header.js";
import { lookupProductMutationCompletion } from "./product-mutation-completion.js";

export const CONSUMER_HEADER_PLACEHOLDER_GATE_ID = "verify:consumer-header-placeholder";

export type AgentsMdReadResult =
  | { readonly kind: "missing" }
  | { readonly kind: "ok"; readonly text: string }
  | { readonly kind: "unreadable"; readonly detail: string };

export interface ConsumerHeaderPlaceholderSeams {
  readonly readAgentsMd?: () => AgentsMdReadResult | string | null;
  /** Test seam: force product-mutation boolean; skips durable-marker lookup. */
  readonly sessionChangedProductFiles?: boolean;
}

function readAgentsMdAtRoot(projectRoot: string): AgentsMdReadResult {
  const path = join(projectRoot, "AGENTS.md");
  if (!existsSync(path)) return { kind: "missing" };
  try {
    return { kind: "ok", text: readFileSync(path, "utf8") };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return { kind: "unreadable", detail };
  }
}

function normalizeAgentsMdSeam(value: AgentsMdReadResult | string | null): AgentsMdReadResult {
  if (value === null) return { kind: "missing" };
  if (typeof value === "string") return { kind: "ok", text: value };
  return value;
}

/** Evaluate the Prefer-A first-ship placeholder gate at a project root. */
export function evaluateConsumerHeaderPlaceholderAtRoot(
  projectRoot: string,
  seams: ConsumerHeaderPlaceholderSeams = {},
): FirstShipHeaderPlaceholderResult {
  const agentsRead = seams.readAgentsMd
    ? normalizeAgentsMdSeam(seams.readAgentsMd())
    : readAgentsMdAtRoot(projectRoot);
  if (agentsRead.kind === "unreadable") {
    return evaluateFirstShipHeaderPlaceholderGate({
      agentsMd: null,
      productMutationCompletion: seams.sessionChangedProductFiles === true,
      agentsMdUnreadable: true,
    });
  }

  if (seams.sessionChangedProductFiles !== undefined) {
    return evaluateFirstShipHeaderPlaceholderGate({
      agentsMd: agentsRead.kind === "ok" ? agentsRead.text : null,
      productMutationCompletion: seams.sessionChangedProductFiles,
    });
  }

  const marker = lookupProductMutationCompletion(projectRoot);
  if (marker.kind === "unreadable") {
    return evaluateFirstShipHeaderPlaceholderGate({
      agentsMd: agentsRead.kind === "ok" ? agentsRead.text : null,
      productMutationCompletion: false,
      productMutationMarkerUnreadable: true,
      productMutationMarkerDetail: marker.detail,
    });
  }

  return evaluateFirstShipHeaderPlaceholderGate({
    agentsMd: agentsRead.kind === "ok" ? agentsRead.text : null,
    productMutationCompletion: marker.kind === "present",
  });
}
