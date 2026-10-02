/**
 * Check-surface runner for the first-ship AGENTS header placeholder gate (#4544).
 *
 * Product-mutation completion is the durable
 * `.deft/cache/product-mutation-completion.json` marker written on intentional
 * markWrite (survives release). Occupancy last_write_at alone is not enough.
 * Exact unmanaged-header one-liner only; Process-only and custom headers pass.
 * Unreadable/malformed Prefer-A marker fails closed (not Process-only).
 *
 * Residual after #5178: completion-chokepoint coverage stamps the Prefer-A
 * marker, remediates via confirmed-Overview CAS when available, then evaluates
 * so refuse conjuncts are reached without depending on the agent remembering
 * to stamp or invoke check / verify:consumer-header-placeholder by name.
 * Returned failure — no throw.
 */
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { containedWrite } from "../fs/contained-write.js";
import {
  compareAndSetConsumerHeaderOneLiner,
  evaluateFirstShipHeaderPlaceholderGate,
  type FirstShipHeaderPlaceholderResult,
  type HeaderOneLinerCasReason,
} from "../platform/agents-consumer-header.js";
import {
  lookupProductMutationCompletion,
  type RecordProductMutationCompletionResult,
  recordProductMutationCompletion,
} from "./product-mutation-completion.js";

export const CONSUMER_HEADER_PLACEHOLDER_GATE_ID = "verify:consumer-header-placeholder";

export const CONSUMER_HEADER_COMPLETION_CHOKEPOINT_ID =
  "consumer-header-placeholder-completion-chokepoint";

export const CONSUMER_HEADER_COMPLETION_CHOKEPOINT_REMEDY =
  "confirm Overview then compareAndSetConsumerHeaderOneLiner (setup Phase 3); " +
  "leave custom headers untouched; Process-only exits may keep the placeholder";

export type AgentsMdReadResult =
  | { readonly kind: "missing" }
  | { readonly kind: "ok"; readonly text: string }
  | { readonly kind: "unreadable"; readonly detail: string };

export interface ConsumerHeaderPlaceholderSeams {
  readonly readAgentsMd?: () => AgentsMdReadResult | string | null;
  /** Test seam: force product-mutation boolean; skips durable-marker lookup. */
  readonly sessionChangedProductFiles?: boolean;
}

export interface CompletionChokepointSeams {
  /** Override Overview used for CAS remediation (skips PROJECT-DEFINITION read). */
  readonly confirmedOverview?: string | null;
  /** Test seam: skip durable marker stamp (evaluate as already product-complete). */
  readonly skipMarkerStamp?: boolean;
  /** When false, CAS computes but does not write AGENTS.md. Default true. */
  readonly applyRemediationWrite?: boolean;
  readonly recordedAt?: Date;
  readonly readAgentsMd?: () => AgentsMdReadResult | string | null;
}

export type ConsumerHeaderCompletionChokepointResult = {
  readonly ok: boolean;
  readonly evaluation: FirstShipHeaderPlaceholderResult;
  readonly message: string;
  readonly marker:
    | RecordProductMutationCompletionResult
    | { readonly ok: true; readonly skipped: true };
  readonly remediation: {
    readonly attempted: boolean;
    readonly overviewAvailable: boolean;
    readonly casReason?: HeaderOneLinerCasReason;
    readonly wroteAgentsMd: boolean;
  };
};

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

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function normalizeNarrativeKey(key: string): string {
  return key.toLowerCase().replace(/[\s_-]+/g, "");
}

function resolveProjectDefinitionPath(projectRoot: string): string | null {
  const override = process.env.DEFT_PROJECT_PATH?.trim();
  if (override) {
    const configured = resolve(projectRoot, override);
    return existsSync(configured) ? configured : null;
  }
  const migrated = join(resolve(projectRoot), "xbrief", "PROJECT-DEFINITION.xbrief.json");
  if (existsSync(migrated)) return migrated;
  const legacy = join(resolve(projectRoot), "vbrief", "PROJECT-DEFINITION.vbrief.json");
  if (existsSync(legacy)) return legacy;
  return null;
}

