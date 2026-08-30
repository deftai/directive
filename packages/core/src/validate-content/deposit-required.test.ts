import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  DEPOSIT_PREFIX,
  DEPOSIT_REQUIRED_SCHEMA,
  evaluateDepositClosure,
  evaluateInstalledDepositClosure,
  extractDepositRequiredComments,
  packRelativeFromDepositPath,
  parseDepositRequiredDeclaration,
  renderDeclaredDepositClosureLine,
  sourcePathForPackRelative,
} from "./deposit-required.js";

const roots: string[] = [];

function tempRoot(prefix = "deft-c1-"): string {
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

/** Naive ! + .deft/core/ scan -- the extractor C1 must not be. */
function naiveProseExtractor(source: string): string[] {
  const out: string[] = [];
  const pathRe = /\.deft\/core\/[^\s`]+/g;
  for (const line of source.split("\n")) {
    if (!line.trimStart().startsWith("!")) continue;
    let match = pathRe.exec(line);
    while (match !== null) {
      out.push(match[0].replace(/[.,;:]+$/, ""));
      match = pathRe.exec(line);
    }
  }
  return out;
}

const PROSE_FIXTURE = [
  "! Full guidelines: .deft/core/main.md <!-- deposit-required: .deft/core/main.md -->",
  "! load USER.md and xbrief/PROJECT-DEFINITION.xbrief.json",
  "! If skills cannot be read, read .deft/core/QUICK-START.md",
  "! Historical: scripts/preflight_implementation.py was removed in #2022",
  "! Do not ship .deft/core/REFERENCES.md (repo-dev audience boundary)",
  "\u2297 never `.deft/core/` for cold-start (#2273)",
].join("\n");

describe("extractDepositRequiredComments (#3601 C1)", () => {
  it("extracts only parser-visible deposit-required fields", () => {
    expect(extractDepositRequiredComments(PROSE_FIXTURE)).toEqual([".deft/core/main.md"]);
  });

  it("does not misclassify consumer-owned, conditional, historical, or prohibited paths", () => {
    const extracted = extractDepositRequiredComments(PROSE_FIXTURE);
    expect(extracted).not.toContain("USER.md");
    expect(extracted).not.toContain("xbrief/PROJECT-DEFINITION.xbrief.json");
    expect(extracted).not.toContain(".deft/core/QUICK-START.md");
    expect(extracted).not.toContain("scripts/preflight_implementation.py");
    expect(extracted).not.toContain(".deft/core/REFERENCES.md");
    expect(extracted).not.toContain(".deft/core/");
  });

  it("differs from a regex over ! prose, which misclassifies the same fixture", () => {
    const naive = naiveProseExtractor(PROSE_FIXTURE);
    expect(naive).toEqual(
      expect.arrayContaining([
        ".deft/core/main.md",
        ".deft/core/QUICK-START.md",
        ".deft/core/REFERENCES.md",
      ]),
    );
    expect(extractDepositRequiredComments(PROSE_FIXTURE)).toEqual([".deft/core/main.md"]);
  });

  it("returns empty on prose with no typed field", () => {
    expect(extractDepositRequiredComments("! read .deft/core/commands.md")).toEqual([]);
  });
});

describe("parseDepositRequiredDeclaration", () => {
  it("accepts a closed v1 declaration", () => {
    const parsed = parseDepositRequiredDeclaration(
      JSON.stringify({ schema: DEPOSIT_REQUIRED_SCHEMA, paths: [".deft/core/main.md"] }),
    );
    expect(parsed.paths).toEqual([".deft/core/main.md"]);
  });

  it("rejects a missing schema, empty paths, and non-deposit paths", () => {
    expect(() => parseDepositRequiredDeclaration("{}")).toThrow(/expected schema/);
    expect(() =>
      parseDepositRequiredDeclaration(
        JSON.stringify({ schema: DEPOSIT_REQUIRED_SCHEMA, paths: [] }),
      ),
    ).toThrow(/non-empty/);
    expect(() =>
      parseDepositRequiredDeclaration(
        JSON.stringify({ schema: DEPOSIT_REQUIRED_SCHEMA, paths: ["USER.md"] }),
      ),
    ).toThrow(/invalid path/);
    expect(() =>
      parseDepositRequiredDeclaration(
        JSON.stringify({ schema: DEPOSIT_REQUIRED_SCHEMA, paths: [".deft/core/../etc/passwd"] }),
      ),
    ).toThrow(/invalid path/);
  });
});

describe("evaluateDepositClosure mutation (#3601 C1 non-vacuous)", () => {
  it("passes when every declared path exists in the staged pack, and fails after a delete", () => {
    const pack = tempRoot();
    mkdirSync(join(pack, "docs"), { recursive: true });
    writeFileSync(join(pack, "main.md"), "# main\n", "utf8");
    writeFileSync(join(pack, "docs", "gate-integrity.md"), "# gate\n", "utf8");
    const paths = [".deft/core/main.md", ".deft/core/docs/gate-integrity.md"];
    const ok = evaluateDepositClosure({ packRoot: pack, paths });
    expect(ok).toEqual({ ok: true, missing: [], checked: 2 });

    rmSync(join(pack, "main.md"));
    const mutated = evaluateDepositClosure({ packRoot: pack, paths });
    expect(mutated.ok).toBe(false);
    expect(mutated.missing).toEqual([".deft/core/main.md"]);
  });

  it("does not treat a source-checkout-only file as present in the pack", () => {
    const pack = tempRoot();
    writeFileSync(join(pack, "main.md"), "# main\n", "utf8");
    const result = evaluateDepositClosure({
      packRoot: pack,
      paths: [".deft/core/main.md", ".deft/core/REFERENCES.md"],
    });
    expect(result.ok).toBe(false);
    expect(result.missing).toEqual([".deft/core/REFERENCES.md"]);
  });
});

describe("prepack mapping", () => {
  it("maps harness entries to repo root and other paths under content/", () => {
    expect(packRelativeFromDepositPath(".deft/core/main.md")).toBe("main.md");
    expect(sourcePathForPackRelative(join("repo"), "main.md")).toBe(join("repo", "main.md"));
    expect(sourcePathForPackRelative(join("repo"), "commands.md")).toBe(
      join("repo", "content", "commands.md"),
    );
    expect(DEPOSIT_PREFIX).toBe(".deft/core/");
  });
});

describe("renderDeclaredDepositClosureLine", () => {
  it("skips when no declaration is present", () => {
    expect(
      renderDeclaredDepositClosureLine({ skipped: true, missing: [], declarationPath: null }),
    ).toContain("skip");
  });

  it("reports ok and fail", () => {
    expect(
      renderDeclaredDepositClosureLine({
        skipped: false,
        missing: [],
        declarationPath: "contracts/deposit-required-paths.json",
      }),
    ).toContain("ok");
    expect(
      renderDeclaredDepositClosureLine({
        skipped: false,
        missing: [".deft/core/main.md"],
        declarationPath: "contracts/deposit-required-paths.json",
      }),
    ).toContain("fail");
  });
});

describe("evaluateInstalledDepositClosure", () => {
  it("skips when the declaration is absent", () => {
    const root = tempRoot();
    const result = evaluateInstalledDepositClosure(root);
    expect(result.skipped).toBe(true);
    expect(result.missing).toEqual([]);
  });

  it("reports missing declared paths in an installed deposit", () => {
    const root = tempRoot();
    const deft = join(root, ".deft", "core");
    mkdirSync(join(deft, "contracts"), { recursive: true });
    writeFileSync(
      join(deft, "contracts", "deposit-required-paths.json"),
      JSON.stringify({
        schema: DEPOSIT_REQUIRED_SCHEMA,
        paths: [".deft/core/main.md", ".deft/core/commands.md"],
      }),
      "utf8",
    );
    writeFileSync(join(deft, "main.md"), "# main\n", "utf8");
    const result = evaluateInstalledDepositClosure(root);
    expect(result.skipped).toBe(false);
    expect(result.missing).toEqual([".deft/core/commands.md"]);
  });
});
