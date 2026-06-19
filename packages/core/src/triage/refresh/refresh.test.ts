import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { refreshActive } from "./refresh.js";

describe("refreshActive", () => {
  it("no-ops on empty active dir", () => {
    const root = mkdtempSync(join(tmpdir(), "refresh-"));
    mkdirSync(join(root, "vbrief", "active"), { recursive: true });
    const lines: string[] = [];
    const summary = refreshActive(root, { log: (l) => lines.push(l) });
    expect(summary.totalActive).toBe(0);
    expect(lines[0]).toContain("empty -- no-op");
    rmSync(root, { recursive: true, force: true });
  });
});
