import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { main, parseCli, runCli } from "./cli.js";

const temps: string[] = [];
afterAll(() => {
  for (const t of temps) rmSync(t, { recursive: true, force: true });
});

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "deft-slice-cli-"));
  temps.push(root);
  mkdirSync(join(root, "vbrief", ".eval"), { recursive: true });
  mkdirSync(join(root, ".git"));
  return root;
}

describe("parseCli", () => {
  it("defaults to record-existing subcommand", () => {
    const parsed = parseCli(["--umbrella=1", "--children=2", "--repo=o/r", "--skip-validation"]);
    expect(parsed.command).toBe("record-existing");
    expect(parsed.recordArgs?.umbrella).toBe(1);
  });

  it("parses list --json", () => {
    const parsed = parseCli(["list", "--json"]);
    expect(parsed.command).toBe("list");
    expect(parsed.listAsJson).toBe(true);
  });

  it("surfaces wave flag parse errors", () => {
    const parsed = parseCli(["record-existing", "--wave-2"]);
    expect(parsed.error).toContain("missing value");
  });
});

describe("runCli", () => {
  it("lists empty project", () => {
    const root = makeRoot();
    const result = runCli(["list", `--project-root=${root}`]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("no records found");
  });

  it("returns usage-like errors for missing required flags", () => {
    const result = runCli(["record-existing", "--repo=o/r"]);
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("--umbrella");
  });

  it("main writes streams and returns exit code", () => {
    const root = makeRoot();
    const out = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    const err = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    try {
      expect(main(["list", `--project-root=${root}`])).toBe(0);
      expect(out.mock.calls.length).toBeGreaterThan(0);
      expect(main(["--help"])).toBe(0);
      expect(err.mock.calls.length).toBe(0);
    } finally {
      out.mockRestore();
      err.mockRestore();
    }
  });
});
