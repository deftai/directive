/**
 * Verify failure cases for #3057 (bad schema, missing format/out, path escape, md sections).
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createXbrief } from "./create.js";
import { parseVerifyArgv, runXbriefVerifyCli, verifyXbrief } from "./verify.js";

const temps: string[] = [];
afterEach(() => {
  for (const t of temps.splice(0)) rmSync(t, { recursive: true, force: true });
});

function freshRoot(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  temps.push(dir);
  return dir;
}

describe("parseVerifyArgv (#3057)", () => {
  it("requires --format and --out", () => {
    expect(parseVerifyArgv([])).toMatchObject({
      error: expect.stringContaining("missing required --format"),
    });
    expect(parseVerifyArgv(["--format", "json"])).toMatchObject({
      error: expect.stringContaining("missing required --out"),
    });
  });

  it("rejects invalid format", () => {
    expect(parseVerifyArgv(["--format", "xml", "--out", "x"])).toMatchObject({
      error: expect.stringContaining("invalid --format"),
    });
  });
});

describe("verify failures (#3057)", () => {
  it("fails closed on path escape", () => {
    const root = freshRoot("xbrief-verify-escape-");
    const r = verifyXbrief({
      format: "json",
      out: join("..", "outside"),
      projectRoot: root,
    });
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toMatch(/escape|refused/i);
  });

  it("fails on missing artifact", () => {
    const root = freshRoot("xbrief-verify-missing-");
    const r = verifyXbrief({
      format: "json",
      out: "missing/file",
      projectRoot: root,
    });
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("missing file");
  });

  it("fails on bad schema", () => {
    const root = freshRoot("xbrief-verify-schema-");
    const dir = join(root, "bad");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "broken.xbrief.json"), JSON.stringify({ noPlan: true }), "utf8");
    const r = verifyXbrief({
      format: "json",
      out: "bad/broken",
      projectRoot: root,
    });
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toMatch(/schema|missing required|xBRIEFInfo|plan/i);
  });

  it("fails when md is missing required sections", () => {
    const root = freshRoot("xbrief-verify-md-");
    const dir = join(root, "md");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "thin.xbrief.md"),
      "---\nxbrief: 0.8\nstyle: scope\n---\n\n# Thin\n\n## Title\n\nThin\n",
      "utf8",
    );
    const r = verifyXbrief({
      format: "md",
      out: "md/thin",
      style: "scope",
      projectRoot: root,
    });
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("missing required markdown section");
  });

  it("fails on both title mismatch", () => {
    const root = freshRoot("xbrief-verify-mismatch-");
    const created = createXbrief({
      format: "both",
      out: "pair/demo",
      style: "scope",
      title: "Original",
      id: "pair-1",
      projectRoot: root,
      force: true,
    });
    expect(created.exitCode).toBe(0);

    // Corrupt md title body
    const mdPath = join(root, "pair", "demo.xbrief.md");
    const md = readAndRewriteTitle(mdPath, "Tampered");
    writeFileSync(mdPath, md, "utf8");

    const r = verifyXbrief({
      format: "both",
      out: "pair/demo",
      style: "scope",
      projectRoot: root,
    });
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("title mismatch");
  });

  it("CLI missing flags exits 2 (usage)", () => {
    const r = runXbriefVerifyCli([]);
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain("missing required --format");
  });

  it("prints verify help and catches status/id mismatch for both", () => {
    const help = runXbriefVerifyCli(["--help"]);
    expect(help.exitCode).toBe(0);
    expect(help.stdout).toContain("xbrief:verify");

    const root = freshRoot("xbrief-verify-id-");
    const created = createXbrief({
      format: "both",
      out: "pair/id",
      style: "scope",
      title: "Id Pair",
      id: "id-1",
      projectRoot: root,
      force: true,
    });
    expect(created.exitCode).toBe(0);
    const mdPath = join(root, "pair", "id.xbrief.md");
    const md = readFileSync(mdPath, "utf8")
      .replace(/^id:\s*.+$/m, "id: other-id")
      .replace(/(## Status\n\n).+/m, "$1running");
    writeFileSync(mdPath, md, "utf8");
    const r = verifyXbrief({
      format: "both",
      out: "pair/id",
      style: "scope",
      projectRoot: root,
    });
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toMatch(/mismatch/);
  });

  it("rejects invalid style and missing flag values", () => {
    expect(parseVerifyArgv(["--format", "json", "--out", "x", "--style", "nope"])).toMatchObject({
      error: expect.stringContaining("invalid --style"),
    });
    expect(parseVerifyArgv(["--out"])).toMatchObject({
      error: expect.stringContaining("expected one argument"),
    });
  });
});

function readAndRewriteTitle(path: string, newTitle: string): string {
  const text = readFileSync(path, "utf8");
  return text.replace(/^# .+$/m, `# ${newTitle}`).replace(/(## Title\n\n).+/m, `$1${newTitle}`);
}
