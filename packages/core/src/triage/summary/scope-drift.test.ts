import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { computeScopeDriftTotal } from "./scope-drift.js";

const temps: string[] = [];
afterAll(() => {
  for (const t of temps) rmSync(t, { recursive: true, force: true });
});

function mkRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "deft-drift-test-"));
  temps.push(root);
  return root;
}

function writeProjectDefinition(root: string, triageScope: Record<string, unknown>[]): void {
  const dir = join(root, "vbrief");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "PROJECT-DEFINITION.vbrief.json"),
    JSON.stringify({
      plan: { policy: { triageScope } },
    }),
    "utf8",
  );
}

function writeCachedIssue(
  cacheRoot: string,
  repo: string,
  number: number,
  raw: Record<string, unknown>,
): void {
  const [owner, name] = repo.split("/", 2);
  const entry = join(cacheRoot, "github-issue", owner ?? "", name ?? "", String(number));
  mkdirSync(entry, { recursive: true });
  writeFileSync(join(entry, "raw.json"), `${JSON.stringify(raw)}\n`, "utf8");
}

describe("computeScopeDriftTotal", () => {
  it("returns 0 for missing cache", () => {
    const root = mkRoot();
    expect(computeScopeDriftTotal(root, join(root, ".deft-cache"))).toBe(0);
  });

  it("returns 0 when all-open rule applies (default)", () => {
    const root = mkRoot();
    const cacheRoot = join(root, ".deft-cache");
    writeCachedIssue(cacheRoot, "deftai/directive", 1, {
      state: "open",
      number: 1,
      labels: [{ name: "bug" }, { name: "bug" }, { name: "bug" }],
    });
    expect(computeScopeDriftTotal(root, cacheRoot)).toBe(0);
  });

  it("surfaces drift for unsubscribed labels under explicit scope", () => {
    const root = mkRoot();
    writeProjectDefinition(root, [{ rule: "labels", "any-of": ["phase-1"] }]);
    const cacheRoot = join(root, ".deft-cache");
    for (let i = 1; i <= 3; i += 1) {
      writeCachedIssue(cacheRoot, "deftai/directive", i, {
        state: "open",
        number: i,
        labels: [{ name: "unsubscribed-label" }],
      });
    }
    expect(computeScopeDriftTotal(root, cacheRoot)).toBe(3);
  });

  it("ignores closed issues", () => {
    const root = mkRoot();
    writeProjectDefinition(root, [{ rule: "labels", "any-of": ["phase-1"] }]);
    const cacheRoot = join(root, ".deft-cache");
    writeCachedIssue(cacheRoot, "deftai/directive", 1, {
      state: "closed",
      number: 1,
      labels: [{ name: "unsubscribed-label" }],
    });
    expect(computeScopeDriftTotal(root, cacheRoot)).toBe(0);
  });

  it("ignores milestone drift when subscribed", () => {
    const root = mkRoot();
    writeProjectDefinition(root, [{ rule: "milestone", name: "v1.0" }]);
    const cacheRoot = join(root, ".deft-cache");
    for (let i = 1; i <= 3; i += 1) {
      writeCachedIssue(cacheRoot, "deftai/directive", i, {
        state: "open",
        number: i,
        milestone: { title: "v1.0" },
      });
    }
    expect(computeScopeDriftTotal(root, cacheRoot)).toBe(0);
  });
});
