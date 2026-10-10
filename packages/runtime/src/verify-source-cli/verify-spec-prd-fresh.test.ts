import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { run } from "./verify-spec-prd-fresh.js";

const REPO_ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..", "..", "..", "..");

describe("verify-spec-prd-fresh CLI", () => {
  it("exits 2 when --project-root is missing its argument", () => {
    const err = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    try {
      expect(run(["--project-root"])).toBe(2);
    } finally {
      err.mockRestore();
    }
  });

  it("returns 0 on the live framework source after banner repair", () => {
    const out = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    const err = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    try {
      expect(run(["--project-root", REPO_ROOT])).toBe(0);
    } finally {
      out.mockRestore();
      err.mockRestore();
    }
  });
});
