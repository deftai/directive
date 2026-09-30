import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { contentRoot } from "../content-root.js";
import { type AgentsMdSeams, frameworkRoot } from "./agents-md.js";

/** Rot-prone unmanaged-header sections retired by Option A (#2065). */
export const RETIRED_UNMANAGED_HEADER_SECTIONS = ["## Status", "## Known Issues"] as const;

// "Next:" is a bare label, not a markdown heading like the two patterns above --
// anchor it to the start of a line so prose that happens to contain "Next:"
// mid-sentence (e.g. "See UPGRADING.md ... Next: run `deft triage:queue`") does
// not false-positive (#2170 review).
const RETIRED_NEXT_LABEL_PATTERN = /(^|\n)\s*Next:/;

const CONSUMER_HEADER_TEMPLATE = "templates/agents-consumer-header.md";

/** Placeholder one-liner shipped by composeGreenfieldAgentsMd (#2065 / #4544). */
export const CONSUMER_HEADER_PLACEHOLDER_ONELINER = "One-line project description (edit me).";

export type HeaderOneLinerCasReason =
  | "replaced-placeholder"
  | "not-placeholder"
  | "empty-overview"
  | "already-matches";

/** First non-empty line of confirmed Overview. Not a live-prompt interpolator. */
export function oneLinerFromConfirmedOverview(overview: string): string {
  for (const raw of overview.replace(/\r\n/g, "\n").split("\n")) {
    const line = raw.trim().replace(/^#+\s*/, "");
    if (line.length > 0) return line;
  }
  return "";
}

/**
 * Placeholder-only compare-and-set of the unmanaged AGENTS.md one-liner from
 * user-confirmed Overview. Leaves a custom header untouched. Overview is not
 * identity source of truth (#4544).
 */
export function compareAndSetConsumerHeaderOneLiner(input: {
  readonly agentsMd: string;
  readonly confirmedOverview: string;
}): {
  readonly agentsMd: string;
  readonly changed: boolean;
  readonly reason: HeaderOneLinerCasReason;
} {
  const oneLiner = oneLinerFromConfirmedOverview(input.confirmedOverview);
  if (oneLiner.length === 0) {
    return { agentsMd: input.agentsMd, changed: false, reason: "empty-overview" };
  }
  const normalized = input.agentsMd.replace(/\r\n/g, "\n");
  if (!normalized.includes(CONSUMER_HEADER_PLACEHOLDER_ONELINER)) {
    return { agentsMd: input.agentsMd, changed: false, reason: "not-placeholder" };
  }
  if (oneLiner === CONSUMER_HEADER_PLACEHOLDER_ONELINER) {
    return { agentsMd: input.agentsMd, changed: false, reason: "already-matches" };
  }
  // Function replacer: string replacement expands $&, $`, $', $$ in Overview.
  return {
    agentsMd: normalized.replace(CONSUMER_HEADER_PLACEHOLDER_ONELINER, () => oneLiner),
    changed: true,
    reason: "replaced-placeholder",
  };
}

export interface ConsumerHeaderSeams {
  readonly frameworkRoot?: string;
  readonly readTemplate?: () => string | null;
}

function readConsumerHeaderTemplate(seams: ConsumerHeaderSeams = {}): string | null {
  if (seams.readTemplate) return seams.readTemplate();
  const root = frameworkRoot(seams as AgentsMdSeams);
  const candidate = join(contentRoot(root), CONSUMER_HEADER_TEMPLATE);
  try {
    if (!existsSync(candidate)) return null;
    return readFileSync(candidate, "utf8");
  } catch {
    return null;
  }
}

/** Bounded unmanaged header scaffold for fresh consumer installs (#2065 Option A). */
export function renderConsumerHeader(seams: ConsumerHeaderSeams = {}): string {
  const template = readConsumerHeaderTemplate(seams);
  if (template === null) {
    return [
      "# Project",
      "",
      CONSUMER_HEADER_PLACEHOLDER_ONELINER,
      "",
      "## Session orientation",
      "",
      "Scoped work → `xbrief/` lifecycle; ranked queue → `deft triage:queue`; tracked bugs → GitHub issues; identity → `xbrief/PROJECT-DEFINITION.xbrief.json`.",
    ].join("\n");
  }
  return template.replace(/\r\n/g, "\n").replace(/\n$/, "");
}

/** Compose a greenfield AGENTS.md: bounded unmanaged header + attributed managed section. */
export function composeGreenfieldAgentsMd(
  attributedManagedSection: string,
  seams: ConsumerHeaderSeams = {},
): string {
  const header = renderConsumerHeader(seams);
  const managed = attributedManagedSection.replace(/\r\n/g, "\n").replace(/\n$/, "");
  return `${header}\n\n${managed}\n`;
}

/** True when text contains rot-prone retired header patterns (#2065). */
export function containsRetiredUnmanagedHeaderPatterns(text: string): boolean {
  const normalized = text.replace(/\r\n/g, "\n");
  if (RETIRED_UNMANAGED_HEADER_SECTIONS.some((pattern) => normalized.includes(pattern))) {
    return true;
  }
  return RETIRED_NEXT_LABEL_PATTERN.test(normalized);
}

/** Exact scaffold edit-me still present in AGENTS.md (#4544 Prefer-A). */
export function agentsMdContainsExactPlaceholder(agentsMd: string): boolean {
  return agentsMd.replace(/\r\n/g, "\n").includes(CONSUMER_HEADER_PLACEHOLDER_ONELINER);
}

export const FIRST_SHIP_HEADER_PLACEHOLDER_CAUSE =
  "unmanaged AGENTS.md header still equals scaffold edit-me after product-mutation completion";

export const FIRST_SHIP_HEADER_PLACEHOLDER_REMEDY =
  "confirm Overview then compareAndSetConsumerHeaderOneLiner (setup Phase 3); leave custom headers untouched; Process-only exits may keep the placeholder";

export type FirstShipHeaderPlaceholderReason =
  | "no-agents-md"
  | "not-placeholder"
  | "process-only"
  | "placeholder-with-product-mutation";

export interface FirstShipHeaderPlaceholderResult {
  readonly ok: boolean;
  readonly reason: FirstShipHeaderPlaceholderReason;
  readonly message: string;
}

/**
 * Fail-closed first-ship gate (#4544 Prefer-A): product-mutation completion must
 * not finish while the unmanaged header still equals the exact scaffold
 * placeholder. Process-only (no product mutation) and custom headers pass.
 * Returned failure only — no throw.
 */
export function evaluateFirstShipHeaderPlaceholderGate(input: {
  readonly agentsMd: string | null;
  readonly productMutationCompletion: boolean;
}): FirstShipHeaderPlaceholderResult {
  if (input.agentsMd === null) {
    return {
      ok: true,
      reason: "no-agents-md",
      message: "consumer-header-placeholder: no AGENTS.md (skip)",
    };
  }
  if (!agentsMdContainsExactPlaceholder(input.agentsMd)) {
    return {
      ok: true,
      reason: "not-placeholder",
      message: "consumer-header-placeholder: header is not the scaffold edit-me placeholder",
    };
  }
  if (!input.productMutationCompletion) {
    return {
      ok: true,
      reason: "process-only",
      message:
        "consumer-header-placeholder: placeholder allowed (no product-mutation completion)",
    };
  }
  return {
    ok: false,
    reason: "placeholder-with-product-mutation",
    message:
      `consumer-header-placeholder FAIL: ${FIRST_SHIP_HEADER_PLACEHOLDER_CAUSE}; ` +
      `remedy: ${FIRST_SHIP_HEADER_PLACEHOLDER_REMEDY}`,
  };
}
