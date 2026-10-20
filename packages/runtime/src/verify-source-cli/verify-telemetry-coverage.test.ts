import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseArgs, run } from "./verify-telemetry-coverage.js";

const temps: string[] = [];
afterEach(() => {
  for (const t of temps.splice(0)) rmSync(t, { recursive: true, force: true });
});

describe("verify-telemetry-coverage CLI (#3362)", () => {
  it("parses --project-root and --enforce", () => {
    const p = parseArgs(["--project-root", "/tmp/x", "--enforce"]);
    expect(p.projectRoot).toBe("/tmp/x");
    expect(p.enforce).toBe(true);
    expect(p.error).toBeUndefined();
  });

  it("rejects unknown flags", () => {
    const p = parseArgs(["--nope"]);
    expect(p.error).toMatch(/unrecognized/);
  });

  it("run returns 0 warn-only on a tree with a dead kind", () => {
    const root = mkdtempSync(join(tmpdir(), "tlm-cli-"));
    temps.push(root);
    const src = join(root, "packages", "core", "src", "x");
    mkdirSync(src, { recursive: true });
    writeFileSync(join(src, "s.ts"), "export const n = 1;\n", "utf8");
    expect(run(["--project-root", root])).toBe(0);
  });

  it("help exits 0 without scanning", () => {
    expect(run(["--help"])).toBe(0);
    expect(parseArgs(["--help"]).help).toBe(true);
  });
});
