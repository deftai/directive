import { describe, expect, it } from "vitest";
import {
  composeGreenfieldAgentsMd,
  containsRetiredUnmanagedHeaderPatterns,
  RETIRED_UNMANAGED_HEADER_SECTIONS,
  renderConsumerHeader,
} from "./agents-consumer-header.js";
import { AGENTS_MANAGED_OPEN_V3_LITERAL } from "./constants.js";

describe("agents-consumer-header", () => {
  it("renders Session orientation without rot-prone Status/Known Issues sections", () => {
    const header = renderConsumerHeader();
    expect(header).toContain("## Session orientation");
    expect(header).toContain("xbrief/PROJECT-DEFINITION.xbrief.json");
    expect(header).toContain("deft triage:queue");
    expect(containsRetiredUnmanagedHeaderPatterns(header)).toBe(false);
  });

  it("composeGreenfieldAgentsMd places header above the managed section", () => {
    const managed = `${AGENTS_MANAGED_OPEN_V3_LITERAL}\n# Deft\n<!-- /deft:managed-section -->`;
    const composed = composeGreenfieldAgentsMd(managed);
    const openIdx = composed.indexOf(AGENTS_MANAGED_OPEN_V3_LITERAL);
    expect(openIdx).toBeGreaterThan(0);
    expect(composed.slice(0, openIdx)).toContain("## Session orientation");
    expect(composed).not.toContain("## Status");
    expect(composed).not.toContain("## Known Issues");
  });

  it("flags retired unmanaged header patterns", () => {
    expect(containsRetiredUnmanagedHeaderPatterns("## Status\nNext: foo")).toBe(true);
    expect(containsRetiredUnmanagedHeaderPatterns("## Known Issues\n- bug")).toBe(true);
    expect(RETIRED_UNMANAGED_HEADER_SECTIONS.length).toBeGreaterThan(0);
  });
});
