import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { contentRoot } from "../content-root.js";
import { type AgentsMdSeams, frameworkRoot } from "./agents-md.js";
import { findManagedOpenMarker } from "./linear-scan.js";

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

/** Unmanaged region above the managed-section open marker (or whole file). */
export function unmanagedHeaderRegion(agentsMd: string): string {
  const normalized = agentsMd.replace(/\r\n/g, "\n");
  const open = findManagedOpenMarker(normalized, 0);
  return open === null ? normalized : normalized.slice(0, open.start);
}

/**
 * Unmanaged header one-liner: first non-empty, non-heading, non-HTML-comment
 * line in the unmanaged region (#4544 Prefer-A / Greptile).
 */
export function unmanagedHeaderOneLiner(agentsMd: string): string | null {
  for (const raw of unmanagedHeaderRegion(agentsMd).split("\n")) {
    const line = raw.trim();
    if (line.length === 0) continue;
    if (line.startsWith("#")) continue;
    if (line.startsWith("<!--")) continue;
    return line;
  }
  return null;
}

/**
 * Replace the unmanaged-header one-liner only (same locus as
 * {@link unmanagedHeaderOneLiner}). Skips headings and HTML-comment lines so a
 * quoted scaffold sentence in a leading comment cannot steal the CAS (#4544).
 */
function replaceUnmanagedHeaderOneLiner(agentsMd: string, from: string, to: string): string | null {
  const normalized = agentsMd.replace(/\r\n/g, "\n");
  const region = unmanagedHeaderRegion(normalized);
  const lines = region.split("\n");
  let offset = 0;
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i] ?? "";
    const line = raw.trim();
    if (line.length === 0 || line.startsWith("#") || line.startsWith("<!--")) {
      offset += raw.length + (i < lines.length - 1 ? 1 : 0);
      continue;
    }
    if (line !== from) return null;
    const idxInRaw = raw.indexOf(from);
    if (idxInRaw < 0) return null;
    const start = offset + idxInRaw;
    return normalized.slice(0, start) + to + normalized.slice(start + from.length);
  }
  return null;
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
  if (unmanagedHeaderOneLiner(normalized) !== CONSUMER_HEADER_PLACEHOLDER_ONELINER) {
    return { agentsMd: input.agentsMd, changed: false, reason: "not-placeholder" };
  }
  if (oneLiner === CONSUMER_HEADER_PLACEHOLDER_ONELINER) {
    return { agentsMd: input.agentsMd, changed: false, reason: "already-matches" };
  }
  const replaced = replaceUnmanagedHeaderOneLiner(
    normalized,
    CONSUMER_HEADER_PLACEHOLDER_ONELINER,
    oneLiner,
  );
  if (replaced === null) {
    return { agentsMd: input.agentsMd, changed: false, reason: "not-placeholder" };
  }
  return {
    agentsMd: replaced,
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

/** Exact scaffold edit-me still present as the unmanaged header one-liner (#4544 Prefer-A). */
export function agentsMdContainsExactPlaceholder(agentsMd: string): boolean {
  return unmanagedHeaderOneLiner(agentsMd) === CONSUMER_HEADER_PLACEHOLDER_ONELINER;
}

export const FIRST_SHIP_HEADER_PLACEHOLDER_CAUSE =
  "unmanaged AGENTS.md header still equals scaffold edit-me after product-mutation completion";

export const FIRST_SHIP_HEADER_PLACEHOLDER_REMEDY =
  "confirm Overview then compareAndSetConsumerHeaderOneLiner (setup Phase 3); leave custom headers untouched; Process-only exits may keep the placeholder";

export type FirstShipHeaderPlaceholderReason =
  | "no-agents-md"
  | "not-placeholder"
  | "process-only"
  | "placeholder-with-product-mutation"
  | "agents-md-unreadable"
  | "product-mutation-marker-unreadable";

export interface FirstShipHeaderPlaceholderResult {
  readonly ok: boolean;
  readonly reason: FirstShipHeaderPlaceholderReason;
  readonly message: string;
}

/**
 * Fail-closed first-ship gate (#4544 Prefer-A): product-mutation completion must
 * not finish while the unmanaged header still equals the exact scaffold
 * placeholder. Absent AGENTS.md, custom headers, and Process-only pass.
 * Unreadable Prefer-A marker fails closed only while the header is still the
 * scaffold placeholder (not silent Process-only; do not refuse custom/absent).
 * Returned failure only — no throw.
 */
export function evaluateFirstShipHeaderPlaceholderGate(input: {
  readonly agentsMd: string | null;
  readonly productMutationCompletion: boolean;
  readonly agentsMdUnreadable?: boolean;
  readonly productMutationMarkerUnreadable?: boolean;
  readonly productMutationMarkerDetail?: string;
}): FirstShipHeaderPlaceholderResult {
  if (input.agentsMdUnreadable === true) {
    return {
      ok: false,
      reason: "agents-md-unreadable",
      message:
        "consumer-header-placeholder FAIL: AGENTS.md exists but is unreadable; " +
        "remedy: fix file permissions or encoding, then re-run verify:consumer-header-placeholder",
    };
  }
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
  if (input.productMutationMarkerUnreadable === true) {
    const detail =
      input.productMutationMarkerDetail !== undefined &&
      input.productMutationMarkerDetail.trim().length > 0
        ? ` (${input.productMutationMarkerDetail.trim()})`
        : "";
    return {
      ok: false,
      reason: "product-mutation-marker-unreadable",
      message:
        "consumer-header-placeholder FAIL: Prefer-A product-mutation marker exists but is " +
        `unreadable or malformed${detail}; remedy: repair or re-record ` +
        ".deft/cache/product-mutation-completion.json, then re-run " +
        "verify:consumer-header-placeholder (do not treat as Process-only)",
    };
  }
  if (!input.productMutationCompletion) {
    return {
      ok: true,
      reason: "process-only",
      message: "consumer-header-placeholder: placeholder allowed (no product-mutation completion)",
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
