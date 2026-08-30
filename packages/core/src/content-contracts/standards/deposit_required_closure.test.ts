import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { stageContentPack } from "../../deposit/stage-content-pack.js";
import {
  evaluateDepositClosure,
  loadDepositRequiredDeclaration,
  resolveDeclarationFile,
} from "../../validate-content/deposit-required.js";
import { readText, repoRoot } from "./_helpers.js";

const staged: string[] = [];

afterEach(() => {
  while (staged.length > 0) {
    const root = staged.pop();
    if (root) rmSync(root, { recursive: true, force: true });
  }
});

function stageDeclaredPack(root: string): string {
  const declarationPath = resolveDeclarationFile(root);
  expect(declarationPath, "C1 declaration must exist in the source tree").toBeTruthy();
  const tmp = mkdtempSync(join(tmpdir(), "deft-c1-prepack-"));
  staged.push(tmp);
  const pkgDir = join(tmp, "pack");
  mkdirSync(pkgDir, { recursive: true });
  stageContentPack({ repoRoot: root, destDir: pkgDir });
  return pkgDir;
}

describe("declared deposit closure against staged pack (#3601 C1)", () => {
  it("every declared required path exists after running content-package prepack", () => {
    const root = repoRoot();
    const declaration = loadDepositRequiredDeclaration(resolveDeclarationFile(root) as string);
    expect(declaration.paths.length).toBeGreaterThan(0);
    const pack = stageDeclaredPack(root);
    const result = evaluateDepositClosure({ packRoot: pack, paths: declaration.paths });
    expect(result.ok, result.missing.join(", ")).toBe(true);
  });

  it("fails when a declared file is deleted from the staged pack output", () => {
    const root = repoRoot();
    const declaration = loadDepositRequiredDeclaration(resolveDeclarationFile(root) as string);
    const pack = stageDeclaredPack(root);
    rmSync(join(pack, "main.md"));
    const mutated = evaluateDepositClosure({ packRoot: pack, paths: declaration.paths });
    expect(mutated.ok).toBe(false);
    expect(mutated.missing).toContain(".deft/core/main.md");
  });

  it("consumer template no longer mandates .deft/core/REFERENCES.md and names the pack-slice text form", () => {
    const template = readText("templates/agents-entry.md");
    const skills = template.split("## Skills")[1]?.split("## ")[0] ?? "";
    expect(skills).not.toContain(".deft/core/REFERENCES.md");
    expect(skills).toContain("packs:slice skills list");
    expect(skills).toContain("npx deft");
    expect(skills).toContain("--json");
    expect(skills).toContain("node_modules");
  });
});
