import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it, vi } from "vitest";
import { run } from "./slice.js";

const temps: string[] = [];
afterAll(() => {
  for (const t of temps) rmSync(t, { recursive: true, force: true });
});

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "deft-cli-slice-"));
  temps.push(root);
  mkdirSync(join(root, "vbrief", ".eval"), { recursive: true });
  mkdirSync(join(root, ".git"));
  return root;
}

describe("slice thin CLI", () => {
  it("exports run function", () => {
    expect(typeof run).toBe("function");
  });

  it("run delegates to core cli when built", () => {
    const coreCli = join(dirname(fileURLToPath(import.meta.url)), "../../core/dist/slice/cli.js");
    const root = makeRoot();
    const out = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    const err = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    try {
      const code = run(["list", `--project-root=${root}`]);
      expect(code).toBe(0);
      expect(out.mock.calls.length + err.mock.calls.length).toBeGreaterThan(0);
    } finally {
      out.mockRestore();
      err.mockRestore();
    }
    expect(spawnSync(process.execPath, [coreCli, "--help"]).status).toBeDefined();
  });
});
