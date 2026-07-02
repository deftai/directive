import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { containsRetiredUnmanagedHeaderPatterns } from "../../platform/agents-consumer-header.js";
import { repoPath } from "./helpers.js";

/** Reference fixture for #2065 Option A retired-header consumer scaffold. */

describe("consumer_header_scaffold_fixture", () => {
  const fixture = readFileSync(
    repoPath("tests/fixtures/agents-md/consumer-header-scaffold.md"),
    "utf8",
  );

  it("includes Session orientation and omits rot-prone sections", () => {
    expect(fixture).toContain("## Session orientation");
    expect(fixture).toContain("deft triage:queue");
    expect(fixture).not.toContain("## Status");
    expect(fixture).not.toContain("## Known Issues");
    expect(containsRetiredUnmanagedHeaderPatterns(fixture)).toBe(false);
  });

  it("places unmanaged header above the managed-section marker", () => {
    const marker = "<!-- deft:managed-section v3 -->";
    const markerIdx = fixture.indexOf(marker);
    expect(markerIdx).toBeGreaterThan(0);
    expect(fixture.slice(0, markerIdx)).toContain("## Session orientation");
  });
});
