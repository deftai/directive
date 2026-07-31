import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { seedMinimalProjectDefinition } from "./init-deposit.js";
import type { InitDepositIo } from "./scaffold.js";

function io(): InitDepositIo & { lines: string[] } {
  const lines: string[] = [];
  return {
    lines,
    printf: (text: string) => {
      lines.push(text);
    },
  };
}

describe("seedMinimalProjectDefinition (#3013)", () => {
  it("creates a minimal PROJECT-DEFINITION.xbrief.json when missing", () => {
    const root = mkdtempSync(join(tmpdir(), "seed-pd-"));
    for (const folder of ["proposed", "pending", "active", "completed", "cancelled"]) {
      mkdirSync(join(root, "xbrief", folder), { recursive: true });
    }
    const sink = io();
    expect(seedMinimalProjectDefinition(root, sink)).toBe(true);
    const pdPath = join(root, "xbrief", "PROJECT-DEFINITION.xbrief.json");
    expect(existsSync(pdPath)).toBe(true);
    const parsed = JSON.parse(readFileSync(pdPath, "utf8")) as {
      plan?: { title?: string; items?: unknown[] };
      xBRIEFInfo?: { version?: string };
    };
    expect(parsed.plan?.title).toBe("PROJECT-DEFINITION");
    expect(Array.isArray(parsed.plan?.items)).toBe(true);
    expect(parsed.xBRIEFInfo?.version).toBeTruthy();
    expect(sink.lines.join("")).toMatch(/#3013|created|seed/i);
  });

  it("does not overwrite an existing PROJECT-DEFINITION", () => {
    const root = mkdtempSync(join(tmpdir(), "seed-pd-exist-"));
    mkdirSync(join(root, "xbrief", "proposed"), { recursive: true });
    const pdPath = join(root, "xbrief", "PROJECT-DEFINITION.xbrief.json");
    writeFileSync(
      pdPath,
      JSON.stringify({
        xBRIEFInfo: { version: "0.8", description: "keep me" },
        plan: {
          title: "PROJECT-DEFINITION",
          status: "running",
          narratives: { Overview: "operator identity" },
          items: [],
        },
      }),
      "utf8",
    );
    const sink = io();
    expect(seedMinimalProjectDefinition(root, sink)).toBe(false);
    const after = JSON.parse(readFileSync(pdPath, "utf8")) as {
      plan?: { narratives?: { Overview?: string } };
    };
    expect(after.plan?.narratives?.Overview).toBe("operator identity");
    expect(sink.lines.join("")).toMatch(/already present/i);
  });

  it("returns false when no lifecycle root exists", () => {
    const root = mkdtempSync(join(tmpdir(), "seed-pd-empty-"));
    const sink = io();
    expect(seedMinimalProjectDefinition(root, sink)).toBe(false);
  });
});
