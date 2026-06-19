import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { addIgnore } from "./add-ignore.js";
import { computeDrift } from "./compute.js";
import { renderDriftReport } from "./render.js";

function writePd(root: string, policy: Record<string, unknown>): void {
  mkdirSync(join(root, "vbrief"), { recursive: true });
  writeFileSync(
    join(root, "vbrief", "PROJECT-DEFINITION.vbrief.json"),
    JSON.stringify({ plan: { policy } }),
    "utf8",
  );
}

describe("scope-drift branches", () => {
  it("addIgnore validates args", () => {
    expect(() => addIgnore("/tmp", {})).toThrow();
    expect(() => addIgnore("/tmp", { label: "a", milestone: "b" })).toThrow();
  });

  it("render includes milestones section", () => {
    const text = renderDriftReport({
      labels: {},
      milestones: { blocker: 3 },
      total: 3,
      threshold: 3,
    });
    expect(text).toContain("milestones not in subscription");
  });

  it("honors custom threshold and author ignores", () => {
    const root = mkdtempSync(join(tmpdir(), "compute-th-"));
    writePd(root, {
      triageScope: [{ rule: "milestone", "is-open": true }],
      triageScopeIgnores: [{ rule: "author", "any-of": ["bot"] }],
    });
    const cache = join(root, ".deft-cache");
    const entry = join(cache, "github-issue", "deftai", "directive", "1");
    mkdirSync(entry, { recursive: true });
    writeFileSync(
      join(entry, "raw.json"),
      JSON.stringify({
        number: 1,
        state: "open",
        user: { login: "bot" },
        milestone: { title: "m" },
      }),
      "utf8",
    );
    const report = computeDrift(root, {
      cacheRoot: cache,
      threshold: 1,
      openMilestonesFetcher: () => ["subscribed"],
    });
    expect(report.threshold).toBe(1);
    rmSync(root, { recursive: true, force: true });
  });
});
