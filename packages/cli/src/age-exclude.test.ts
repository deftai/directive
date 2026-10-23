/** #5854 Prefer-A Recut-1: runtime minimumReleaseAgeExclude replace-not-append. */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  addWithRuntimeAgeExcludeHeal,
  formatAgeExcludeHealLine,
  healRuntimeAgeExclude,
  previewRuntimeAgeExcludeHeal,
  upsertRuntimeAgeExcludeText,
} from "./age-exclude.js";

const TEMPS: string[] = [];
function tempRoot(yaml?: string): string {
  const root = mkdtempSync(join(tmpdir(), "age-exclude-"));
  TEMPS.push(root);
  if (yaml !== undefined) writeFileSync(join(root, "pnpm-workspace.yaml"), yaml, "utf8");
  return root;
}
const readYaml = (root: string) => readFileSync(join(root, "pnpm-workspace.yaml"), "utf8");
afterEach(() => {
  while (TEMPS.length > 0) {
    const p = TEMPS.pop();
    if (p) rmSync(p, { recursive: true, force: true });
  }
});

const RUNTIME_ROWS = (y: string) =>
  y.split(/\r?\n/).filter((l) => l.includes("@deftai/directive-runtime@"));

const BASE = (rows: string) => `packages:
  - packages/*
# supply-chain: keep a 24h age gate except for our own fresh pins
minimumReleaseAge: 1440
minimumReleaseAgeExclude:
  - '@deftai/some-other@1.0.0'
${rows}  - left-pad
allowBuilds:
  esbuild: true
  '@deftai/directive-runtime@0.127.0': true
`;

describe("upsertRuntimeAgeExcludeText (#5854 P1)", () => {
  it("old-only -> exactly one quoted target at the same position", () => {
    const r = upsertRuntimeAgeExcludeText(
      BASE("  - '@deftai/directive-runtime@0.127.0'\n"),
      "0.128.0",
    );
    expect(r.changed).toBe(true);
    expect(r.text).toBe(BASE("  - '@deftai/directive-runtime@0.128.0'\n"));
  });

  it("old+target (the pnpm-appended repro) -> exactly one target", () => {
    const r = upsertRuntimeAgeExcludeText(
      BASE("  - '@deftai/directive-runtime@0.127.0'\n  - '@deftai/directive-runtime@0.128.0'\n"),
      "0.128.0",
    );
    const block = r.text.slice(
      r.text.indexOf("minimumReleaseAgeExclude:"),
      r.text.indexOf("allowBuilds:"),
    );
    expect(RUNTIME_ROWS(block)).toEqual(["  - '@deftai/directive-runtime@0.128.0'"]);
    expect(r.priorRuntimeItems).toEqual([
      "@deftai/directive-runtime@0.127.0",
      "@deftai/directive-runtime@0.128.0",
    ]);
  });

  it("never touches allowBuilds, comments, or unrelated exclude rows", () => {
    const r = upsertRuntimeAgeExcludeText(
      BASE('  - "@deftai/directive-runtime@0.127.0"\n'),
      "0.128.0",
    );
    expect(r.text).toContain("'@deftai/directive-runtime@0.127.0': true");
    expect(r.text).toContain("# supply-chain: keep a 24h age gate");
    expect(r.text).toContain("  - '@deftai/some-other@1.0.0'");
    expect(r.text).toContain("  - left-pad");
  });

  it("gate-false: no AgeExclude key -> byte-identical", () => {
    const y =
      "packages:\n  - packages/*\nallowBuilds:\n  '@deftai/directive-runtime@0.127.0': true\n";
    const r = upsertRuntimeAgeExcludeText(y, "0.128.0");
    expect(r.changed).toBe(false);
    expect(r.text).toBe(y);
  });

  it("gate-false: key with no runtime exact (bare name or range) -> byte-identical", () => {
    const y = BASE("  - '@deftai/directive-runtime'\n  - '@deftai/directive-runtime@^0.127.0'\n");
    const r = upsertRuntimeAgeExcludeText(y, "0.128.0");
    expect(r.changed).toBe(false);
    expect(r.text).toBe(y);
  });

  it("already exactly one quoted target -> unchanged", () => {
    const y = BASE("  - '@deftai/directive-runtime@0.128.0'\n");
    expect(upsertRuntimeAgeExcludeText(y, "0.128.0").changed).toBe(false);
  });

  it("preserves CRLF line endings", () => {
    const y = BASE("  - '@deftai/directive-runtime@0.127.0'\n").replace(/\n/g, "\r\n");
    const r = upsertRuntimeAgeExcludeText(y, "0.128.0");
    expect(r.text.includes("\r\n")).toBe(true);
    expect(r.text.replace(/\r\n/g, "").includes("\n")).toBe(false);
  });
});

