import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { refreshActive } from "./refresh.js";

describe("refreshActive choices", () => {
  it("handles drift prompt branches", () => {
    const root = mkdtempSync(join(tmpdir(), "refresh2-"));
    const active = join(root, "vbrief", "active");
    mkdirSync(active, { recursive: true });
    writeFileSync(
      join(active, "s.vbrief.json"),
      JSON.stringify({
        plan: {
          references: [
            { type: "x-vbrief/github-issue", uri: "https://github.com/deftai/directive/issues/7" },
          ],
        },
      }),
      "utf8",
    );
    let step = 0;
    const summary = refreshActive(root, {
      inputFn: () => {
        step += 1;
        return step === 1 ? "2" : "3";
      },
      fetchLive: () => "2026-06-02T00:00:00Z",
      cacheLoader: () => "2026-06-01T00:00:00Z",
      log: () => {},
    });
    expect(summary.driftsDetected).toBe(1);
    expect(summary.refreshed).toHaveLength(1);
    rmSync(root, { recursive: true, force: true });
  });
});
