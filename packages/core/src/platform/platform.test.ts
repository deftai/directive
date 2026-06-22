import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { contentRoot } from "../content-root.js";
import { agentsRefreshPlan, renderManagedSection, stripManagedSectionAttrs } from "./agents-md.js";
import {
  contentPrefix,
  isOrphanHeader,
  parseSide,
  resolveChangelog,
  unionMerge,
} from "./resolve-changelog-unreleased.js";
import { disambiguateSlug, normalizeSlug } from "./slug-normalize.js";

// #1875: templates/ moved under content/ in the source repo (flattened in a
// consumer deposit). Resolve via content-root probing so both layouts work.
const TEMPLATE = readFileSync(
  join(
    contentRoot(join(import.meta.dirname, "..", "..", "..", "..")),
    "templates",
    "agents-entry.md",
  ),
  "utf8",
);

describe("normalizeSlug", () => {
  it("matches Python unicode fixtures", () => {
    expect(normalizeSlug("Hello World")).toBe("hello-world");
    expect(normalizeSlug("café latte")).toBe("cafe-latte");
    expect(normalizeSlug("El Niño Año")).toBe("el-nino-ano");
    expect(normalizeSlug("日本語")).toBe("untitled");
    expect(normalizeSlug("[x] Fix login")).toBe("fix-login");
    expect(normalizeSlug("con")).toBe("con-scope");
  });

  it("disambiguates collisions", () => {
    const existing = new Set(["hello-world"]);
    expect(disambiguateSlug("hello-world", existing)).toBe("hello-world-2");
  });
});

describe("resolveChangelog", () => {
  const header =
    "# Changelog\n\nAll notable changes to this project will be documented in this file.\n\n";

  it("union-merges conflicting Unreleased entries by issue number", () => {
    const content =
      `${header}## [Unreleased]\n\n` +
      "### Added\n\n" +
      "<<<<<<< HEAD\n" +
      "- **feat: head entry** -- landed (#100)\n" +
      "=======\n" +
      "- **feat: branch entry** -- new (#200)\n" +
      ">>>>>>> branch\n\n" +
      "## [0.1.0] - 2026-01-01\n";

    const { content: resolved, message } = resolveChangelog(content);
    expect(message).toContain("resolved");
    expect(resolved).toContain("(#100)");
    expect(resolved).toContain("(#200)");
    expect(resolved).not.toContain("<<<<<<<");
  });

  it("parseSide preserves indented continuation lines", () => {
    const parsed = parseSide(["- first line", "  continued"], "Added");
    expect(parsed[0]?.[1][0]).toContain("continued");
  });

  it("deduplicates branch entry when issue overlaps HEAD", () => {
    const body =
      "### Added\n\n" +
      "<<<<<<< HEAD\n" +
      "- **feat: same issue** -- head (#911)\n" +
      "=======\n" +
      "- **feat: duplicate** -- branch (#911)\n" +
      ">>>>>>> branch\n";
    const { content: resolved } = resolveChangelog(`${header}## [Unreleased]\n\n${body}`);
    const matches = resolved?.match(/\(#911\)/g) ?? [];
    expect(matches.length).toBe(1);
  });

  it("drops orphan headers and uses content-prefix dedup", () => {
    expect(isOrphanHeader("- **feat(scripts): `gh_rest.py` REST-fallback helpers")).toBe(true);
    const merged = unionMerge(
      [["Added", ["- **feat: canonical** -- body (#1003)"]]],
      [["Added", ["- **feat: canonical** -- body"]]],
    );
    expect(merged[0]?.[1].length).toBe(1);
    expect(contentPrefix("- **Hello** -- world (#1)")).toBe(contentPrefix("- **Hello** -- world"));
  });
});

describe("agentsRefreshPlan", () => {
  it("classifies current managed section when body matches template", () => {
    const rendered = renderManagedSection(TEMPLATE);
    expect(rendered).not.toBeNull();
    const existing = `# User notes\n\n${rendered}\n`;
    const plan = agentsRefreshPlan("/tmp/project", {
      readTemplate: () => TEMPLATE,
      resolveSha: () => "abc123456789",
      nowIso: () => "2026-06-19T12:00:00Z",
      newSession: () => "session123456",
      readAgents: () => existing,
    });
    expect(plan.state).toBe("current");
  });

  it("renderManagedSection returns null without close marker", () => {
    expect(renderManagedSection("<!-- deft:managed-section v3 -->\nno close")).toBeNull();
  });

  it("stale when marker is v2", () => {
    const rendered = renderManagedSection(TEMPLATE);
    expect(rendered).not.toBeNull();
    const legacyOpen = "<!-- deft:managed-section v2 -->";
    const block = (rendered ?? "").replace("<!-- deft:managed-section v3 -->", legacyOpen);
    const plan = agentsRefreshPlan("/tmp/project", {
      readTemplate: () => TEMPLATE,
      resolveSha: () => "abc123456789",
      nowIso: () => "2026-06-19T12:00:00Z",
      newSession: () => "session123456",
      readAgents: () => block,
    });
    expect(plan.state).toBe("stale");
    expect(stripManagedSectionAttrs(block)).toBe(rendered);
  });
});
