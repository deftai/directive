import { describe, expect, it } from "vitest";
import { isFile, readText } from "./_helpers.js";

const typescriptMd = readText("languages/typescript.md");
const upgradingMd = readText("UPGRADING.md");

describe("test_typescript_ts7_side_by_side.py", () => {
  it("test_typescript_md_file_exists", () => {
    expect(isFile("languages/typescript.md")).toBe(true);
  });

  it("test_typescript_md_carries_ts7_side_by_side_heading", () => {
    expect(typescriptMd).toMatch(/^## TypeScript 7 side-by-side \(pre-7\.1\)/m);
  });

  for (const alias of [
    '"@typescript/native": "npm:typescript@^7.0.2"',
    '"typescript": "npm:@typescript/typescript6@^6.0.2"',
    "@typescript/typescript6",
    'dependency-name: "typescript"',
    "version-update:semver-major",
  ]) {
    it(`test_typescript_md_pins_required_alias_tokens ${alias}`, () => {
      expect(typescriptMd).toContain(alias);
    });
  }

  it("test_typescript_md_links_official_and_typescript_eslint_refs", () => {
    expect(typescriptMd).toContain("devblogs.microsoft.com/typescript/announcing-typescript-7-0");
    expect(typescriptMd).toContain("typescript-eslint/typescript-eslint/issues/12518");
  });

  it("test_typescript_md_records_scaffold_deferred_and_doctor_shipped", () => {
    expect(typescriptMd).toContain("Scaffold bake — deferred");
    expect(typescriptMd).toContain("Doctor hint — shipped");
    expect(typescriptMd).not.toContain("Doctor / verify hint — deferred");
    expect(typescriptMd).toContain("#2591");
  });

  it("test_upgrading_md_carries_ts7_pointer_heading", () => {
    expect(upgradingMd).toMatch(/^## TypeScript 7 side-by-side \(pre-7\.1\) \(#2591\)/m);
  });

  for (const field of ["Applies when", "Safe to auto-run", "Restart required", "Commands"]) {
    it(`test_upgrading_pointer_has_${field.replace(/ /g, "_").toLowerCase()}`, () => {
      const start = upgradingMd.indexOf("## TypeScript 7 side-by-side (pre-7.1) (#2591)");
      expect(start).toBeGreaterThanOrEqual(0);
      const section = upgradingMd.slice(start, upgradingMd.indexOf("\n---", start));
      expect(section).toContain(`**${field}:**`);
    });
  }

  it("test_upgrading_pointer_links_typescript_md_section", () => {
    expect(upgradingMd).toContain("./languages/typescript.md");
    expect(upgradingMd).toContain("typescript-7-side-by-side-pre-71");
  });
});