/**
 * Confirmed Overview from PROJECT-DEFINITION narratives (setup Phase 3 CAS input).
 * Empty / missing Overview returns null — refuse path, not soft-missing pass.
 */
export function readConfirmedOverviewAtRoot(projectRoot: string): string | null {
  const path = resolveProjectDefinitionPath(projectRoot);
  if (path === null) return null;
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    const root = asRecord(parsed);
    const plan = asRecord(root?.plan);
    const narratives = asRecord(plan?.narratives);
    if (narratives === null) return null;
    for (const [key, value] of Object.entries(narratives)) {
      if (normalizeNarrativeKey(key) !== "overview") continue;
      if (typeof value !== "string") continue;
      const trimmed = value.trim();
      if (trimmed.length > 0) return trimmed;
    }
    return null;
  } catch {
    return null;
  }
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

function writeAgentsMdAtRoot(
  projectRoot: string,
  text: string,
): { readonly ok: true } | { readonly ok: false; readonly error: string } {
  const root = resolve(projectRoot);
  const target = join(root, "AGENTS.md");
  try {
    containedWrite({
      root,
      target,
      data: text.endsWith("\n") ? text : `${text}\n`,
      mode: "replace",
      mkdir: false,
    });
    return { ok: true };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return { ok: false, error: detail };
  }
}

/**
 * Fail-closed completion chokepoint after Prefer-A #5178 (#4544 residual).
 *
 * Arms the durable Prefer-A marker, remediates exact scaffold edit-me via
 * confirmed-Overview CAS when Overview is available, then evaluates the
 * Prefer-A check-surface gate. Process-only callers must not invoke this —
 * only product-mutation / delivered-completion paths.
 */
