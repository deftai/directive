import { readFileSync } from "node:fs";
import { DEPRECATION_SENTINEL } from "./constants.js";
import type { CompletedRoadmapItem, JsonObject, RoadmapItem } from "./types.js";

/** Parse ROADMAP.md and extract items as structured data. */
export function parseRoadmapItems(roadmapPath: string): {
  readonly items: RoadmapItem[];
  readonly phaseDescriptions: Record<string, string>;
  readonly completedItems: CompletedRoadmapItem[];
} {
  try {
    readFileSync(roadmapPath);
  } catch {
    return { items: [], phaseDescriptions: {}, completedItems: [] };
  }

  const content = readFileSync(roadmapPath, "utf8");
  const items: RoadmapItem[] = [];
  const completedItems: CompletedRoadmapItem[] = [];
  const phaseDescriptions: Record<string, string> = {};
  let currentPhase = "";
  let currentTier = "";
  let inCompleted = false;
  const descLines: string[] = [];
  let capturingDesc = false;
  let syntheticCounter = 0;

  for (const line of content.split("\n")) {
    const phaseMatch = line.match(/^##\s+(.+)/);
    if (phaseMatch) {
      if (currentPhase && descLines.length > 0) {
        phaseDescriptions[currentPhase] = descLines.join("\n").trim();
      }
      descLines.length = 0;
      currentPhase = phaseMatch[1]?.trim() ?? "";
      currentTier = "";
      if (currentPhase.toLowerCase().includes("completed")) {
        inCompleted = true;
        capturingDesc = false;
      } else {
        inCompleted = false;
        capturingDesc = true;
      }
      continue;
    }

    const tierMatch = line.match(/^###\s+(.+)/);
    if (tierMatch) {
      if (currentPhase && descLines.length > 0 && capturingDesc) {
        phaseDescriptions[currentPhase] = descLines.join("\n").trim();
        descLines.length = 0;
        capturingDesc = false;
      }
      currentTier = tierMatch[1]?.trim() ?? "";
      continue;
    }

    if (capturingDesc && !inCompleted) {
      const stripped = line.trim();
      if (stripped && !stripped.startsWith("-")) {
        descLines.push(stripped);
        continue;
      }
      if (stripped.startsWith("-")) {
        if (descLines.length > 0) {
          phaseDescriptions[currentPhase] = descLines.join("\n").trim();
          descLines.length = 0;
        }
        capturingDesc = false;
      } else {
        if (descLines.length > 0) {
          descLines.push("");
        }
        continue;
      }
    }

    if (!currentPhase) {
      continue;
    }

    if (inCompleted) {
      const compMatch = line.match(/^-\s+~~(?:#?(\d+)\s*--?\s*)?(.+?)~~/);
      if (compMatch) {
        completedItems.push({
          number: compMatch[1] ?? "",
          title: compMatch[2]?.trim() ?? "",
          phase: currentPhase,
        });
      }
      continue;
    }

    const itemMatch = line.match(/^-\s+\*\*#(\d+)\*\*\s+--\s+(.+)/);
    if (itemMatch) {
      items.push({
        number: itemMatch[1] ?? "",
        title: itemMatch[2]?.trim() ?? "",
        phase: currentPhase,
        tier: currentTier,
      });
      continue;
    }

    const taskMatch = line.match(/^-\s+(?:\*\*)?`([^`]+)`(?:\*\*)?\s+(.+)/);
    if (taskMatch) {
      items.push({
        number: "",
        title: taskMatch[2]?.trim() ?? "",
        phase: currentPhase,
        tier: currentTier,
        task_id: taskMatch[1]?.trim() ?? "",
      });
      continue;
    }

    const genericMatch = line.match(/^-\s+(.+)/);
    if (genericMatch) {
      const title = genericMatch[1]?.trim() ?? "";
      if (!title) {
        continue;
      }
      syntheticCounter += 1;
      items.push({
        number: "",
        title,
        phase: currentPhase,
        tier: currentTier,
        synthetic_id: `roadmap-${syntheticCounter}`,
      });
    }
  }

  if (currentPhase && descLines.length > 0 && !inCompleted) {
    phaseDescriptions[currentPhase] = descLines.join("\n").trim();
  }

  return { items, phaseDescriptions, completedItems };
}

/** Resolve the GitHub repository URL from spec_vbrief metadata. */
export function resolveRepoUrl(specVbrief: JsonObject | null | undefined): string {
  if (specVbrief) {
    const vbriefInfo = specVbrief.vBRIEFInfo;
    if (typeof vbriefInfo === "object" && vbriefInfo !== null && !Array.isArray(vbriefInfo)) {
      const repo = (vbriefInfo as JsonObject).repository;
      if (typeof repo === "string" && repo.length > 0) {
        return `https://github.com/${repo}`;
      }
    }
    const plan = specVbrief.plan;
    if (typeof plan === "object" && plan !== null && !Array.isArray(plan)) {
      const refs = (plan as JsonObject).references;
      if (Array.isArray(refs)) {
        for (const ref of refs) {
          if (typeof ref !== "object" || ref === null || Array.isArray(ref)) {
            continue;
          }
          const uri = String((ref as JsonObject).uri ?? "");
          let host = "";
          try {
            host = new URL(uri).hostname;
          } catch {
            host = "";
          }
          if (host === "github.com" || host === "www.github.com") {
            const parts = uri.split("github.com/").pop()?.split("/") ?? [];
            if (parts.length >= 2) {
              return `https://github.com/${parts[0]}/${parts[1]}`;
            }
          }
        }
      }
    }
  }
  return "";
}

/** Extract a tech-stack string from PROJECT.md content. */
export function extractTechStack(projectContent: string): string {
  const boldMatch = projectContent.match(/\*\*Tech\s+Stack\*\*\s*:\s*(.+)/i);
  if (boldMatch) {
    return boldMatch[1]?.trim() ?? "";
  }

  // Python oracle: re.search(r"##\s+Tech\s+Stack\s*\n(.*?)(?=\n##\s|\Z)", ...,
  // re.IGNORECASE | re.DOTALL). The capture is the minimal (lazy) run after the
  // heading up to the next "\n## " heading OR the absolute end of string (\Z).
  // We decompose into linear primitives: a non-backtracking heading match, then
  // a slice up to the first "\n##\s" (or the whole remainder). This removes the
  // lazy-dotAll polynomial source (js/polynomial-redos) AND fixes the prior
  // ``\Z`` mistranslation (a literal ``Z``) that diverged from the oracle when a
  // ``## Tech Stack`` section ran to end-of-string. See scripts/_vbrief_sources.py:193.
  const headingMatch = projectContent.match(/##\s+Tech\s+Stack\s*\n/i);
  if (headingMatch?.index !== undefined) {
    const bodyStart = headingMatch.index + headingMatch[0].length;
    const remainder = projectContent.slice(bodyStart);
    const nextHeading = remainder.match(/\n##\s/);
    const body =
      nextHeading?.index !== undefined ? remainder.slice(0, nextHeading.index) : remainder;
    const section = body.trim();
    if (section) {
      return section;
    }
  }

  const plainMatch = projectContent.match(/Tech\s+Stack\s*:\s*(.+)/i);
  if (plainMatch) {
    return plainMatch[1]?.trim() ?? "";
  }

  return "";
}

/** Return the first non-empty prose paragraph from markdown content. */
export function firstProseParagraph(content: string): string {
  if (!content) {
    return "";
  }
  let firstH1 = "";
  let inCodeBlock = false;
  const paragraphLines: string[] = [];

  const flush = (): string => {
    if (paragraphLines.length > 0) {
      return paragraphLines.join(" ").trim();
    }
    return "";
  };

  for (const line of content.split("\n")) {
    const stripped = line.trim();
    if (stripped.startsWith("```")) {
      inCodeBlock = !inCodeBlock;
      continue;
    }
    if (inCodeBlock) {
      continue;
    }
    if (/^#\s+/.test(stripped) && !firstH1) {
      firstH1 = stripped.replace(/^#\s+/, "").trim();
      continue;
    }
    if (stripped.startsWith("#")) {
      const para = flush();
      if (para) {
        return para;
      }
      paragraphLines.length = 0;
      continue;
    }
    if (
      stripped.startsWith("-") ||
      stripped.startsWith("*") ||
      stripped.startsWith(">") ||
      stripped.startsWith("|") ||
      /^\d+\.\s/.test(stripped)
    ) {
      const para = flush();
      if (para) {
        return para;
      }
      paragraphLines.length = 0;
      continue;
    }
    if (!stripped) {
      const para = flush();
      if (para) {
        return para;
      }
      paragraphLines.length = 0;
      continue;
    }
    paragraphLines.push(stripped);
  }

  const para = flush();
  if (para) {
    return para;
  }
  return firstH1;
}

/** Derive an Overview narrative for PROJECT-DEFINITION.vbrief.json (#417). */
export function deriveOverviewNarrative(
  specVbrief: JsonObject | null | undefined,
  specMdContent: string | null | undefined,
  projectContent: string | null | undefined,
  scopeItemCount: number,
): string {
  if (specVbrief) {
    const plan = specVbrief.plan;
    if (typeof plan === "object" && plan !== null && !Array.isArray(plan)) {
      const narratives = (plan as JsonObject).narratives;
      if (typeof narratives === "object" && narratives !== null && !Array.isArray(narratives)) {
        const ov = (narratives as JsonObject).Overview;
        if (typeof ov === "string" && ov.trim().length > 0) {
          return ov.trim();
        }
      }
    }
  }

  if (specMdContent && !specMdContent.includes(DEPRECATION_SENTINEL)) {
    const derived = firstProseParagraph(specMdContent);
    if (derived) {
      return derived;
    }
  }

  if (projectContent && !projectContent.includes(DEPRECATION_SENTINEL)) {
    const derived = firstProseParagraph(projectContent);
    if (derived) {
      return derived;
    }
  }

  if (scopeItemCount > 0) {
    return (
      "Project overview was not auto-derived during migration. " +
      `${scopeItemCount} scope item(s) were created in vbrief/pending/. ` +
      "Update vbrief/PROJECT-DEFINITION.vbrief.json narratives['Overview'] " +
      "manually to describe your project."
    );
  }
  return (
    "Project overview was not auto-derived during migration. " +
    "Update vbrief/PROJECT-DEFINITION.vbrief.json narratives['Overview'] " +
    "manually to describe your project."
  );
}
