import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  appendHistory,
  computeSummary,
  emitOneliner,
  formatOneLiner,
  formatSummary,
} from "./summary.js";

function writeCache(root: string, repo: string, num: number): void {
  const [owner, name] = repo.split("/");
  const dir = join(root, ".deft-cache", "github-issue", owner ?? "", name ?? "", String(num));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "raw.json"), JSON.stringify({ number: num, state: "open" }), "utf8");
}

describe("summary extra branches", () => {
  it("shows reconcile hint when reconcilable > 0", () => {
    const root = mkdtempSync(join(tmpdir(), "sum-rec-"));
    writeCache(root, "deftai/directive", 7);
    mkdirSync(join(root, "vbrief", "pending"), { recursive: true });
    writeFileSync(
      join(root, "vbrief", "pending", "p.vbrief.json"),
      JSON.stringify({
        plan: {
          references: [
            { type: "x-vbrief/github-issue", uri: "https://github.com/deftai/directive/issues/7" },
          ],
        },
      }),
      "utf8",
    );
    const result = computeSummary(root);
    expect(formatSummary(result)).toContain("[triage:reconcile]");
    rmSync(root, { recursive: true, force: true });
  });

  it("scope line when triageScope configured", () => {
    const root = mkdtempSync(join(tmpdir(), "sum-scope-"));
    mkdirSync(join(root, "vbrief"), { recursive: true });
    writeFileSync(
      join(root, "vbrief", "PROJECT-DEFINITION.vbrief.json"),
      JSON.stringify({ plan: { policy: { triageScope: [{ rule: "labels", "any-of": ["x"] }] } } }),
      "utf8",
    );
    mkdirSync(join(root, "vbrief", "active"), { recursive: true });
    writeFileSync(
      join(root, "vbrief", "active", "a.vbrief.json"),
      JSON.stringify({ plan: { status: "running" } }),
      "utf8",
    );
    writeCache(root, "deftai/directive", 11);
    const result = computeSummary(root);
    expect(formatSummary(result)).toContain("plan.policy.triageScope[]");
    rmSync(root, { recursive: true, force: true });
  });

  it("emitOneliner skips history when disabled", () => {
    const root = mkdtempSync(join(tmpdir(), "sum-emit-"));
    const lines: string[] = [];
    emitOneliner(root, { writeHistory: false, output: (l) => lines.push(l) });
    expect(lines.length).toBeGreaterThan(0);
    rmSync(root, { recursive: true, force: true });
  });

  it("appendHistory writes jsonl", () => {
    const root = mkdtempSync(join(tmpdir(), "sum-hist-"));
    const hist = join(root, "vbrief", ".eval", "summary-history.jsonl");
    appendHistory(
      hist,
      {
        cacheEmpty: true,
        untriaged: 0,
        staleDefer: 0,
        inFlight: 0,
        wipCount: 0,
        wipCap: 10,
        repos: [],
        scopeDrift: 0,
        inFlightFilesystem: 0,
        inFlightCacheScoped: 0,
        triageScopeConfigured: false,
        reconcilable: 0,
      },
      "line",
    );
    rmSync(root, { recursive: true, force: true });
  });

  it("truncates at tiny max", () => {
    expect(
      formatOneLiner(
        {
          cacheEmpty: true,
          untriaged: 0,
          staleDefer: 0,
          inFlight: 0,
          wipCount: 0,
          wipCap: 10,
          repos: [],
          scopeDrift: 0,
          inFlightFilesystem: 0,
          inFlightCacheScoped: 0,
          triageScopeConfigured: false,
          reconcilable: 0,
        },
        3,
      ).length,
    ).toBeLessThanOrEqual(3);
  });
});
