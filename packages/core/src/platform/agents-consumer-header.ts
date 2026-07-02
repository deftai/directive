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
      "One-line project description (edit me).",
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
