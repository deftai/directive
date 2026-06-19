import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { refreshActive } from "./refresh.js";

function seedActive(root: string, num = 8): string {
  const active = join(root, "vbrief", "active");
  mkdirSync(active, { recursive: true });
  writeFileSync(
    join(active, "s.vbrief.json"),
    JSON.stringify({
      plan: {
        references: [
          {
            type: "x-vbrief/github-issue",
            uri: `https://github.com/deftai/directive/issues/${num}`,
          },
        ],
      },
    }),
    "utf8",
  );
  return active;
}

describe("refreshActive branches", () => {
  it("reports all fresh when no drift", () => {
    const root = mkdtempSync(join(tmpdir(), "refresh-fresh-"));
    seedActive(root, 1);
    const lines: string[] = [];
    const summary = refreshActive(root, {
      fetchLive: () => "2026-06-01T00:00:00Z",
      cacheLoader: () => "2026-06-01T00:00:00Z",
      log: (l) => lines.push(l),
    });
    expect(summary.driftsDetected).toBe(0);
    expect(lines.some((l) => l.includes("all 1 active vBRIEFs fresh"))).toBe(true);
    rmSync(root, { recursive: true, force: true });
  });

  it("warns when fetches skipped without drift", () => {
    const root = mkdtempSync(join(tmpdir(), "refresh-skip-"));
    seedActive(root, 2);
    const lines: string[] = [];
    refreshActive(root, {
      fetchLive: () => {
        throw new Error("skip");
      },
      cacheLoader: () => "2026-06-01T00:00:00Z",
      log: (l) => lines.push(l),
    });
    expect(lines.some((l) => l.includes("fetch(es) were skipped"))).toBe(true);
    rmSync(root, { recursive: true, force: true });
  });

  it("refresh-and-update-local choice", () => {
    const root = mkdtempSync(join(tmpdir(), "refresh-upd-"));
    seedActive(root, 3);
    let refreshed = false;
    const summary = refreshActive(root, {
      inputFn: () => "2",
      fetchLive: () => "2026-06-02T00:00:00Z",
      cacheLoader: () => "2026-06-01T00:00:00Z",
      refreshLocal: () => {
        refreshed = true;
      },
      log: () => {},
    });
    expect(refreshed).toBe(true);
    expect(summary.refreshed).toEqual([["deftai/directive", 3]]);
    rmSync(root, { recursive: true, force: true });
  });

  it("defers on invalid prompt input", () => {
    const root = mkdtempSync(join(tmpdir(), "refresh-def-"));
    seedActive(root, 4);
    const summary = refreshActive(root, {
      inputFn: () => "bogus",
      fetchLive: () => "2026-06-02T00:00:00Z",
      cacheLoader: () => "2026-06-01T00:00:00Z",
      log: () => {},
    });
    expect(summary.deferred).toEqual([["deftai/directive", 4]]);
    rmSync(root, { recursive: true, force: true });
  });

  it("uses default audit writer on proceed", () => {
    const root = mkdtempSync(join(tmpdir(), "refresh-audit-"));
    seedActive(root, 5);
    const lines: string[] = [];
    refreshActive(root, {
      inputFn: () => "1",
      fetchLive: () => "2026-06-02T00:00:00Z",
      cacheLoader: () => "2026-06-01T00:00:00Z",
      log: (l) => lines.push(l),
    });
    expect(lines.some((l) => l.includes("audit annotation"))).toBe(true);
    rmSync(root, { recursive: true, force: true });
  });
});
