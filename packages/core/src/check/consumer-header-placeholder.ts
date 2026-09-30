/**
 * Check-surface runner for the first-ship AGENTS header placeholder gate (#4544).
 *
 * Product-mutation completion is occupancy last_write_at (same signal as the
 * adjacent rapid soft-missing warning). Exact placeholder only; Process-only
 * and custom headers pass. Returned failure — no throw.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  evaluateFirstShipHeaderPlaceholderGate,
  type FirstShipHeaderPlaceholderResult,
} from "../platform/agents-consumer-header.js";
import { sessionRecordedProductWrite } from "./rapid-soft-missing-no-brief.js";

export const CONSUMER_HEADER_PLACEHOLDER_GATE_ID = "verify:consumer-header-placeholder";

export interface ConsumerHeaderPlaceholderSeams {
  readonly readAgentsMd?: () => string | null;
  readonly sessionChangedProductFiles?: boolean;
}

function readAgentsMdOrNull(projectRoot: string): string | null {
  const path = join(projectRoot, "AGENTS.md");
  if (!existsSync(path)) return null;
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

/** Evaluate the Prefer-A first-ship placeholder gate at a project root. */
export function evaluateConsumerHeaderPlaceholderAtRoot(
  projectRoot: string,
  seams: ConsumerHeaderPlaceholderSeams = {},
): FirstShipHeaderPlaceholderResult {
  const agentsMd = seams.readAgentsMd ? seams.readAgentsMd() : readAgentsMdOrNull(projectRoot);
  const productMutationCompletion =
    seams.sessionChangedProductFiles !== undefined
      ? seams.sessionChangedProductFiles
      : sessionRecordedProductWrite(projectRoot);
  return evaluateFirstShipHeaderPlaceholderGate({
    agentsMd,
    productMutationCompletion,
  });
}
