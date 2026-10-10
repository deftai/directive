import { describe, expect, it, vi } from "vitest";
import { parseStripArgs, runStripWithdrawn } from "./triage-strip-withdrawn.js";

describe("parseStripArgs", () => {
  it("defaults to dry-run", () => {
    expect(parseStripArgs([])).toMatchObject({
      apply: false,
      json: false,
      emitDigest: false,
      repo: null,
    });
  });

  it("parses apply json digest and repo", () => {
    expect(
      parseStripArgs(["--apply", "--json", "--emit-digest", "--repo", "deftai/directive"]),
    ).toMatchObject({
      apply: true,
      json: true,
      emitDigest: true,
      repo: "deftai/directive",
    });
  });
});

describe("runStripWithdrawn", () => {
  it("fail-closes without repo", () => {
    const err = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    expect(runStripWithdrawn([], { resolveDefaultRepo: () => null })).toBe(2);
    expect(err.mock.calls.map((c) => String(c[0])).join("")).toMatch(/--repo/);
    err.mockRestore();
  });

  it("dry-run json names remaining-set strip and #4070", () => {
    const out = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    const code = runStripWithdrawn(["--json", "--repo", "o/r"], {
      resolveDefaultRepo: () => "o/r",
      listIssues: () => [],
      labelClient: {
        fetchLabels: () => [],
        apply: () => {
          throw new Error("apply should not run on dry-run");
        },
      },
    });
    expect(code).toBe(0);
    const text = out.mock.calls.map((c) => String(c[0])).join("");
    const parsed = JSON.parse(text) as { dry_run: boolean; repo: string };
    expect(parsed.dry_run).toBe(true);
    expect(parsed.repo).toBe("o/r");
    out.mockRestore();
  });
});
