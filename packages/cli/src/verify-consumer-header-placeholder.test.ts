import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recordProductMutationCompletion } from "@deftai/directive-core/check";
import { CONSUMER_HEADER_PLACEHOLDER_ONELINER } from "@deftai/directive-core/platform";
import { afterEach, describe, expect, it } from "vitest";
import { parseArgs, run } from "./verify-consumer-header-placeholder.js";

const tempDirs: string[] = [];
afterEach(() => {
  for (const d of tempDirs.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
});

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "cli-header-ph-"));
  tempDirs.push(root);
  return root;
}

describe("verify-consumer-header-placeholder CLI (#4544)", () => {
  it("parseArgs accepts --project-root and --quiet", () => {
    expect(parseArgs(["--project-root", "/tmp/x", "--quiet"])).toEqual({
      projectRoot: "/tmp/x",
      quiet: true,
    });
    expect(parseArgs(["--bogus"])).toMatchObject({
      error: expect.stringContaining("unrecognized"),
    });
  });

  it("exits 1 on placeholder + product mutation; 0 on Process-only and custom", () => {
    const failRoot = tempRoot();
    writeFileSync(
      join(failRoot, "AGENTS.md"),
      `# Project\n\n${CONSUMER_HEADER_PLACEHOLDER_ONELINER}\n`,
      "utf8",
    );
    recordProductMutationCompletion(failRoot, new Date("2026-09-30T12:00:00Z"));
    expect(run(["--project-root", failRoot, "--quiet"])).toBe(1);

    const processOnly = tempRoot();
    writeFileSync(
      join(processOnly, "AGENTS.md"),
      `# Project\n\n${CONSUMER_HEADER_PLACEHOLDER_ONELINER}\n`,
      "utf8",
    );
    expect(run(["--project-root", processOnly, "--quiet"])).toBe(0);

    const custom = tempRoot();
    writeFileSync(join(custom, "AGENTS.md"), "# Garden\n\nCustom one-liner.\n", "utf8");
    recordProductMutationCompletion(custom, new Date("2026-09-30T12:00:00Z"));
    expect(run(["--project-root", custom, "--quiet"])).toBe(0);
  });

  it("rejects option-like --project-root values", () => {
    expect(parseArgs(["--project-root", "--quiet"]).error).toMatch(/expected one argument/);
    expect(parseArgs(["--project-root="]).error).toMatch(/expected one argument/);
    expect(parseArgs(["--project-root=--quiet"]).error).toMatch(/expected one argument/);
  });
});
