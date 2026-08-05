import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  defaultSurfaceFingerprints,
  liveGenerationPath,
  parseLiveGeneration,
  readLiveGeneration,
  stampLiveGeneration,
} from "./generation.js";

const temps: string[] = [];

function tempProject(): string {
  const root = mkdtempSync(join(tmpdir(), "deft-fresh-gen-"));
  temps.push(root);
  mkdirSync(join(root, ".deft", "core"), { recursive: true });
  mkdirSync(join(root, "xbrief"), { recursive: true });
  writeFileSync(join(root, "package.json"), `${JSON.stringify({ name: "fresh-fixture" })}\n`);
  writeFileSync(
    join(root, "xbrief", "PROJECT-DEFINITION.xbrief.json"),
    `${JSON.stringify({ xBRIEFInfo: { version: "0.8" }, plan: { title: "t" } })}\n`,
  );
  return root;
}

afterEach(() => {
  while (temps.length > 0) {
    const p = temps.pop();
    if (p) {
      try {
        rmSync(p, { recursive: true, force: true });
      } catch {
        // ignore
      }
    }
  }
});

describe("stampLiveGeneration (#3117)", () => {
  it("stamps generation 1 on first apply", () => {
    const root = tempProject();
    const token = stampLiveGeneration(root, {
      contentVersion: "1.2.3",
      stampedBy: "directive-init",
      increment: true,
      nowIso: "2026-08-04T12:00:00Z",
    });
    expect(token.generation).toBe(1);
    expect(token.contentVersion).toBe("1.2.3");
    expect(existsSync(liveGenerationPath(root))).toBe(true);
    const read = readLiveGeneration(root);
    expect(read?.generation).toBe(1);
    expect(read?.stampedBy).toBe("directive-init");
    expect(read?.surfaces).toEqual(defaultSurfaceFingerprints("1.2.3"));
  });

  it("increments monotonically on subsequent swaps", () => {
    const root = tempProject();
    stampLiveGeneration(root, {
      contentVersion: "1.0.0",
      stampedBy: "directive-init",
      increment: true,
    });
    const second = stampLiveGeneration(root, {
      contentVersion: "1.1.0",
      stampedBy: "directive-update",
      increment: true,
    });
    expect(second.generation).toBe(2);
    const third = stampLiveGeneration(root, {
      contentVersion: "1.2.0",
      stampedBy: "directive-update",
      increment: true,
    });
    expect(third.generation).toBe(3);
  });

  it("does not bump or rewrite on already-current ensure when content version matches", () => {
    const root = tempProject();
    stampLiveGeneration(root, {
      contentVersion: "2.0.0",
      stampedBy: "directive-init",
      increment: true,
      nowIso: "2026-08-04T10:00:00Z",
    });
    const before = readFileSync(liveGenerationPath(root), "utf8");
    const ensured = stampLiveGeneration(root, {
      contentVersion: "2.0.0",
      stampedBy: "directive-update",
      increment: false,
      nowIso: "2026-08-04T11:00:00Z",
    });
    expect(ensured.generation).toBe(1);
    expect(ensured.contentVersion).toBe("2.0.0");
    expect(ensured.stampedBy).toBe("directive-init");
    expect(readFileSync(liveGenerationPath(root), "utf8")).toBe(before);
  });

  it("bumps when content version changes even without increment flag", () => {
    const root = tempProject();
    stampLiveGeneration(root, {
      contentVersion: "2.0.0",
      stampedBy: "directive-init",
      increment: true,
    });
    const next = stampLiveGeneration(root, {
      contentVersion: "2.1.0",
      stampedBy: "directive-update",
      increment: false,
    });
    expect(next.generation).toBe(2);
  });

  it("parseLiveGeneration rejects invalid records", () => {
    expect(parseLiveGeneration(null)).toBeNull();
    expect(parseLiveGeneration({ generation: 0, contentVersion: "1" })).toBeNull();
    expect(
      parseLiveGeneration({
        generation: 1,
        contentVersion: "1.0.0",
        stampedAt: "t",
        stampedBy: "x",
      }),
    ).toMatchObject({ generation: 1 });
  });
});
