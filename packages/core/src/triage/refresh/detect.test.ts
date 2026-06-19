import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { detectDrift } from "./drift.js";

describe("detectDrift integration", () => {
  it("finds drift when live is newer", () => {
    const root = mkdtempSync(join(tmpdir(), "detect-"));
    const active = join(root, "vbrief", "active");
    mkdirSync(active, { recursive: true });
    writeFileSync(
      join(active, "story.vbrief.json"),
      JSON.stringify({
        plan: {
          references: [
            { type: "x-vbrief/github-issue", uri: "https://github.com/deftai/directive/issues/42" },
          ],
        },
      }),
      "utf8",
    );
    const drifts = detectDrift(active, root, {
      fetchLive: () => "2026-06-01T00:00:00Z",
      cacheLoader: () => "2026-05-01T00:00:00Z",
    });
    expect(drifts).toHaveLength(1);
    rmSync(root, { recursive: true, force: true });
  });
});
