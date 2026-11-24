import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { REPO_ROOT, readRepoFile } from "./helpers.js";

/**
 * Consumer install layout (#7234). The runtime pack hoists content/ children
 * and the harness main.md to node_modules/@deftai/directive-runtime/.
 */
const RUNTIME_PREFIX = "node_modules/@deftai/directive-runtime/";
const CLOSE_MARKER = "<!-- /deft:managed-section -->";

/** templates/….md and main.md citations, with or without the runtime prefix. */
const CITATION =
  /(?<![\w./@-])((?:node_modules\/@deftai\/directive-runtime\/)?(?:templates\/[\w./-]+\.md|main\.md))/g;

function managedSection(text: string): string {
  const start = text.search(/<!-- deft:managed-section\b/);
  const end = text.indexOf(CLOSE_MARKER);
  if (start < 0 || end < start) {
    throw new Error("managed section markers missing");
  }
  return text.slice(start, end + CLOSE_MARKER.length);
}

function citations(section: string): string[] {
  return [...section.matchAll(CITATION)].map((match) => match[1] ?? "");
}

/** Null when the citation is not a path from a consumer project root. */
function sourcePathForConsumerCitation(citation: string): string | null {
  if (!citation.startsWith(RUNTIME_PREFIX)) return null;
  const rel = citation.slice(RUNTIME_PREFIX.length);
  if (rel === "main.md" || rel === "SKILL.md") return join(REPO_ROOT, rel);
  return join(REPO_ROOT, "content", rel);
}

function unresolved(section: string): string[] {
  return citations(section).filter((citation) => {
    const source = sourcePathForConsumerCitation(citation);
    return source === null || !existsSync(source);
  });
}

describe("agents entry consumer paths (#7234)", () => {
  const section = managedSection(readRepoFile("templates/agents-entry.md"));

  it("resolves every templates/ and main.md citation in a consumer layout", () => {
    const found = citations(section);
    expect(found.some((citation) => citation.endsWith("templates/agent-prompt-preamble.md"))).toBe(
      true,
    );
    expect(found.some((citation) => citation.endsWith("main.md"))).toBe(true);
    expect(unresolved(section)).toEqual([]);
  });

  it("fails when a managed-section path citation has no consumer prefix", () => {
    const bare = "full contract: templates/agent-prompt-preamble.md § 5.6. first read main.md § x.";
    expect(unresolved(bare)).toEqual(["templates/agent-prompt-preamble.md", "main.md"]);
  });
});