export function enforceConsumerHeaderPlaceholderAtCompletionChokepoint(
  projectRoot: string,
  seams: CompletionChokepointSeams = {},
): ConsumerHeaderCompletionChokepointResult {
  const root = resolve(projectRoot);
  let marker: ConsumerHeaderCompletionChokepointResult["marker"];
  if (seams.skipMarkerStamp === true) {
    marker = { ok: true, skipped: true };
  } else {
    const recorded = recordProductMutationCompletion(root, seams.recordedAt ?? new Date());
    if (!recorded.ok) {
      const message =
        `${CONSUMER_HEADER_COMPLETION_CHOKEPOINT_ID} FAIL: Prefer-A product-mutation ` +
        `marker write failed (${recorded.error}); remedy: retry the gated product write`;
      return {
        ok: false,
        evaluation: {
          ok: false,
          reason: "product-mutation-marker-unreadable",
          message,
        },
        message,
        marker: recorded,
        remediation: {
          attempted: false,
          overviewAvailable: false,
          wroteAgentsMd: false,
        },
      };
    }
    marker = recorded;
  }

  const evalSeams: ConsumerHeaderPlaceholderSeams = {
    readAgentsMd: seams.readAgentsMd,
    sessionChangedProductFiles: seams.skipMarkerStamp === true ? true : undefined,
  };
  let evaluation = evaluateConsumerHeaderPlaceholderAtRoot(root, evalSeams);
  if (evaluation.ok) {
    return {
      ok: true,
      evaluation,
      message: evaluation.message,
      marker,
      remediation: {
        attempted: false,
        overviewAvailable: false,
        wroteAgentsMd: false,
      },
    };
  }

  if (
    evaluation.reason !== "placeholder-with-product-mutation" &&
    evaluation.reason !== "product-mutation-marker-unreadable"
  ) {
    return {
      ok: false,
      evaluation,
      message: evaluation.message,
      marker,
      remediation: {
        attempted: false,
        overviewAvailable: false,
        wroteAgentsMd: false,
      },
    };
  }

  const overview =
    seams.confirmedOverview !== undefined
      ? seams.confirmedOverview !== null && seams.confirmedOverview.trim().length > 0
        ? seams.confirmedOverview.trim()
        : null
      : readConfirmedOverviewAtRoot(root);

  if (overview === null) {
    const message =
      `${CONSUMER_HEADER_COMPLETION_CHOKEPOINT_ID} FAIL: unmanaged AGENTS.md header ` +
      `still equals scaffold edit-me after product-mutation completion and confirmed ` +
      `Overview is unavailable; remedy: ${CONSUMER_HEADER_COMPLETION_CHOKEPOINT_REMEDY}`;
    return {
      ok: false,
      evaluation: {
        ok: false,
        reason: "placeholder-with-product-mutation",
        message,
      },
      message,
      marker,
      remediation: {
        attempted: false,
        overviewAvailable: false,
        wroteAgentsMd: false,
      },
    };
  }

  const agentsRead = seams.readAgentsMd
    ? normalizeAgentsMdSeam(seams.readAgentsMd())
    : readAgentsMdAtRoot(root);
  if (agentsRead.kind !== "ok") {
    return {
      ok: false,
      evaluation,
      message: evaluation.message,
      marker,
      remediation: {
        attempted: false,
        overviewAvailable: true,
        wroteAgentsMd: false,
      },
    };
  }

  const cas = compareAndSetConsumerHeaderOneLiner({
    agentsMd: agentsRead.text,
    confirmedOverview: overview,
  });
  let wroteAgentsMd = false;
  if (cas.changed && seams.applyRemediationWrite !== false) {
    // Re-read at write time so a concurrent AGENTS.md edit is not overwritten
    // by CAS computed from the earlier snapshot (#4544 Greptile P1).
    const freshRead = seams.readAgentsMd
      ? normalizeAgentsMdSeam(seams.readAgentsMd())
      : readAgentsMdAtRoot(root);
    if (freshRead.kind !== "ok" || freshRead.text !== agentsRead.text) {
      const detail =
        freshRead.kind === "ok"
          ? "AGENTS.md changed after the CAS snapshot"
          : freshRead.kind === "missing"
            ? "AGENTS.md missing at write time"
            : `AGENTS.md unreadable at write time (${freshRead.detail})`;
      const message =
        `${CONSUMER_HEADER_COMPLETION_CHOKEPOINT_ID} FAIL: Overview CAS computed but ` +
        `${detail}; remedy: retry completion after resolving the concurrent edit`;
      return {
        ok: false,
        evaluation: {
          ok: false,
          reason: "placeholder-with-product-mutation",
          message,
        },
        message,
        marker,
        remediation: {
          attempted: true,
          overviewAvailable: true,
          casReason: cas.reason,
          wroteAgentsMd: false,
        },
      };
    }
    const written = writeAgentsMdAtRoot(root, cas.agentsMd);
    if (!written.ok) {
      const message =
        `${CONSUMER_HEADER_COMPLETION_CHOKEPOINT_ID} FAIL: Overview CAS computed but ` +
        `AGENTS.md write failed (${written.error}); remedy: fix permissions then retry`;
      return {
        ok: false,
        evaluation: {
          ok: false,
          reason: "placeholder-with-product-mutation",
          message,
        },
        message,
        marker,
        remediation: {
          attempted: true,
          overviewAvailable: true,
          casReason: cas.reason,
          wroteAgentsMd: false,
        },
      };
    }
    wroteAgentsMd = true;
  }

  evaluation = evaluateConsumerHeaderPlaceholderAtRoot(root, evalSeams);
  if (!evaluation.ok) {
    const message =
      evaluation.reason === "placeholder-with-product-mutation"
        ? `${CONSUMER_HEADER_COMPLETION_CHOKEPOINT_ID} FAIL: ${evaluation.message}; ` +
          `CAS reason=${cas.reason}; remedy: ${CONSUMER_HEADER_COMPLETION_CHOKEPOINT_REMEDY}`
        : evaluation.message;
    return {
      ok: false,
      evaluation:
        evaluation.reason === "placeholder-with-product-mutation"
          ? { ...evaluation, message }
          : evaluation,
      message,
      marker,
      remediation: {
        attempted: true,
        overviewAvailable: true,
        casReason: cas.reason,
        wroteAgentsMd,
      },
    };
  }

  return {
    ok: true,
    evaluation,
    message: evaluation.message,
    marker,
    remediation: {
      attempted: true,
      overviewAvailable: true,
      casReason: cas.reason,
      wroteAgentsMd,
    },
  };
}
