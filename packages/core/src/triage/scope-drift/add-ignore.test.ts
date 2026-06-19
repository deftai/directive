import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { addIgnore } from "./add-ignore.js";
import { computeDrift, renderDriftReport } from "./index.js";

function writePd(root: string, policy: Record<string, unknown> = {}): void {
  mkdirSync(join(root, "vbrief"), { recursive: true });
  writeFileSync(
    join(root, "vbrief", "PROJECT-DEFINITION.vbrief.json"),
    JSON.stringify({ vBRIEFInfo: { version: "0.6" }, plan: { policy } }),
    "utf8",
  );
}

describe("scope-drift add-ignore", () => {
  it("adds milestone ignore", () => {
    const root = mkdtempSync(join(tmpdir(), "ignore-ms-"));
    writePd(root);
    const result = addIgnore(root, { milestone: "v1" });
    expect(result.changed).toBe(true);
    rmSync(root, { recursive: true, force: true });
  });

  it("adds and dedupes label ignore", () => {
    const root = mkdtempSync(join(tmpdir(), "ignore-"));
    writePd(root);
    const first = addIgnore(root, { label: "noise" });
    expect(first.changed).toBe(true);
    const second = addIgnore(root, { label: "noise" });
    expect(second.changed).toBe(false);
    rmSync(root, { recursive: true, force: true });
  });

  it("renders drift report with labels", () => {
    writePd("/tmp/not-used");
    const text = renderDriftReport({
      labels: { "priority:p0": 4 },
      milestones: {},
      total: 4,
      threshold: 3,
    });
    expect(text).toContain("labels not in subscription");
    expect(text).toContain("task triage:subscribe");
  });

  it("short-circuits all-open subscription", () => {
    const root = mkdtempSync(join(tmpdir(), "all-open-"));
    writePd(root, { triageScope: [{ rule: "all-open" }] });
    const cache = join(root, ".deft-cache");
    mkdirSync(join(cache, "github-issue", "deftai", "directive", "1"), { recursive: true });
    writeFileSync(
      join(cache, "github-issue", "deftai", "directive", "1", "raw.json"),
      JSON.stringify({ number: 1, state: "open", labels: [{ name: "x" }] }),
      "utf8",
    );
    expect(computeDrift(root, { cacheRoot: cache }).total).toBe(0);
    rmSync(root, { recursive: true, force: true });
  });

  it("surfaces milestone drift", () => {
    const root = mkdtempSync(join(tmpdir(), "ms-"));
    writePd(root, { triageScope: [{ rule: "labels", "any-of": ["other"] }] });
    const cache = join(root, ".deft-cache");
    for (const n of [400, 401, 402]) {
      const entry = join(cache, "github-issue", "deftai", "directive", String(n));
      mkdirSync(entry, { recursive: true });
      writeFileSync(
        join(entry, "raw.json"),
        JSON.stringify({ number: n, state: "open", milestone: { title: "v2.0-blocker" } }),
        "utf8",
      );
    }
    const report = computeDrift(root, { cacheRoot: cache });
    expect(report.milestones["v2.0-blocker"]).toBe(3);
    rmSync(root, { recursive: true, force: true });
  });
});
