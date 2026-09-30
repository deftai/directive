/**
 * Check-surface runner for the first-ship AGENTS header placeholder gate (#4544).
 *
 * Product-mutation completion is the durable
 * `.deft/cache/product-mutation-completion.json` marker written on intentional
 * markWrite (survives release). Occupancy last_write_at alone is not enough.
 * Exact unmanaged-header one-liner only; Process-only and custom headers pass.
 * Returned failure — no throw.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  evaluateFirstShipHeaderPlaceholderGate,
  type FirstShipHeaderPlaceholderResult,
} from "../platform/agents-consumer-header.js";
import { productMutationCompletionAtRoot } from "./product-mutation-completion.js";

export const CONSUMER_HEADER_PLACEHOLDER_GATE_ID = "verify:consumer-header-placeholder";

export type AgentsMdReadResult =
  | { readonly kind: "missing" }
  | { readonly kind: "ok"; readonly text: string }
  | { readonly kind: "unreadable"; readonly detail: string };

export interface ConsumerHeaderPlaceholderSeams {
  readonly readAgentsMd?: () => AgentsMdReadResult | string | null;
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
  const productMutationCompletion =
    seams.sessionChangedProductFiles !== undefined
      ? seams.sessionChangedProductFiles
      : productMutationCompletionAtRoot(projectRoot);
  if (agentsRead.kind === "unreadable") {
    return evaluateFirstShipHeaderPlaceholderGate({
      agentsMd: null,
      productMutationCompletion,
      agentsMdUnreadable: true,
    });
  }
  return evaluateFirstShipHeaderPlaceholderGate({
    agentsMd: agentsRead.kind === "ok" ? agentsRead.text : null,
    productMutationCompletion,
  });
}
