import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readCommitsFile, readTextFile } from "./io.js";

describe("io helpers", () => {
  it("readTextFile returns null on missing file", () => {
    expect(readTextFile("/tmp/deft-closing-keywords-does-not-exist")).toBeNull();
  });

  it("readCommitsFile splits on --END--", () => {
    const dir = mkdtempSync(join(tmpdir(), "deft-closing-keywords-io-"));
    try {
      const path = join(dir, "commits.txt");
      writeFileSync(path, "first\n--END--\n\nsecond\n", "utf8");
      expect(readCommitsFile(path)).toEqual(["first", "second"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
