import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  FILE_DURATIONS_SCHEMA,
  compareSpecsByCommittedDuration,
  loadFileDurationsFromPath,
  normalizeDurationPathKey,
  parseFileDurationsDocument,
} from "./duration-sequencer.js";

const repoRoot = join(import.meta.dirname, "..", "..", "..", "..");
const configPath = join(repoRoot, "vitest.config.ts");
const fixturePath = join(repoRoot, "packages/core/fixtures/vitest-file-durations.json");

describe("normalizeDurationPathKey (#5028)", () => {
  it("strips project and bare colon prefixes", () => {
    expect(normalizeDurationPathKey("unit:packages/core/src/a.test.ts")).toBe(
      "packages/core/src/a.test.ts",
    );
    expect(normalizeDurationPathKey("spawn-heavy:packages/cli/src/b.test.ts")).toBe(
      "packages/cli/src/b.test.ts",
    );
    expect(normalizeDurationPathKey(":packages/core/src/c.test.ts")).toBe(
      "packages/core/src/c.test.ts",
    );
    expect(normalizeDurationPathKey("packages/core/src/d.test.ts")).toBe(
      "packages/core/src/d.test.ts",
    );
  });

  it("does not strip Windows drive letters", () => {
    expect(normalizeDurationPathKey("C:/Repos/deft/packages/core/src/e.test.ts")).toBe(
      "C:/Repos/deft/packages/core/src/e.test.ts",
    );
  });
});

describe("parseFileDurationsDocument (#5028)", () => {
  it("accepts schema v1 files map", () => {
    const loaded = parseFileDurationsDocument({
      schema: FILE_DURATIONS_SCHEMA,
      files: {
        "packages/core/src/a.test.ts": 100,
        "unit:packages/core/src/b.test.ts": 50,
      },
    });
    expect(loaded.kind).toBe("ok");
    if (loaded.kind !== "ok") return;
    expect(loaded.durations.get("packages/core/src/a.test.ts")).toBe(100);
    expect(loaded.durations.get("packages/core/src/b.test.ts")).toBe(50);
  });

  it("returns invalid for bad schema or non-numeric durations", () => {
    expect(parseFileDurationsDocument({ schema: "other", files: {} }).kind).toBe("invalid");
    expect(
      parseFileDurationsDocument({
        schema: FILE_DURATIONS_SCHEMA,
        files: { "a.test.ts": -1 },
      }).kind,
    ).toBe("invalid");
  });
});

describe("loadFileDurationsFromPath (#5028)", () => {
  it("loads the committed fixture", () => {
    const loaded = loadFileDurationsFromPath(fixturePath);
    expect(loaded.kind).toBe("ok");
    if (loaded.kind !== "ok") return;
    expect(loaded.durations.size).toBeGreaterThan(0);
    expect(
      loaded.durations.has("packages/cli/src/hook-host-identity-lifetime.test.ts"),
    ).toBe(true);
  });

  it("returns missing for absent paths", () => {
    const loaded = loadFileDurationsFromPath(
      join(tmpdir(), "deft-no-such-vitest-file-durations.json"),
    );
    expect(loaded.kind).toBe("missing");
  });

  it("returns invalid for corrupt JSON", () => {
    const dir = mkdtempSync(join(tmpdir(), "deft-durations-"));
    const bad = join(dir, "bad.json");
    writeFileSync(bad, "{not-json", "utf8");
    expect(loadFileDurationsFromPath(bad).kind).toBe("invalid");
  });
});

describe("compareSpecsByCommittedDuration (#5028)", () => {
  const durations = new Map<string, number>([
    ["packages/slow.test.ts", 5000],
    ["packages/fast.test.ts", 100],
  ]);

  it("orders longer listed files first", () => {
    expect(
      compareSpecsByCommittedDuration(
        "packages/slow.test.ts",
        "packages/fast.test.ts",
        durations,
      ),
    ).toBeLessThan(0);
  });

  it("keeps default order when both are unlisted", () => {
    expect(
      compareSpecsByCommittedDuration("packages/a.test.ts", "packages/b.test.ts", durations),
    ).toBe(0);
  });

  it("prefers a listed file over an unlisted peer", () => {
    expect(
      compareSpecsByCommittedDuration(
        "packages/slow.test.ts",
        "packages/unknown.test.ts",
        durations,
      ),
    ).toBeLessThan(0);
  });
});

describe("vitest.config.ts duration sequencer wiring (#5028)", () => {
  const source = readFileSync(configPath, "utf8");

  it("registers DurationSequencer and does not bind host cache.dir", () => {
    expect(source).toContain("#5028");
    expect(source).toMatch(/DurationSequencer/);
    expect(source).toMatch(/sequence:\s*\{[\s\S]*sequencer:\s*DurationSequencer/);
    expect(source).not.toMatch(/cacheDir\s*:/);
    expect(source).not.toMatch(/cache:\s*\{\s*dir:/);
  });

  it("sets spawn-heavy groupOrder before unit (cross-project idle conjunct)", () => {
    expect(source).toMatch(/name:\s*"spawn-heavy"[\s\S]*groupOrder:\s*0/);
    expect(source).toMatch(/name:\s*"unit"[\s\S]*groupOrder:\s*1/);
  });
});
