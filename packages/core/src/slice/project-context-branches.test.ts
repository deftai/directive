import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { resolveProjectRoot } from "./project-context.js";

const temps: string[] = [];
afterAll(() => {
  for (const t of temps) rmSync(t, { recursive: true, force: true });
});

describe("resolveProjectRoot walk", () => {
  it("walks upward from a subdirectory to find vbrief/", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-slice-walk-"));
    temps.push(root);
    mkdirSync(join(root, "vbrief"));
    const sub = join(root, "nested", "deep");
    mkdirSync(sub, { recursive: true });
    const prev = process.env.DEFT_PROJECT_ROOT;
    delete process.env.DEFT_PROJECT_ROOT;
    expect(resolveProjectRoot(undefined, sub)).toBe(root);
    process.env.DEFT_PROJECT_ROOT = prev;
  });

  it("rejects invalid explicit project roots and env roots", () => {
    expect(resolveProjectRoot("/path/does/not/exist-xyz")).toBeNull();
    const prev = process.env.DEFT_PROJECT_ROOT;
    process.env.DEFT_PROJECT_ROOT = "/missing/deft/env/root";
    expect(resolveProjectRoot(undefined)).toBeNull();
    process.env.DEFT_PROJECT_ROOT = prev;
  });
});
