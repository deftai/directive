import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:child_process", () => ({
  spawnSync: vi.fn(),
}));

import { spawnSync } from "node:child_process";
import { setValidateAllForTests, validateMigrationOutput } from "./validation.js";

describe("validation bridge", () => {
  beforeEach(() => {
    setValidateAllForTests(null);
    vi.mocked(spawnSync).mockReset();
  });

  it("surfaces stderr from the validate_all bridge", () => {
    const root = mkdtempSync(join(tmpdir(), "vb-bridge-err-"));
    mkdirSync(join(root, "vbrief"), { recursive: true });
    vi.mocked(spawnSync).mockReturnValueOnce({
      status: 1,
      stderr: "python exploded",
      stdout: "",
      pid: 0,
      output: [null, "", "python exploded"],
      signal: null,
      error: undefined,
    } as ReturnType<typeof spawnSync>);
    expect(() => validateMigrationOutput(join(root, "vbrief"))).toThrow("python exploded");
    rmSync(root, { recursive: true, force: true });
  });

  it("parses validate_all payloads with missing tuple slots", () => {
    const root = mkdtempSync(join(tmpdir(), "vb-bridge-null-"));
    mkdirSync(join(root, "vbrief"), { recursive: true });
    vi.mocked(spawnSync).mockReturnValueOnce({
      status: 0,
      stderr: "",
      stdout: "[null,null]",
      pid: 0,
      output: [null, "[null,null]", ""],
      signal: null,
      error: undefined,
    } as ReturnType<typeof spawnSync>);
    const [errors, warnings] = validateMigrationOutput(join(root, "vbrief"));
    expect(errors).toEqual([]);
    expect(warnings).toEqual([]);
    rmSync(root, { recursive: true, force: true });
  });
});
