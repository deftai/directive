/**
 * P0 xBRIEF style templates and markdown section maps (#3057).
 *
 * One schema spine (xBRIEF v0.8); markdown is a dense render of the same plan,
 * not a second dialect.
 */

import { parseMarkdownHeading } from "../text/redos-safe.js";
import type { XbriefDocument, XbriefStyle } from "./types.js";

/**
 * Linear frontmatter ``key: value`` parse (no nested quantifiers).
 * Replaces ``/^key:\s*(.+)\s*$/`` flagged as CodeQL js/polynomial-redos (#3174).
 */
function frontmatterField(line: string, key: string): string | null {
  const prefix = `${key}:`;
  if (!line.startsWith(prefix)) {
    return null;
  }
  const value = line.slice(prefix.length).trim();
  return value.length > 0 ? value : null;
}

/** Required H2 section titles in the markdown form per style. */
export const MD_REQUIRED_SECTIONS: Readonly<Record<XbriefStyle, readonly string[]>> = {
  scope: ["Title", "Status", "Overview", "Items"],
  playbook: ["Title", "Status", "Overview", "Steps"],
  mission: ["Title", "Status", "Outcome", "Evidence"],
  project: ["Title", "Status", "Overview", "TechStack"],
};

export interface BuildDocumentInput {
  style: XbriefStyle;
  title: string;
  id?: string;
  status?: string;
  description?: string;
  now?: Date;
  /** Optional narrative overrides merged over style defaults. */
  narratives?: Record<string, string>;
  items?: unknown[];
}

function isoNow(now: Date): string {
  return now.toISOString().replace(/\.\d{3}Z$/, "Z");
}

function defaultStatus(style: XbriefStyle): string {
  switch (style) {
    case "scope":
      return "draft";
    case "playbook":
      return "approved";
    case "mission":
      return "completed";
    case "project":
      return "approved";
  }
}

function defaultNarratives(style: XbriefStyle, title: string): Record<string, string> {
  switch (style) {
    case "scope":
      return {
        Overview: `Scope brief for ${title}.`,
        Description: "",
      };
    case "playbook":
      return {
        Overview: `Playbook for ${title}.`,
        Steps: "1. Inspect\n2. Act\n3. Verify",
      };
    case "mission":
      return {
        Outcome: `Mission outcome for ${title}.`,
        Evidence: "",
      };
    case "project":
      return {
        Overview: `Project identity for ${title}.`,
        TechStack: "",
      };
  }
}

function defaultItems(style: XbriefStyle): unknown[] {
  if (style === "playbook") {
    return [
      {
        title: "Inspect",
        status: "proposed",
        narrative: { Acceptance: "Context is loaded and preconditions hold." },
      },
      {
        title: "Act",
        status: "proposed",
        narrative: { Acceptance: "Primary steps complete." },
      },
      {
        title: "Verify",
        status: "proposed",
        narrative: { Acceptance: "Checks pass or failures are recorded." },
      },
    ];
  }
  return [];
}

/** Build a minimal valid xBRIEF v0.8 document for the given P0 style. */
export function buildStyleDocument(input: BuildDocumentInput): XbriefDocument {
  const now = input.now ?? new Date();
  const stamp = isoNow(now);
  const status = input.status ?? defaultStatus(input.style);
  const baseNarratives = defaultNarratives(input.style, input.title);
  const narratives = { ...baseNarratives, ...(input.narratives ?? {}) };
  const items = input.items ?? defaultItems(input.style);

  const plan: XbriefDocument["plan"] = {
    title: input.title,
    status,
    narratives,
    items,
    metadata: {
      kind: input.style,
      xbriefCreate: true,
    },
  };
  if (input.id !== undefined && input.id.length > 0) {
    (plan as { id?: string }).id = input.id;
  }

  return {
    xBRIEFInfo: {
      version: "0.8",
      description: input.description ?? `xBRIEF ${input.style} artifact (on-demand create)`,
      created: stamp,
      updated: stamp,
    },
    plan,
  };
}

function sectionBody(doc: XbriefDocument, key: string): string {
  const narratives = doc.plan.narratives ?? {};
  // Prefer exact key, then case-insensitive match.
  if (typeof narratives[key] === "string") return narratives[key];
  const lower = key.toLowerCase();
  for (const [k, v] of Object.entries(narratives)) {
    if (k.toLowerCase() === lower && typeof v === "string") return v;
  }
  return "";
}

