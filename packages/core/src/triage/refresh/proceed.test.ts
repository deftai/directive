import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { refreshActive } from "./refresh.js";

describe("refresh proceed-with-stale", () => {
  it("records proceed choice", () => {
    const root = mkdtempSync(join(tmpdir(), "refresh-proceed-"));
    const active = join(root, "vbrief", "active");
    mkdirSync(active, { recursive: true });
    writeFileSync(
      join(active, "s.vbrief.json"),
      JSON.stringify({
        plan: {
          references: [
            { type: "x-vbrief/github-issue", uri: "https://github.com/deftai/directive/issues/8" },
          ],
        },
      }),
      "utf8",
    );
    const summary = refreshActive(root, {
      inputFn: () => "1",
      fetchLive: () => "2026-06-02T00:00:00Z",
      cacheLoader: () => "2026-06-01T00:00:00Z",
      auditWriter: () => {},
      log: () => {},
    });
    expect(summary.proceeded).toEqual([["deftai/directive", 8]]);
    rmSync(root, { recursive: true, force: true });
  });
});
