import { describe, expect, it } from "vitest";
import {
  assessExtraPaths,
  classifyExtraPath,
  declaredExtraPathRefusal,
  EXTRA_PATH_NOT_ADMITTED_TOKEN,
  EXTRA_PATHS_OVER_BUDGET_TOKEN,
  extraPathRemedy,
  extraPathsAdmitted,
  formatExtraPathRefusal,
  formatExtraPathReport,
  matchesExtraPathAllowlist,
} from "./extra-path-admission.js";

const modify = () => "modify" as const;

describe("classifyExtraPath (#6221)", () => {
  it("puts fixture before test before production; the rest is other", () => {
    expect(classifyExtraPath("tests/fixtures/a.json")).toBe("fixture");
    expect(classifyExtraPath("packages/core/src/a.test.ts")).toBe("test");
    expect(classifyExtraPath("packages/core/src/a.ts")).toBe("production");
    expect(classifyExtraPath("docs/a.md")).toBe("other");
    expect(classifyExtraPath("app/a.ts", { sourceRoots: ["app/**"] })).toBe("production");
  });
});

describe("declaredExtraPathRefusal remedy (#6914)", () => {
  const assessment = assessExtraPaths({
    allowlist: ["packages/core/src/a.ts"],
    authority: "concrete",
    otherClass: "refuse",
    changedPaths: ["docs/a.md"],
    changeKind: modify,
  });

  it("keeps the shared remedy by default (membership is unchanged)", () => {
    const line = declaredExtraPathRefusal(assessment, "not-admitted", "detail.");
    expect(line.line).toContain(extraPathRemedy(assessment));
  });

  it("uses the write-fence remedy when one is given", () => {
    const line = declaredExtraPathRefusal(assessment, "not-admitted", "detail.", undefined, "R.");
    expect(line.line).toContain("detail. R.");
    expect(line.line).not.toContain(extraPathRemedy(assessment));
  });
});

describe("matchesExtraPathAllowlist (#6221)", () => {
  it("matches globs only under mint authority", () => {
    expect(
      matchesExtraPathAllowlist("packages/core/src/a.ts", ["packages/core/src/**"], "mint"),
    ).toBe(true);
    expect(
      matchesExtraPathAllowlist("packages/core/src/a.ts", ["packages/core/src/**"], "concrete"),
    ).toBe(false);
    expect(
      matchesExtraPathAllowlist("packages/core/src/a.ts", ["./packages/core/src/a.ts"], "concrete"),
    ).toBe(true);
  });

  it("requires the second list too when given", () => {
    expect(
      matchesExtraPathAllowlist("packages/core/src/b.ts", ["packages/core/src/**"], "mint", [
        "packages/core/src/a.ts",
      ]),
    ).toBe(false);
    expect(
      matchesExtraPathAllowlist("packages/core/src/a.ts", ["packages/core/src/**"], "mint", [
        "packages/core/src/a.ts",
      ]),
    ).toBe(true);
  });
});

