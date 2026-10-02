import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseIncludeScopesFlag, main as specRenderMain } from "./spec-render.js";

const MINIMAL_SPEC_V08 = {
  xBRIEFInfo: { version: "0.8" },
  plan: {
    title: "Test Spec v08",
    status: "approved",
    narratives: { Overview: "Overview body" },
    items: [],
  },
};

function withCwd<T>(dir: string, fn: () => T): T {
  const prev = process.cwd();
  process.chdir(dir);
  try {
    return fn();
  } finally {
    process.chdir(prev);
  }
}

describe("spec-render bare -- (#548 / #5251 shape)", () => {
  const tmpDirs: string[] = [];

  afterEach(() => {
    for (const dir of tmpDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("parseIncludeScopesFlag continues on bare -- without latching", () => {
    const parsed = parseIncludeScopesFlag(["--", "spec.json", "out.md"]);
    expect(parsed.errors).toEqual([]);
    expect(parsed.remaining).toEqual(["spec.json", "out.md"]);
  });

  it("parseIncludeScopesFlag still honors flags after bare -- (no latch)", () => {
    const parsed = parseIncludeScopesFlag([
      "spec.json",
      "--",
      "--include-scopes=current",
      "out.md",
    ]);
    expect(parsed.errors).toEqual([]);
    expect(parsed.includeScopes).toBe("current");
    expect(parsed.remaining).toEqual(["spec.json", "out.md"]);
  });

  it('main(["--", specPath, outPath]) exits 0 and writes SPECIFICATION.md', () => {
    const root = mkdtempSync(join(tmpdir(), "deft-spec-548-sep-"));
    tmpDirs.push(root);
    const xbrief = join(root, "xbrief");
    mkdirSync(xbrief, { recursive: true });
    const specPath = join(xbrief, "specification.xbrief.json");
    const outPath = join(root, "SPECIFICATION.md");
    writeFileSync(specPath, JSON.stringify(MINIMAL_SPEC_V08), "utf8");

    const exit = withCwd(root, () => specRenderMain(["--", specPath, outPath]));
    expect(exit).toBe(0);
    expect(existsSync(outPath)).toBe(true);
    const content = readFileSync(outPath, "utf8");
    expect(content).toContain("Test Spec v08");
    expect(content).toContain("AUTO-GENERATED");
    expect(existsSync(join(root, "--"))).toBe(false);
  });
});