describe("add/repair heal seams (#5854 P2/P3)", () => {
  it("pre-add yaml already holds exactly one quoted target; pnpm-appended row collapses after", () => {
    const root = tempRoot(BASE("  - '@deftai/directive-runtime@0.127.0'\n"));
    let sawPreAdd: string[] = [];
    const result = addWithRuntimeAgeExcludeHeal(root, "pnpm", "0.128.0", () => {
      sawPreAdd = RUNTIME_ROWS(readYaml(root)).filter((l) => l.trimStart().startsWith("-"));
      // Simulate pnpm appending its own exclude row during add.
      writeFileSync(
        join(root, "pnpm-workspace.yaml"),
        readYaml(root).replace(
          "  - left-pad\n",
          "  - left-pad\n  - '@deftai/directive-runtime@0.128.0'\n",
        ),
        "utf8",
      );
      return { ok: true };
    });
    expect(result.ok).toBe(true);
    expect(sawPreAdd).toEqual(["  - '@deftai/directive-runtime@0.128.0'"]);
    const items = RUNTIME_ROWS(readYaml(root)).filter((l) => l.trimStart().startsWith("-"));
    expect(items).toEqual(["  - '@deftai/directive-runtime@0.128.0'"]);
  });

  it("leave-old would fail: a dual-entry file is not left dual after the seam", () => {
    const root = tempRoot(
      BASE("  - '@deftai/directive-runtime@0.127.0'\n  - '@deftai/directive-runtime@0.128.0'\n"),
    );
    addWithRuntimeAgeExcludeHeal(root, "pnpm", "0.128.0", () => ({ ok: true }));
    expect(readYaml(root)).not.toMatch(/- '@deftai\/directive-runtime@0\.127\.0'/);
  });

  it("gate-false workspace stays byte-identical through the seam", () => {
    const y = "packages:\n  - packages/*\n";
    const root = tempRoot(y);
    addWithRuntimeAgeExcludeHeal(root, "pnpm", "0.128.0", () => ({ ok: true }));
    expect(readYaml(root)).toBe(y);
  });

  it("npm passes through untouched", () => {
    const y = BASE("  - '@deftai/directive-runtime@0.127.0'\n");
    const root = tempRoot(y);
    addWithRuntimeAgeExcludeHeal(root, "npm", "0.128.0", () => ({ ok: true }));
    expect(readYaml(root)).toBe(y);
  });

  it("failed add skips the post-add heal but keeps the pre-add upsert", () => {
    const root = tempRoot(BASE("  - '@deftai/directive-runtime@0.127.0'\n"));
    const r = addWithRuntimeAgeExcludeHeal(root, "pnpm", "0.128.0", () => ({
      ok: false,
      message: "boom",
      stderr: "",
    }));
    expect(r.ok).toBe(false);
    expect(readYaml(root)).toContain("- '@deftai/directive-runtime@0.128.0'");
  });

  it("repair-side heal fixes a stranded stale entry without any add", () => {
    const root = tempRoot(BASE("  - '@deftai/directive-runtime@0.127.0'\n"));
    const preview = previewRuntimeAgeExcludeHeal(root, "0.128.0");
    if (preview === null) throw new Error("expected a heal preview");
    expect(formatAgeExcludeHealLine(preview, "0.128.0")).toMatch(/#5854/);
    expect(healRuntimeAgeExclude(root, "0.128.0")).toBe(true);
    expect(healRuntimeAgeExclude(root, "0.128.0")).toBe(false);
    expect(previewRuntimeAgeExcludeHeal(tempRoot(), "0.128.0")).toBeNull();
  });
});
