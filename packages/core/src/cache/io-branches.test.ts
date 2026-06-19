import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { atomicWriteText, fileSize, mkTempName, removeEntryDir, touchMtime } from "./io.js";

describe("io branches", () => {
  it("cleans up temp file when rename target is a directory", () => {
    const dir = mkdtempSync(join(tmpdir(), "deft-io-rename-"));
    const target = join(dir, "out.txt");
    mkdirSync(target, { recursive: true });
    try {
      expect(() => atomicWriteText(target, "data")).toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("swallows touchMtime failures on missing paths", () => {
    expect(() => touchMtime(join(tmpdir(), "deft-missing-touch-xyz"))).not.toThrow();
  });

  it("reports file size and temp names", () => {
    const dir = mkdtempSync(join(tmpdir(), "deft-io-size-"));
    const path = join(dir, "x.txt");
    writeFileSync(path, "abc", "utf8");
    try {
      expect(fileSize(path)).toBe(3);
      expect(mkTempName(dir, "pfx")).toContain("pfx.");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("removeEntryDir is idempotent on missing paths", () => {
    expect(() => removeEntryDir(join(tmpdir(), "deft-missing-entry-xyz"))).not.toThrow();
  });
});
