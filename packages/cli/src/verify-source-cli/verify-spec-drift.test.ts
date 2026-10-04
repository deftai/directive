import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { run } from "./verify-spec-drift.js";

describe("verify-spec-drift CLI (#1589)", () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("exits 2 when --project-root is missing its argument", () => {
    const err = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    try {
      expect(run(["--project-root"])).toBe(2);
    } finally {
      err.mockRestore();
    }
  });

  it("returns a three-state audit code on a minimal project root", () => {
    const root = mkdtempSync(join(tmpdir(), "spec-drift-cli-"));
    dirs.push(root);
    mkdirSync(join(root, "xbrief"), { recursive: true });
    writeFileSync(
      join(root, "xbrief", "PROJECT-DEFINITION.xbrief.json"),
      JSON.stringify({
        xBRIEFInfo: { version: "0.8", id: "proj", updated: "2026-10-04T00:00:00Z" },
        plan: { id: "proj", status: "active", items: [] },
      }),
      "utf8",
    );
    const out = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    const err = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    try {
      const code = run(["--project-root", root]);
      expect([0, 1, 2]).toContain(code);
      const printed = `${out.mock.calls.map((c) => String(c[0])).join("")}${err.mock.calls
        .map((c) => String(c[0]))
        .join("")}`;
      expect(printed).toMatch(/verify:spec-drift/);
    } finally {
      out.mockRestore();
      err.mockRestore();
    }
  });
});
