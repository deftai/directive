import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { computeDrift } from "./compute.js";

function writePd(root: string, policy: Record<string, unknown>): void {
  mkdirSync(join(root, "vbrief"), { recursive: true });
  writeFileSync(
    join(root, "vbrief", "PROJECT-DEFINITION.vbrief.json"),
    JSON.stringify({ plan: { policy } }),
    "utf8",
  );
}

describe("compute drift branches", () => {
  it("ignores closed issues and subscribed labels", () => {
    const root = mkdtempSync(join(tmpdir(), "compute-"));
    writePd(root, {
      triageScope: [{ rule: "labels", "any-of": ["known"] }],
      triageScopeIgnores: [{ label: "noise" }, { rule: "author", "any-of": ["bot"] }],
    });
    const cache = join(root, ".deft-cache");
    for (const n of [1, 2, 3]) {
      const entry = join(cache, "github-issue", "deftai", "directive", String(n));
      mkdirSync(entry, { recursive: true });
      writeFileSync(
        join(entry, "raw.json"),
        JSON.stringify({
          number: n,
          state: n === 1 ? "closed" : "open",
          labels: [{ name: n === 2 ? "known" : "noise" }],
          user: { login: "bot" },
        }),
        "utf8",
      );
    }
    expect(computeDrift(root, { cacheRoot: cache }).total).toBe(0);
    rmSync(root, { recursive: true, force: true });
  });
});
