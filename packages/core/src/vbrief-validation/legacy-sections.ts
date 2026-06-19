import { splitLines, stripLeadingWhitespace, stripTrailingWhitespace } from "./normalize.js";
import type { SectionTuple } from "./types.js";

/** Legacy section helpers consumed by fidelity (#495 / #506 D5). */

export const CANONICAL_SPEC_KEYS = [
  "Overview",
  "Architecture",
  "ProblemStatement",
  "Goals",
  "UserStories",
  "Requirements",
  "NonFunctionalRequirements",
  "SuccessMetrics",
  "TestingStrategy",
  "Deployment",
] as const;

export const SPEC_KNOWN_MAPPINGS: Readonly<Record<string, string>> = {
  overview: "Overview",
  summary: "Overview",
  architecture: "Architecture",
  "system design": "Architecture",
  "technical architecture": "Architecture",
  "problem statement": "ProblemStatement",
  problem: "ProblemStatement",
  background: "ProblemStatement",
  goals: "Goals",
  objectives: "Goals",
  "user stories": "UserStories",
  "use cases": "UserStories",
  requirements: "Requirements",
  "functional requirements": "Requirements",
  "non functional requirements": "NonFunctionalRequirements",
  nfrs: "NonFunctionalRequirements",
  "success metrics": "SuccessMetrics",
  "acceptance criteria": "SuccessMetrics",
  "acceptance criteria project level": "SuccessMetrics",
  "testing strategy": "TestingStrategy",
  "test plan": "TestingStrategy",
  testing: "TestingStrategy",
  deployment: "Deployment",
  "deployment plan": "Deployment",
};

/** Apply the four normalization rules from #506 D5 (+ CamelCase split). */
export function normalizeTitle(title: string): string {
  const raw = title ?? "";
  const split = raw.replace(/(?<=[a-z0-9])(?=[A-Z])/g, " ");
  let low = split.toLowerCase().trim();
  low = low.replace(/[^a-z0-9\s_-]/g, " ");
  low = low.replace(/[-_]+/g, " ");
  return low.replace(/\s+/g, " ").trim();
}

/** Return the canonical key for ``title`` or null if not a known alias. */
export function lookupCanonical(
  title: string,
  mapping: Readonly<Record<string, string>>,
): string | null {
  return mapping[normalizeTitle(title)] ?? null;
}

/** Split markdown at top-level ``## `` boundaries. */
export function parseTopLevelSections(content: string): SectionTuple[] {
  if (!content) {
    return [];
  }
  const lines = splitLines(content);
  const sections: SectionTuple[] = [];
  let inFence = false;
  let currentTitle: string | null = null;
  let currentStart = 0;
  const currentBody: string[] = [];

  const flush = (endLine: number): void => {
    if (currentTitle === null) {
      return;
    }
    const body = stripTrailingWhitespace(currentBody.join("\n"));
    sections.push([currentTitle, body, currentStart, endLine]);
  };

  for (let idx = 0; idx < lines.length; idx += 1) {
    const line = lines[idx] ?? "";
    const lineNo = idx + 1;
    const stripped = line.replace(/^\s+/, "");
    if (stripped.startsWith("```")) {
      inFence = !inFence;
      if (currentTitle !== null) {
        currentBody.push(line);
      }
      continue;
    }
    if (!inFence) {
      // Equivalent of ``/^##\s+(.+?)\s*$/`` (h2 heading) without backtracking:
      // ``##`` then >=1 whitespace then >=1 character, captured fully trimmed.
      const rest = line.startsWith("##") ? line.slice(2) : "";
      if (rest.length >= 2 && /\s/.test(rest[0] as string)) {
        flush(lineNo - 1);
        currentTitle = stripTrailingWhitespace(stripLeadingWhitespace(rest));
        currentStart = lineNo;
        currentBody.length = 0;
        continue;
      }
    }
    if (currentTitle !== null) {
      currentBody.push(line);
    }
  }
  flush(lines.length);
  return sections;
}

/** Split parsed sections into canonical vs legacy buckets. */
export function partitionSections(
  sections: readonly SectionTuple[],
  mapping: Readonly<Record<string, string>>,
): [Record<string, string>, SectionTuple[]] {
  const canonical: Record<string, string> = {};
  const legacy: SectionTuple[] = [];
  for (const [title, body, start, end] of sections) {
    const key = lookupCanonical(title, mapping);
    if (key === null) {
      legacy.push([title, body, start, end]);
      continue;
    }
    if (!body.trim()) {
      continue;
    }
    if (key in canonical) {
      canonical[key] = `${stripTrailingWhitespace(canonical[key] ?? "")}\n\n${body.trim()}`;
    } else {
      canonical[key] = body.trim();
    }
  }
  return [canonical, legacy];
}
