import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { backfill } from "./backfill.js";

describe("capacity backfill", () => {
  it("fails closed when capacityAllocation is not configured", async () => {
    const root = mkdtempSync(join(tmpdir(), "deft-cap-backfill-"));
    mkdirSync(join(root, "vbrief", "completed"), { recursive: true });
    const result = await backfill(root);
    expect(result.exit_code).toBe(2);
    expect(result.error).toContain("not configured");
  });
});
