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
  });
});
