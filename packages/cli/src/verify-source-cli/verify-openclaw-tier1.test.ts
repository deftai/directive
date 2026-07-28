import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { OPENCLAW_TIER1_TARGETS } from "@deftai/directive-core/verify-source";
import { afterEach, describe, expect, it } from "vitest";
import { parseArgs, run } from "./verify-openclaw-tier1.js";

function writeTarget(root: string, relPath: string, body: string): void {
  const full = join(root, relPath);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, body, "utf8");
}

function bodyWithAllMarkers(markers: readonly string[]): string {
  return `# Surface\n\n${markers.map((m) => `Line referencing ${m} here.`).join("\n")}\n`;
}

describe("verify-openclaw-tier1 CLI (#2875)", () => {
  let root: string | undefined;

  afterEach(() => {
    if (root !== undefined) {
      rmSync(root, { recursive: true, force: true });
      root = undefined;
    }
  });

  it("parseArgs accepts --project-root and --quiet", () => {
    expect(parseArgs(["--project-root", "/tmp/x", "--quiet"])).toEqual({
      projectRoot: "/tmp/x",
      quiet: true,
    });
    expect(parseArgs(["--project-root=/tmp/y"]).projectRoot).toBe("/tmp/y");
  });

  it("parseArgs rejects missing --project-root value and unknown flags", () => {
    expect(parseArgs(["--project-root"]).error).toMatch(/expected one argument/);
    expect(parseArgs(["--nope"]).error).toMatch(/unrecognized/);
  });

  it("run exits 0 on a seeded clean tree and 2 on bad args", () => {
    root = mkdtempSync(join(tmpdir(), "openclaw-cli-"));
    for (const target of OPENCLAW_TIER1_TARGETS) {
      writeTarget(root, target.path, bodyWithAllMarkers(target.markers));
    }
    expect(run(["--project-root", root, "--quiet"])).toBe(0);
    expect(run(["--project-root", root])).toBe(0);
    expect(run(["--bogus"])).toBe(2);
  });

  it("run exits 1 when markers are missing and writes stderr", () => {
    root = mkdtempSync(join(tmpdir(), "openclaw-cli-miss-"));
    for (const target of OPENCLAW_TIER1_TARGETS) {
      writeTarget(root, target.path, "# empty surface\n");
    }
    expect(run(["--project-root", root])).toBe(1);
  });
});
