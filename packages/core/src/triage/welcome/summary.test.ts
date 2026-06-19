import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { computeSummary, formatOneLiner, formatSummary } from "./summary.js";

function writeCache(root: string, repo: string, num: number): void {
  const [owner, name] = repo.split("/");
  const dir = join(root, ".deft-cache", "github-issue", owner ?? "", name ?? "", String(num));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "raw.json"), JSON.stringify({ number: num, state: "open" }), "utf8");
}

describe("welcome summary", () => {
  it("formats empty cache line", () => {
    const result = computeSummary(mkdtempSync(join(tmpdir(), "sum-")));
    expect(formatOneLiner(result)).toContain("cache empty");
  });

  it("counts untriaged cached issues", () => {
    const root = mkdtempSync(join(tmpdir(), "sum2-"));
    writeCache(root, "deftai/directive", 1);
    writeCache(root, "deftai/directive", 2);
    const result = computeSummary(root);
    expect(result.cacheEmpty).toBe(false);
    expect(result.untriaged).toBe(2);
    expect(formatSummary(result)).toContain("2 untriaged");
    rmSync(root, { recursive: true, force: true });
  });

  it("includes WIP warning at cap", () => {
    const root = mkdtempSync(join(tmpdir(), "sum3-"));
    mkdirSync(join(root, "vbrief"), { recursive: true });
    writeFileSync(
      join(root, "vbrief", "PROJECT-DEFINITION.vbrief.json"),
      JSON.stringify({ plan: { policy: { wipCap: 1 } } }),
      "utf8",
    );
    mkdirSync(join(root, "vbrief", "pending"), { recursive: true });
    writeFileSync(join(root, "vbrief", "pending", "a.vbrief.json"), "{}", "utf8");
    writeFileSync(join(root, "vbrief", "pending", "b.vbrief.json"), "{}", "utf8");
    writeCache(root, "deftai/directive", 9);
    const result = computeSummary(root);
    expect(formatOneLiner(result)).toContain("\u26a0");
    rmSync(root, { recursive: true, force: true });
  });

  it("adds scope discrepancy second line", () => {
    const root = mkdtempSync(join(tmpdir(), "sum4-"));
    mkdirSync(join(root, "vbrief", "active"), { recursive: true });
    writeFileSync(
      join(root, "vbrief", "active", "run.vbrief.json"),
      JSON.stringify({ plan: { status: "running" } }),
      "utf8",
    );
    writeCache(root, "deftai/directive", 10);
    const result = computeSummary(root);
    expect(formatSummary(result)).toContain("[triage:scope]");
    rmSync(root, { recursive: true, force: true });
  });

  it("includes stale defer segment", () => {
    const root = mkdtempSync(join(tmpdir(), "sum6-"));
    writeCache(root, "deftai/directive", 3);
    mkdirSync(join(root, "vbrief", ".eval"), { recursive: true });
    writeFileSync(
      join(root, "vbrief", ".eval", "candidates.jsonl"),
      `${JSON.stringify({ repo: "deftai/directive", issue_number: 3, decision: "resume-eligible" })}\n`,
      "utf8",
    );
    const result = computeSummary(root);
    expect(formatOneLiner(result)).toContain("stale-defer");
    rmSync(root, { recursive: true, force: true });
  });

  it("truncates long one-liner", () => {
    const text = formatOneLiner(
      {
        cacheEmpty: false,
        untriaged: 999,
        staleDefer: 50,
        inFlight: 40,
        wipCount: 99,
        wipCap: 10,
        repos: [],
        scopeDrift: 5,
        inFlightFilesystem: 40,
        inFlightCacheScoped: 0,
        triageScopeConfigured: false,
        reconcilable: 0,
      },
      40,
    );
    expect(text.length).toBeLessThanOrEqual(40);
  });
});
