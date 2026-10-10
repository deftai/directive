import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runSpecReconstructCliEntry } from "./spec-reconstruct-cli.js";

describe("spec-reconstruct CLI (#1589)", () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("exits 2 when --project-root is missing its argument", () => {
    const err = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    try {
      expect(runSpecReconstructCliEntry(["--project-root"])).toBe(2);
    } finally {
      err.mockRestore();
    }
  });

  it("writes a draft-only candidate under xbrief/.audit", () => {
    const root = mkdtempSync(join(tmpdir(), "spec-recon-cli-"));
    dirs.push(root);
    mkdirSync(join(root, "xbrief", "completed"), { recursive: true });
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
      expect(runSpecReconstructCliEntry(["--project-root", root])).toBe(0);
      const printed = out.mock.calls.map((c) => String(c[0])).join("");
      expect(printed).toContain("draftOnly=true");
      expect(printed.replace(/\\/g, "/")).toContain("xbrief/.audit/spec-reconstruct-draft.json");
    } finally {
      out.mockRestore();
      err.mockRestore();
    }
  });
});
