import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveSessionRitualStalenessHours } from "./staleness.js";

const temps: string[] = [];
afterEach(() => {
  for (const t of temps) rmSync(t, { recursive: true, force: true });
  temps.length = 0;
});

function writeDef(root: string, plan: unknown): void {
  mkdirSync(join(root, "vbrief"), { recursive: true });
  writeFileSync(
    join(root, "vbrief", "PROJECT-DEFINITION.vbrief.json"),
    JSON.stringify({ vBRIEFInfo: { version: "0.6" }, plan }),
    "utf8",
  );
}

describe("resolveSessionRitualStalenessHours", () => {
  it("returns default when project definition is missing", () => {
    const root = mkdtempSync(join(tmpdir(), "stale-missing-"));
    temps.push(root);
    const result = resolveSessionRitualStalenessHours(root);
    expect(result.hours).toBe(4);
    expect(result.source).toBe("default");
    expect(result.error).not.toBeNull();
  });

  it("returns typed value when configured", () => {
    const root = mkdtempSync(join(tmpdir(), "stale-typed-"));
    temps.push(root);
    writeDef(root, {
      title: "T",
      status: "running",
      items: [],
      policy: { sessionRitualStalenessHours: 6 },
    });
    expect(resolveSessionRitualStalenessHours(root)).toEqual({
      hours: 6,
      source: "typed",
      error: null,
    });
  });

  it("returns default when plan is not an object", () => {
    const root = mkdtempSync(join(tmpdir(), "stale-noplan-"));
    temps.push(root);
    writeDef(root, "nope");
    const result = resolveSessionRitualStalenessHours(root);
    expect(result.source).toBe("default");
    expect(result.error).toContain("plan");
  });

  it("returns default when policy block absent", () => {
    const root = mkdtempSync(join(tmpdir(), "stale-nopolicy-"));
    temps.push(root);
    writeDef(root, { title: "T", status: "running", items: [] });
    const result = resolveSessionRitualStalenessHours(root);
    expect(result.source).toBe("default");
    expect(result.error).toBeNull();
  });

  it("returns default when value is null", () => {
    const root = mkdtempSync(join(tmpdir(), "stale-null-"));
    temps.push(root);
    writeDef(root, {
      title: "T",
      status: "running",
      items: [],
      policy: { sessionRitualStalenessHours: null },
    });
    expect(resolveSessionRitualStalenessHours(root).source).toBe("default");
  });

  it("flags non-integer and non-positive values as default-on-error", () => {
    const root = mkdtempSync(join(tmpdir(), "stale-bad-"));
    temps.push(root);
    writeDef(root, {
      title: "T",
      status: "running",
      items: [],
      policy: { sessionRitualStalenessHours: "bad" },
    });
    const str = resolveSessionRitualStalenessHours(root);
    expect(str.source).toBe("default-on-error");
    expect(str.error).toContain("must be an integer");

    writeDef(root, {
      title: "T",
      status: "running",
      items: [],
      policy: { sessionRitualStalenessHours: 1.5 },
    });
    expect(resolveSessionRitualStalenessHours(root).source).toBe("default-on-error");

    writeDef(root, {
      title: "T",
      status: "running",
      items: [],
      policy: { sessionRitualStalenessHours: 0 },
    });
    const zero = resolveSessionRitualStalenessHours(root);
    expect(zero.source).toBe("default-on-error");
    expect(zero.error).toContain("> 0");
  });
});