describe("assessExtraPaths (#6221)", () => {
  const base = {
    allowlist: ["packages/core/src/a.ts"],
    authority: "concrete" as const,
    otherClass: "refuse" as const,
  };

  it("spends one allowance on a production extra and a test modify", () => {
    const a = assessExtraPaths({
      ...base,
      changedPaths: [
        "packages/core/src/a.ts",
        "packages/core/src/b.ts",
        "packages/core/src/x.test.ts",
      ],
      changeKind: modify,
    });
    expect(a.allowance).toBe(2);
    expect(a.concreteBaseCount).toBe(1);
    expect(a.spent).toEqual(["packages/core/src/b.ts", "packages/core/src/x.test.ts"]);
    expect(extraPathsAdmitted(a)).toBe(true);
    expect(a.entries.map((e) => `${e.pathClass}:${e.spend}`)).toEqual([
      "production:spent",
      "test:spent",
    ]);
  });

  it("refuses test or fixture add, delete and unknown change kinds", () => {
    const kinds: Record<string, "add" | "delete"> = {
      "packages/core/src/new.test.ts": "add",
      "tests/fixtures/gone.json": "delete",
    };
    const a = assessExtraPaths({
      ...base,
      changedPaths: [...Object.keys(kinds), "tests/helpers/unknown.ts"],
      changeKind: (rel) => kinds[rel] ?? null,
    });
    expect(a.refused).toEqual([
      "packages/core/src/new.test.ts",
      "tests/fixtures/gone.json",
      "tests/helpers/unknown.ts",
    ]);
    expect(a.entries[2]?.note).toMatch(/unknown/);
    expect(formatExtraPathRefusal(a)).toContain(EXTRA_PATH_NOT_ADMITTED_TOKEN);
  });

  it("puts spending paths past the allowance in overflow with the shared token", () => {
    const a = assessExtraPaths({
      ...base,
      changedPaths: [
        "packages/core/src/b.ts",
        "packages/core/src/c.test.ts",
        "packages/core/src/d.ts",
      ],
      changeKind: modify,
    });
    expect(a.overflow).toEqual(["packages/core/src/d.ts"]);
    expect(formatExtraPathRefusal(a)).toContain(EXTRA_PATHS_OVER_BUDGET_TOKEN);
    expect(extraPathRemedy(a)).toContain("replace glob entries with concrete paths");
  });

  it("refuses other-class paths unless told to ignore them", () => {
    const refused = assessExtraPaths({ ...base, changedPaths: ["docs/a.md"] });
    expect(refused.refused).toEqual(["docs/a.md"]);
    const ignored = assessExtraPaths({
      ...base,
      otherClass: "ignore",
      changedPaths: ["docs/a.md"],
    });
    expect(ignored.refused).toEqual([]);
    expect(ignored.entries[0]?.spend).toBe("free");
  });

  it("skips free paths and declared paths, counts each path once", () => {
    const a = assessExtraPaths({
      ...base,
      changedPaths: [
        "CHANGELOG.md",
        "packages/core/src/a.ts",
        "packages/core/src/b.ts",
        "packages/core/src/b.ts",
      ],
      isFree: (rel) => rel === "CHANGELOG.md",
    });
    expect(a.spent).toEqual(["packages/core/src/b.ts"]);
  });

  it("refuses a production path with glob characters", () => {
    // Brackets are literal (#6936); only * and ? make a path glob-shaped.
    const a = assessExtraPaths({ ...base, changedPaths: ["packages/core/src/*.ts"] });
    expect(a.refused).toEqual(["packages/core/src/*.ts"]);
  });

  it("counts the allowance from allowanceScope when given", () => {
    const a = assessExtraPaths({
      ...base,
      allowlist: ["packages/core/src/**"],
      authority: "mint",
      allowanceScope: [
        "packages/core/src/a.ts",
        "packages/core/src/b.ts",
        "packages/core/src/c.ts",
      ],
      changedPaths: [],
    });
    expect(a.allowance).toBe(3);
    expect(extraPathRemedy(a)).not.toContain("replace glob entries");
  });

  it("formats the success report without hard-refused rows", () => {
    const a = assessExtraPaths({
      ...base,
      otherClass: "ignore",
      changedPaths: ["packages/core/src/x.test.ts", "docs/a.md", "packages/core/src/n.test.ts"],
      changeKind: (rel) => (rel.includes("/n.") ? "add" : "modify"),
    });
    const lines = formatExtraPathReport("story", "path-independent", a);
    expect(lines[0]).toContain("1 of allowance 2 spent");
    expect(lines.join("\n")).toContain("packages/core/src/x.test.ts class=test spend=spent");
    expect(lines.join("\n")).toContain("docs/a.md class=other spend=free");
    expect(lines.join("\n")).not.toContain("n.test.ts");
    expect(
      formatExtraPathReport("story", "membership", assessExtraPaths({ ...base, changedPaths: [] })),
    ).toEqual([]);
  });
});
