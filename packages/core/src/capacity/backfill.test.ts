import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { backfill } from "./backfill.js";

const itSymlink = it.skipIf(process.platform === "win32");
const roots: string[] = [];

afterEach(() => {
  while (roots.length > 0) {
    const root = roots.pop();
    if (root) rmSync(root, { recursive: true, force: true });
  }
});

function makeProject(root: string): void {
  roots.push(root);
  mkdirSync(join(root, "xbrief", "completed"), { recursive: true });
  writeFileSync(
    join(root, "xbrief", "PROJECT-DEFINITION.xbrief.json"),
    `${JSON.stringify(
      {
        xBRIEFInfo: { version: "0.8" },
        plan: {
          title: "Capacity test",
          status: "running",
          items: [],
          policy: {
            capacityAllocation: {
              unit: "vbrief-count",
              window: 30,
              enforcement: "advise",
              minSampleSize: 5,
              defaultBucket: "feature",
              buckets: [
                { id: "debt", target: 0.4 },
                { id: "feature", target: 0.6 },
              ],
            },
          },
        },
      },
      null,
      2,
    )}\n`,
    { encoding: "utf8" },
  );
}

describe("capacity backfill", () => {
  it("fails closed when capacityAllocation is not configured", async () => {
    const root = mkdtempSync(join(tmpdir(), "deft-cap-backfill-"));
    mkdirSync(join(root, "xbrief", "completed"), { recursive: true });
    const result = await backfill(root);
    expect(result.exit_code).toBe(2);
    expect(result.error).toContain("not configured");
  });

  itSymlink(
    "refuses apply when a completed xBRIEF is a symlink outside the project (#2521)",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "deft-cap-backfill-symlink-"));
      makeProject(root);
      const escapeDir = mkdtempSync(join(tmpdir(), "deft-cap-backfill-escape-"));
      roots.push(escapeDir);
      const victim = join(escapeDir, "story.xbrief.json");
      writeFileSync(
        victim,
        `${JSON.stringify({
          xBRIEFInfo: { version: "0.8" },
          plan: { title: "Story", status: "completed", items: [] },
        })}\n`,
        "utf8",
      );
      symlinkSync(victim, join(root, "xbrief", "completed", "story.xbrief.json"));

      const result = await backfill(root, { dryRun: false });
      expect(result.exit_code).toBe(1);
      expect(result.error).toMatch(/projection write refused|symlink/);
      expect(readFileSync(victim, "utf8")).toContain('"title":"Story"');
    },
  );
});
