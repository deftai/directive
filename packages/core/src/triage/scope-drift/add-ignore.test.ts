import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readPlanPolicy } from "../../policy/plan-extensions.js";
import { addIgnore } from "./add-ignore.js";
import { computeDrift, renderDriftReport } from "./index.js";
import { resolveScopeIgnores } from "./scope-rules.js";

function writePd(root: string, policy: Record<string, unknown> = {}): void {
  mkdirSync(join(root, "xbrief"), { recursive: true });
  writeFileSync(
    join(root, "xbrief", "PROJECT-DEFINITION.xbrief.json"),
    JSON.stringify({ xBRIEFInfo: { version: "0.8" }, plan: { policy } }),
    "utf8",
  );
}

function writeMigratedPd(root: string, policy: Record<string, unknown> = {}): void {
  mkdirSync(join(root, "xbrief", "active"), { recursive: true });
  writeFileSync(
    join(root, "xbrief", "active", "seed.xbrief.json"),
    JSON.stringify({ xBRIEFInfo: { version: "0.8" }, plan: { title: "s", status: "running" } }),
    "utf8",
  );
  writeFileSync(
    join(root, "xbrief", "PROJECT-DEFINITION.xbrief.json"),
    JSON.stringify({ xBRIEFInfo: { version: "0.8" }, plan: { policy } }),
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

  // #2210: write-side mirror of #2207 — addIgnore must target the layout-resolved
  // xbrief/ PROJECT-DEFINITION on migrated trees so triage:queue sees the ignores.
  it("writes triageScopeIgnores to a migrated xbrief tree", () => {
    const root = mkdtempSync(join(tmpdir(), "ignore-xbrief-"));
    writeMigratedPd(root);
    const xbriefPd = join(root, "xbrief", "PROJECT-DEFINITION.xbrief.json");
    const vbriefPd = join(root, "vbrief", "PROJECT-DEFINITION.vbrief.json");

    const result = addIgnore(root, { label: "noise" });
    expect(result.changed).toBe(true);
    expect(existsSync(xbriefPd)).toBe(true);
    expect(existsSync(vbriefPd)).toBe(false);

    const ignores = resolveScopeIgnores(root);
    expect(ignores.labels.has("noise")).toBe(true);

    const written = JSON.parse(readFileSync(xbriefPd, "utf8")) as unknown;
    if (written === null || typeof written !== "object") {
      throw new Error("expected object PROJECT-DEFINITION");
    }
    const policy = readPlanPolicy((written as { plan: unknown }).plan) as {
      triageScopeIgnores: Array<{ label: string }>;
    };
    expect(policy.triageScopeIgnores).toEqual([{ label: "noise" }]);
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