function renderItemsList(doc: XbriefDocument, heading: string): string {
  const lines: string[] = [`## ${heading}`, ""];
  const items = Array.isArray(doc.plan.items) ? doc.plan.items : [];
  if (items.length === 0) {
    lines.push("_(none)_", "");
    return lines.join("\n");
  }
  for (const raw of items) {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      lines.push(`- ${String(raw)}`);
      continue;
    }
    const item = raw as Record<string, unknown>;
    const title = typeof item.title === "string" ? item.title : "(untitled)";
    const status = typeof item.status === "string" ? item.status : "unknown";
    lines.push(`- **${title}** (${status})`);
  }
  lines.push("");
  return lines.join("\n");
}

/** Render dense markdown from the JSON spine (one dialect). */
export function renderMarkdown(doc: XbriefDocument, style: XbriefStyle): string {
  const idLine =
    typeof doc.plan.id === "string" && doc.plan.id.length > 0 ? `id: ${doc.plan.id}\n` : "";
  const header = [
    "---",
    "xbrief: 0.8",
    `style: ${style}`,
    idLine.trimEnd() === "" ? null : idLine.trimEnd(),
    "---",
    "",
    `# ${doc.plan.title}`,
    "",
  ]
    .filter((line): line is string => line !== null)
    .join("\n");

  const sections = MD_REQUIRED_SECTIONS[style];
  const parts: string[] = [header];

  for (const section of sections) {
    if (section === "Title") {
      parts.push("## Title", "", doc.plan.title, "");
      continue;
    }
    if (section === "Status") {
      parts.push("## Status", "", String(doc.plan.status), "");
      continue;
    }
    if (section === "Items" || section === "Steps") {
      parts.push(renderItemsList(doc, section));
      // Also include narrative Steps when present for playbook density.
      if (section === "Steps") {
        const stepsNarrative = sectionBody(doc, "Steps");
        if (stepsNarrative.length > 0) {
          parts.push("### Steps narrative", "", stepsNarrative, "");
        }
      }
      continue;
    }
    const body = sectionBody(doc, section);
    parts.push(`## ${section}`, "", body.length > 0 ? body : "_(empty)_", "");
  }

  return `${parts
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trimEnd()}\n`;
}

/**
 * Lightweight parse of md form for verify: extract title, status, id, and H2 sections.
 * Not a full reverse dialect — verify uses it for required-section + consistency checks.
 */
export function parseMarkdownMeta(md: string): {
  title: string | null;
  status: string | null;
  id: string | null;
  style: string | null;
  sections: Set<string>;
} {
  const sections = new Set<string>();
  let title: string | null = null;
  let status: string | null = null;
  let id: string | null = null;
  let style: string | null = null;

  const lines = md.split(/\r?\n/);
  let inFront = false;
  let afterTitleH2 = false;
  let afterStatusH2 = false;

  for (const line of lines) {
    if (line.trim() === "---") {
      inFront = !inFront;
      continue;
    }
    if (inFront) {
      // Linear field parse — avoids js/polynomial-redos on \s*(.+)\s* (#3174 alerts #84-#85).
      const idValue = frontmatterField(line, "id");
      if (idValue !== null) id = idValue;
      const styleValue = frontmatterField(line, "style");
      if (styleValue !== null) style = styleValue;
      continue;
    }

    // Linear ATX heading parse — avoids js/polynomial-redos on ^#+\s+(.+)$ (#3174 alerts #86-#87).
    const heading = parseMarkdownHeading(line);
    if (heading !== null) {
      const name = heading.text.trim();
      if (heading.hashes === "#" && title === null) {
        title = name;
      } else if (heading.hashes === "##") {
        sections.add(name);
        afterTitleH2 = name === "Title";
        afterStatusH2 = name === "Status";
        continue;
      }
    }

    if (afterTitleH2 && line.trim().length > 0 && !line.startsWith("#")) {
      // Prefer ## Title body over H1 when present.
      title = line.trim();
      afterTitleH2 = false;
    }
    if (afterStatusH2 && line.trim().length > 0 && !line.startsWith("#")) {
      status = line.trim();
      afterStatusH2 = false;
    }
  }

  return { title, status, id, style, sections };
}
