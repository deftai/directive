import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  C2_AUTHORING_SURFACES,
  evaluateSemanticSingleSource,
  extractSetupWriteVersion,
  resolveAuthoringSurface,
} from "./semantic-single-source.js";

const REPO_ROOT = join(import.meta.dirname, "..", "..", "..", "..");

function writeFile(root: string, rel: string, body: string): void {
  const full = join(root, rel);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, body, "utf8");
}

const SETUP_08 = `# Deft Directive Setup
! The output MUST conform to the canonical xBRIEF v0.8 schema.
\`\`\`json
{
  "xBRIEFInfo": {
    "version": "0.8",
    "description": "fixture"
  }
}
\`\`\`
- ! New scope xBRIEFs MUST use \`"xBRIEFInfo": { "version": "0.8" }\`
- ⊗ Emit \`"version": "0.6"\` on any new write path -- current engine write-default is \`0.8\` only
`;

const BUILD_08 = `# Deft Directive Build
All xBRIEFs MUST use \`"xBRIEFInfo": { "version": "0.8" }\`. Legacy 0.6 is read-accepted until \`deft migrate:xbrief\`.
`;

const MAIN_08 = `# main
### Schema version: v0.8 (canonical write)
- ! Every new xBRIEF MUST emit \`"xBRIEFInfo": { "version": "0.8" }\`
- ⊗ Emit \`"version": "0.6"\` on any new write path
`;

const MAIN_06_STALE = `# main
### Schema version: v0.6 (canonical)
All vBRIEFs MUST use \`"vBRIEFInfo": { "version": "0.6" }\`:
- ! Every vBRIEF MUST emit \`"vBRIEFInfo": { "version": "0.6" }\`
`;

function seedCleanPack(): string {
  const root = mkdtempSync(join(tmpdir(), "c2-pack-"));
  writeFile(root, "main.md", MAIN_08);
  writeFile(root, "skills/deft-directive-setup/SKILL.md", SETUP_08);
  writeFile(root, "skills/deft-directive-build/SKILL.md", BUILD_08);
  return root;
}

describe("C2 semantic single-source (#3600 / #3899)", () => {
  let root: string | undefined;

  afterEach(() => {
    if (root !== undefined) {
      rmSync(root, { recursive: true, force: true });
      root = undefined;
    }
  });

  it("does not import or mention validate-links (C2 is not pointer resolution)", () => {
    const src = readFileSync(join(import.meta.dirname, "semantic-single-source.ts"), "utf8");
    expect(src).not.toMatch(/validate-links|extractLinkTargets|BrokenLink/);
    expect(src).toMatch(/not a link checker/);
  });

  it("extracts the version setup writes from the xBRIEFInfo template", () => {
    expect(extractSetupWriteVersion(SETUP_08)).toBe("0.8");
  });

  it("exits 0 on a staged pack that names only the setup write version", () => {
    root = seedCleanPack();
    const result = evaluateSemanticSingleSource(root);
    expect(result.code).toBe(0);
    expect(result.setupWriteVersion).toBe("0.8");
    expect(result.currentWriteVersions).toEqual(["0.8"]);
    expect(result.violations).toHaveLength(0);
  });

  it("exits 1 on a deliberately mutated staged tree that reverts main.md to 0.6", () => {
    root = seedCleanPack();
    writeFile(root, "main.md", MAIN_06_STALE);
    const result = evaluateSemanticSingleSource(root);
    expect(result.code).toBe(1);
    expect(result.stream).toBe("stderr");
    expect(result.violations.some((v) => v.path === "main.md" && v.version === "0.6")).toBe(true);
    expect(result.message).toContain("0.6");
  });

  it("treats bounded legacy 0.6 on the same MUST line as non-violating", () => {
    root = seedCleanPack();
    writeFile(
      root,
      "skills/deft-directive-build/SKILL.md",
      `# Build\n- ! New xBRIEFs MUST use \`"xBRIEFInfo": { "version": "0.8" }\` (legacy 0.6 remains read-accepted until \`deft migrate:xbrief\`)\n`,
    );
    const result = evaluateSemanticSingleSource(root);
    expect(result.code, result.message).toBe(0);
  });

  it("exits 1 when a mixed line mutates the envelope to 0.6 beside a legacy qualifier", () => {
    root = seedCleanPack();
    writeFile(
      root,
      "skills/deft-directive-build/SKILL.md",
      `# Build\n- ! New xBRIEFs MUST use \`"xBRIEFInfo": { "version": "0.6" }\` (legacy 0.6 remains read-accepted until \`deft migrate:xbrief\`)\n`,
    );
    const result = evaluateSemanticSingleSource(root);
    expect(result.code).toBe(1);
    expect(result.violations.some((v) => v.path.includes("build") && v.version === "0.6")).toBe(
      true,
    );
  });

  it("exits 2 when a resolved authoring surface cannot be read", () => {
    root = seedCleanPack();
    const mainPath = join(root, "main.md");
    rmSync(mainPath);
    mkdirSync(mainPath);
    const result = evaluateSemanticSingleSource(root);
    expect(result.code).toBe(2);
    expect(result.message).toMatch(/failed to read main\.md/i);
  });

  it("exits 2 when required surfaces are missing from the pack root", () => {
    root = mkdtempSync(join(tmpdir(), "c2-empty-"));
    const result = evaluateSemanticSingleSource(root);
    expect(result.code).toBe(2);
    expect(result.message).toContain("missing");
  });

  it("exits 2 when packRoot is not a directory", () => {
    const result = evaluateSemanticSingleSource(join(tmpdir(), "c2-no-such-dir-3600"));
    expect(result.code).toBe(2);
  });

  it("resolves flattened pack paths without a content/ prefix", () => {
    root = seedCleanPack();
    expect(resolveAuthoringSurface(root, "main.md")).toBe(join(root, "main.md"));
    expect(resolveAuthoringSurface(root, "skills/deft-directive-setup/SKILL.md")).toBe(
      join(root, "skills/deft-directive-setup/SKILL.md"),
    );
  });

  it("passes the live framework source after the 0.8 canon repair", () => {
    const result = evaluateSemanticSingleSource(REPO_ROOT);
    expect(result.code, result.message).toBe(0);
    expect(result.setupWriteVersion).toBe("0.8");
  });

  it("fails when the live source is copied to a staged tree and main.md is reverted", () => {
    root = mkdtempSync(join(tmpdir(), "c2-mutated-live-"));
    for (const rel of C2_AUTHORING_SURFACES) {
      const src = resolveAuthoringSurface(REPO_ROOT, rel);
      if (src === null) continue;
      writeFile(root, rel, readFileSync(src, "utf8"));
    }
    const before = evaluateSemanticSingleSource(root);
    expect(before.code, before.message).toBe(0);
    const mainPath = join(root, "main.md");
    const original = readFileSync(mainPath, "utf8");
    writeFileSync(
      mainPath,
      original.replace(
        /### Schema version:[\s\S]*?(?=\n## )/,
        '### Schema version: v0.6 (canonical)\n\nAll vBRIEFs MUST use `"vBRIEFInfo": { "version": "0.6" }`:\n- ! Every vBRIEF MUST emit `"vBRIEFInfo": { "version": "0.6" }`\n\n',
      ),
      "utf8",
    );
    const after = evaluateSemanticSingleSource(root);
    expect(after.code).toBe(1);
    expect(after.violations.some((v) => v.version === "0.6")).toBe(true);
  });
});
