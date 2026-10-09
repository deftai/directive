import { describe, expect, it } from "vitest";
import {
  classifyChangedPath,
  evaluateCoverageApplicability,
  isCoverageHeadroomNotApplicable,
  isProjectDefinitionRegistryRefreshOnly,
  parseNameStatus,
} from "./index.js";

describe("coverage-applicability barrel", () => {
  it("re-exports classifier and name-status helpers with fail-closed behavior", () => {
    expect(parseNameStatus("R100\told.ts\tnew.md\n")).toEqual([
      { status: "R100", oldPath: "old.ts", path: "new.md" },
    ]);
    expect(classifyChangedPath("packages/core/src/a.ts", "M", null)).toBe("coverable");
    expect(classifyChangedPath("xbrief/decisions/d.json", "A", null)).toBe("inert");
    expect(classifyChangedPath("mystery.bin", "A", null)).toBe("unknown");
    expect(typeof isProjectDefinitionRegistryRefreshOnly).toBe("function");
    const refused = evaluateCoverageApplicability({
      projectRoot: process.cwd(),
      baseSha: "",
      headSha: "head",
      treeHash: "tree",
    });
    expect(refused.outcome).toBe("refuse");
    expect(
      isCoverageHeadroomNotApplicable({
        projectRoot: process.cwd(),
        baseSha: "",
        headSha: "head",
        treeHash: "tree",
      }),
    ).toBe(false);
  });
});
