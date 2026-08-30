import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { DEPOSIT_REQUIRED_SCHEMA } from "../validate-content/deposit-required.js";
import {
  evaluateDepositClosureAtRoot,
  evaluateDepositClosureFromRepo,
  evaluateStagedDepositClosure,
  formatStagedDepositClosureLine,
  stageDeclaredPack,
} from "./deposit-closure.js";

const roots: string[] = [];

function tempRoot(prefix = "deft-3900-"): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

afterEach(() => {
  while (roots.length > 0) {
    const root = roots.pop();
    if (root) rmSync(root, { recursive: true, force: true });
  }
});

function writeDeclaration(dir: string, paths: readonly string[]): void {
  mkdirSync(join(dir, "contracts"), { recursive: true });
  writeFileSync(
    join(dir, "contracts", "deposit-required-paths.json"),
    JSON.stringify({ schema: DEPOSIT_REQUIRED_SCHEMA, paths }),
    "utf8",
  );
}

describe("evaluateStagedDepositClosure (#3900 check 1)", () => {
  it("passes when every declared path exists in the staged pack", () => {
    const pack = tempRoot();
    writeFileSync(join(pack, "main.md"), "# main\n", "utf8");
    writeDeclaration(pack, [".deft/core/main.md"]);
    const result = evaluateStagedDepositClosure(pack, [".deft/core/main.md"]);
    expect(result.code).toBe(0);
    expect(result.missing).toEqual([]);
    expect(result.message).toContain("ok");
  });

  it("fails a mutated staged tree that deletes a declared file (non-vacuous)", () => {
    const pack = tempRoot();
    writeFileSync(join(pack, "main.md"), "# main\n", "utf8");
    const ok = evaluateStagedDepositClosure(pack, [".deft/core/main.md"]);
    expect(ok.code).toBe(0);
    rmSync(join(pack, "main.md"));
    const mutated = evaluateStagedDepositClosure(pack, [".deft/core/main.md"]);
    expect(mutated.code).toBe(1);
    expect(mutated.missing).toEqual([".deft/core/main.md"]);
    expect(mutated.message).toContain("Recovery:");
    expect(mutated.stream).toBe("stderr");
  });

  it("reproduces a 0.107.0-shaped pack missing a declared deposit file", () => {
    const pack = tempRoot();
    writeFileSync(join(pack, "main.md"), "# main\n", "utf8");
    const result = evaluateStagedDepositClosure(pack, [
      ".deft/core/main.md",
      ".deft/core/contracts/deposit-required-paths.json",
    ]);
    expect(result.code).toBe(1);
    expect(result.missing).toEqual([".deft/core/contracts/deposit-required-paths.json"]);
  });

  it("returns config when pack root is not a directory", () => {
    const result = evaluateStagedDepositClosure(join(tempRoot(), "missing"), [
      ".deft/core/main.md",
    ]);
    expect(result.code).toBe(2);
    expect(result.message).toContain("not a directory");
  });
});

describe("formatStagedDepositClosureLine", () => {
  it("names the missing path and a single remediation line", () => {
    const line = formatStagedDepositClosureLine({
      ok: false,
      missing: [".deft/core/main.md"],
      checked: 1,
    });
    expect(line).toContain("fail");
    expect(line).toContain(".deft/core/main.md");
    expect(line).toContain("Recovery:");
  });
});

describe("evaluateDepositClosureAtRoot", () => {
  it("reports config when the C1 declaration is absent", () => {
    const root = tempRoot();
    const result = evaluateDepositClosureAtRoot(root, false);
    expect(result.code).toBe(2);
    expect(result.message).toContain("C1 declaration missing");
  });

  it("evaluates an explicit pack root against its declaration", () => {
    const pack = tempRoot();
    writeFileSync(join(pack, "main.md"), "# main\n", "utf8");
    writeDeclaration(pack, [".deft/core/main.md"]);
    const result = evaluateDepositClosureAtRoot(pack, true);
    expect(result.code).toBe(0);
    expect(result.checked).toBe(1);
  });
});

describe("stageDeclaredPack", () => {
  it("copies declared source files into the dest pack and skips missing ones", () => {
    const repo = tempRoot();
    writeFileSync(join(repo, "main.md"), "# main\n", "utf8");
    mkdirSync(join(repo, "content", "contracts"), { recursive: true });
    writeFileSync(
      join(repo, "content", "contracts", "deposit-required-paths.json"),
      JSON.stringify({
        schema: DEPOSIT_REQUIRED_SCHEMA,
        paths: [".deft/core/main.md", ".deft/core/commands.md"],
      }),
      "utf8",
    );
    const dest = join(tempRoot(), "pack");
    const declaration = stageDeclaredPack(repo, dest);
    expect(declaration.paths).toContain(".deft/core/main.md");
    const result = evaluateStagedDepositClosure(dest, declaration.paths);
    expect(result.missing).toEqual([".deft/core/commands.md"]);
    expect(result.code).toBe(1);
  });
});

describe("current framework tree (#3900 AC fixed-deposit)", () => {
  it("stages the C1 declaration from this checkout and reports clear", () => {
    const here = fileURLToPath(new URL(".", import.meta.url));
    const root = resolve(here, "../../../../");
    const result = evaluateDepositClosureFromRepo(root);
    expect(result.code, result.message).toBe(0);
  });
});
