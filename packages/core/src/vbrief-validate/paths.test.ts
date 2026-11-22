import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { resolveRefPath, scopeIdsForRefUri, stripFileScheme } from "./paths.js";

const temps: string[] = [];
afterAll(() => {
  for (const t of temps) rmSync(t, { recursive: true, force: true });
});

describe("stripFileScheme (#6925)", () => {
  it("drops a leading file:// scheme and leaves other refs unchanged", () => {
    expect(stripFileScheme("file://proposed/epic.xbrief.json")).toBe("proposed/epic.xbrief.json");
    expect(stripFileScheme("proposed/epic.xbrief.json")).toBe("proposed/epic.xbrief.json");
    expect(stripFileScheme("https://example.com/x")).toBe("https://example.com/x");
  });

  it("is the scheme strip resolveRefPath and scopeIdsForRefUri use", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-paths-"));
    temps.push(root);
    mkdirSync(join(root, "proposed"), { recursive: true });
    writeFileSync(join(root, "proposed", "epic.xbrief.json"), "{}", "utf8");
    expect(resolveRefPath("file://proposed/epic.xbrief.json", root)).toBe(
      resolveRefPath("proposed/epic.xbrief.json", root),
    );
    expect(resolveRefPath("https://example.com/x", root)).toBeNull();
    expect([...scopeIdsForRefUri("file://proposed/2026-11-21-1840-epic.xbrief.json")]).toEqual([
      "2026-11-21-1840-epic",
      "1840-epic",
    ]);
  });
});
