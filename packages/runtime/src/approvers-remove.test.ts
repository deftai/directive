import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { run } from "./approvers-remove.js";

const temps: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("approvers:remove (#6945)", () => {
  it("writes nothing when there is no trust file", () => {
    const dir = mkdtempSync(join(tmpdir(), "approvers-remove-"));
    temps.push(dir);
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    expect(
      run(["--credential", "Y3JlZA", "--project-root", dir], { repo: "deftai/directive" }),
    ).toBe(2);
    expect(existsSync(join(dir, ".deft", "approvers.json"))).toBe(false);
  });
});
