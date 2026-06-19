import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { computeDrift, renderDriftReport } from "./index.js";

function writePd(root: string, policy: Record<string, unknown> = {}): void {
  mkdirSync(join(root, "vbrief"), { recursive: true });
  writeFileSync(
    join(root, "vbrief", "PROJECT-DEFINITION.vbrief.json"),
    JSON.stringify({
      vBRIEFInfo: { version: "0.6" },
      plan: { title: "x", status: "running", items: [], policy },
    }),
    "utf8",
  );
}

function writeCachedIssue(
  cacheRoot: string,
  repo: string,
  number: number,
  labels: string[] = [],
  milestone?: string,
): void {
  const [owner, name] = repo.split("/");
  const entry = join(cacheRoot, "github-issue", owner ?? "", name ?? "", String(number));
  mkdirSync(entry, { recursive: true });
  const payload: Record<string, unknown> = {
    number,
    state: "open",
    labels: labels.map((label) => ({ name: label })),
    repository_url: `https://api.github.com/repos/${repo}`,
  };
  if (milestone) payload.milestone = { title: milestone };
  writeFileSync(join(entry, "raw.json"), JSON.stringify(payload), "utf8");
}

describe("scope-drift compute", () => {
  it("returns empty report for empty cache", () => {
    const root = mkdtempSync(join(tmpdir(), "drift-"));
    writePd(root);
    const report = computeDrift(root, { cacheRoot: join(root, ".deft-cache") });
    expect(report.total).toBe(0);
    rmSync(root, { recursive: true, force: true });
  });

  it("surfaces label drift at threshold", () => {
    const root = mkdtempSync(join(tmpdir(), "drift-"));
    writePd(root, { triageScope: [{ rule: "labels", "any-of": ["other"] }] });
    const cache = join(root, ".deft-cache");
    for (const n of [101, 102, 103])
      writeCachedIssue(cache, "deftai/directive", n, ["priority:p0"]);
    const report = computeDrift(root, { cacheRoot: cache });
    expect(report.labels).toEqual({ "priority:p0": 3 });
    expect(report.total).toBe(3);
    rmSync(root, { recursive: true, force: true });
  });

  it("renders empty notice", () => {
    const text = renderDriftReport({ labels: {}, milestones: {}, total: 0, threshold: 3 });
    expect(text).toContain("[scope-drift] no unsubscribed labels");
  });
});
