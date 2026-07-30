import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseArgs, run } from "./verify-contained-writes.js";

const temps: string[] = [];
afterEach(() => {
  for (const t of temps.splice(0)) rmSync(t, { recursive: true, force: true });
});

describe("verify-contained-writes CLI (#2951)", () => {
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

  it("run returns 0 fail-open on a tree with sinks", () => {
    const root = mkdtempSync(join(tmpdir(), "cw-cli-"));
    temps.push(root);
    const src = join(root, "packages", "core", "src", "x");
    mkdirSync(src, { recursive: true });
    writeFileSync(join(src, "s.ts"), "writeFileSync(a, b);\n", "utf8");
    expect(run(["--project-root", root])).toBe(0);
  });

  it("help exits 0 without scanning", () => {
    expect(run(["--help"])).toBe(0);
    expect(parseArgs(["--help"]).help).toBe(true);
  });
});
