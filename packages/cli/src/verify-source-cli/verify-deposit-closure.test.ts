import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";

const DEPOSIT_REQUIRED_SCHEMA = "deft.deposit-required-paths.v1";

import { parseArgs, run } from "./verify-deposit-closure.js";

const temps: string[] = [];
afterAll(() => {
  for (const t of temps) {
    rmSync(t, { recursive: true, force: true });
  }
});

function silentRun(argv: string[]): number {
  const out = vi.spyOn(process.stdout, "write").mockReturnValue(true);
  const err = vi.spyOn(process.stderr, "write").mockReturnValue(true);
  try {
    return run(argv);
  } finally {
    out.mockRestore();
    err.mockRestore();
  }
}

describe("parseArgs", () => {
  it("defaults to the current directory as a source checkout", () => {
    expect(parseArgs([])).toMatchObject({ projectRoot: ".", packRootExplicit: false });
  });
  it("parses --project-root and --pack-root", () => {
    expect(parseArgs(["--project-root", "/r"]).projectRoot).toBe("/r");
    expect(parseArgs(["--pack-root=/p"]).packRootExplicit).toBe(true);
  });
  it("errors on missing values and unknown flags", () => {
    expect(parseArgs(["--pack-root"]).error).toBeDefined();
    expect(parseArgs(["--bogus"]).error).toBeDefined();
  });
});

describe("run", () => {
  it("returns 2 on parse error", () => {
    expect(silentRun(["--bogus"])).toBe(2);
  });

  it("returns 0 for a staged pack with every declared path", () => {
    const pack = mkdtempSync(join(tmpdir(), "deft-3900-cli-"));
    temps.push(pack);
    mkdirSync(join(pack, "contracts"), { recursive: true });
    writeFileSync(join(pack, "main.md"), "# main\n", "utf8");
    writeFileSync(
      join(pack, "contracts", "deposit-required-paths.json"),
      JSON.stringify({ schema: DEPOSIT_REQUIRED_SCHEMA, paths: [".deft/core/main.md"] }),
      "utf8",
    );
    expect(silentRun(["--pack-root", pack])).toBe(0);
  });

  it("returns 1 when a declared path is missing from the staged pack", () => {
    const pack = mkdtempSync(join(tmpdir(), "deft-3900-cli-miss-"));
    temps.push(pack);
    mkdirSync(join(pack, "contracts"), { recursive: true });
    writeFileSync(
      join(pack, "contracts", "deposit-required-paths.json"),
      JSON.stringify({ schema: DEPOSIT_REQUIRED_SCHEMA, paths: [".deft/core/main.md"] }),
      "utf8",
    );
    expect(silentRun(["--pack-root", pack])).toBe(1);
  });
});
