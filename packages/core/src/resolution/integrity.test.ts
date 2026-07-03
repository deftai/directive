import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  checkLocalEngineIntegrity,
  LOCAL_ENGINE_MARKERS,
  LOCAL_ENGINE_ROOT,
  localEnginePlatformDir,
} from "./integrity.js";

const ROOT = "/proj";
const PLATFORM = "linux";
const platformDir = join(ROOT, LOCAL_ENGINE_ROOT, PLATFORM);

function fsSeams(present: Set<string>) {
  return {
    platform: PLATFORM,
    isFile: (p: string) => present.has(p),
    isDir: (p: string) => present.has(p),
  };
}

describe("resolution/integrity", () => {
  it("resolves the platform-specific install dir", () => {
    expect(localEnginePlatformDir(ROOT, PLATFORM)).toBe(platformDir);
    // default platform path still returns a .deft/.cli/<something> path
    expect(localEnginePlatformDir(ROOT)).toContain(join(LOCAL_ENGINE_ROOT));
  });

  it("classifies a wholly-absent local engine as not present", () => {
    const result = checkLocalEngineIntegrity(ROOT, fsSeams(new Set()));
    expect(result.present).toBe(false);
    expect(result.partial).toBe(false);
    expect(result.usable).toBe(false);
    expect(result.reason).toContain("no local engine");
  });

  it("classifies a complete install as usable", () => {
    const present = new Set<string>([platformDir]);
    for (const marker of LOCAL_ENGINE_MARKERS) {
      present.add(join(platformDir, marker));
    }
    const result = checkLocalEngineIntegrity(ROOT, fsSeams(present));
    expect(result.usable).toBe(true);
    expect(result.present).toBe(true);
    expect(result.partial).toBe(false);
    expect(result.missingMarkers).toHaveLength(0);
  });

  it("treats a present-but-partial install (interrupted) as not-usable", () => {
    // Root dir + only the first marker present; the bin marker is missing.
    const present = new Set<string>([
      platformDir,
      join(platformDir, LOCAL_ENGINE_MARKERS[0] ?? ""),
    ]);
    const result = checkLocalEngineIntegrity(ROOT, fsSeams(present));
    expect(result.present).toBe(true);
    expect(result.partial).toBe(true);
    expect(result.usable).toBe(false);
    expect(result.missingMarkers.length).toBeGreaterThan(0);
    expect(result.reason).toContain("partial local engine");
  });

  it("treats a directory that exists but has no markers as partial", () => {
    const present = new Set<string>([platformDir]);
    const result = checkLocalEngineIntegrity(ROOT, fsSeams(present));
    expect(result.present).toBe(true);
    expect(result.partial).toBe(true);
    expect(result.usable).toBe(false);
  });

  it("falls back to isFile when no isDir seam is supplied", () => {
    const present = new Set<string>([platformDir]);
    for (const marker of LOCAL_ENGINE_MARKERS) present.add(join(platformDir, marker));
    const result = checkLocalEngineIntegrity(ROOT, {
      platform: PLATFORM,
      isFile: (p: string) => present.has(p),
    });
    expect(result.usable).toBe(true);
  });

  it("uses the real filesystem by default (no seams) and reports absent", () => {
    const result = checkLocalEngineIntegrity(
      join("/nonexistent-resolution-root-xyz", String(Date.now())),
    );
    expect(result.present).toBe(false);
    expect(result.usable).toBe(false);
    // default platform dir resolves to .deft/.cli/<os-platform>
    expect(result.platformDir).toContain(LOCAL_ENGINE_ROOT);
  });
});
