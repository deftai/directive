import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { main } from "./verify-plan-sequence.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("verify-plan-sequence CLI (#2402)", () => {
  it("requires target-kind and target", () => {
    expect(main([])).toBe(2);
  });

  it("skips cleanly with no active sequence", () => {
    const root = mkdtempSync(join(tmpdir(), "vps-"));
    roots.push(root);
    expect(main(["--project-root", root, "--target-kind", "issue", "--target", "1"])).toBe(0);
  });
});
