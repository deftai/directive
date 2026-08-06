import { describe, expect, it } from "vitest";
import {
  buildStyleDocument,
  MD_REQUIRED_SECTIONS,
  parseMarkdownMeta,
  renderMarkdown,
} from "./styles.js";
import { XBRIEF_STYLES } from "./types.js";

describe("xbrief styles (#3057)", () => {
  it.each([...XBRIEF_STYLES])("builds and renders style=%s with required md sections", (style) => {
    const doc = buildStyleDocument({
      style,
      title: `${style} title`,
      id: `${style}-id`,
      now: new Date("2026-08-02T00:00:00.000Z"),
    });
    expect(doc.xBRIEFInfo.version).toBe("0.8");
    expect(doc.plan.title).toBe(`${style} title`);
    const md = renderMarkdown(doc, style);
    const meta = parseMarkdownMeta(md);
    for (const section of MD_REQUIRED_SECTIONS[style]) {
      expect(meta.sections.has(section)).toBe(true);
    }
    expect(meta.id).toBe(`${style}-id`);
    expect(meta.style).toBe(style);
    expect(meta.title).toBe(`${style} title`);
  });

  it("parseMarkdownMeta reads frontmatter, H1, and H2 sections", () => {
    const md = [
      "---",
      "id: demo-id",
      "style: scope",
      "---",
      "",
      "# Fallback title",
      "",
      "## Title",
      "",
      "Preferred title",
      "",
      "## Status",
      "",
      "draft",
      "",
      "## Overview",
      "",
      "body",
    ].join("\n");
    const meta = parseMarkdownMeta(md);
    expect(meta.id).toBe("demo-id");
    expect(meta.style).toBe("scope");
    expect(meta.title).toBe("Preferred title");
    expect(meta.status).toBe("draft");
    expect(meta.sections.has("Title")).toBe(true);
    expect(meta.sections.has("Overview")).toBe(true);
  });

  // CodeQL js/polynomial-redos regression (#3174 alerts #84-#87): pathological
  // space padding must stay linear-time and still parse legitimate fields.
  it("parseMarkdownMeta stays linear on long space padding", () => {
    const spaces = " ".repeat(20_000);
    const md = [
      "---",
      `id:${spaces}demo-id${spaces}`,
      `style:${spaces}scope${spaces}`,
      "---",
      `#${spaces}H1 Title`,
      `##${spaces}Title`,
      "Body title",
      `##${spaces}Status`,
      "running",
    ].join("\n");
    const start = performance.now();
    const meta = parseMarkdownMeta(md);
    expect(performance.now() - start).toBeLessThan(100);
    expect(meta.id).toBe("demo-id");
    expect(meta.style).toBe("scope");
    expect(meta.title).toBe("Body title");
    expect(meta.status).toBe("running");
    expect(meta.sections.has("Title")).toBe(true);
    expect(meta.sections.has("Status")).toBe(true);
  });

  it("parseMarkdownMeta ignores empty frontmatter values and non-headings", () => {
    const md = ["---", "id:   ", "style:", "---", "#", "##   ", "plain"].join("\n");
    const meta = parseMarkdownMeta(md);
    expect(meta.id).toBeNull();
    expect(meta.style).toBeNull();
    expect(meta.title).toBeNull();
    expect(meta.sections.size).toBe(0);
  });
});
