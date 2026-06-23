import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const VERSION_LINE = "@deftai/directive (engine: @deftai/directive-core@0.0.0)\n";

describe("dist/bin.js entrypoint", () => {
  const binPath = join(dirname(fileURLToPath(import.meta.url)), "../dist/bin.js");

  it("prints the engine banner for --version", () => {
    const out = execFileSync("node", [binPath, "--version"], { encoding: "utf8" });
    expect(out).toBe(VERSION_LINE);
  });

  it("prints the same banner for -V", () => {
    const out = execFileSync("node", [binPath, "-V"], { encoding: "utf8" });
    expect(out).toBe(VERSION_LINE);
  });
});
