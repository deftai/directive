import { describe, expect, it } from "vitest";
import { isDeclaredArtifactPath, isFileShapedPointer } from "../verify-ac/clauses.js";
import { hasGlobMagic, isConcreteScopePath, matchPath } from "./pathspec.js";

const ROUTE = "web/src/app/crm/pipeline/[id]/page.tsx";

describe("isConcreteScopePath (#6936)", () => {
  it("treats brackets as literal and only * and ? as glob magic", () => {
    for (const entry of [
      ROUTE,
      "web/src/pages/[slug].tsx",
      "web/src/app/[...slug]/page.tsx",
      "web/src/app/[[...slug]]/page.tsx",
      "src/[a-z].ts",
      "src/a.ts",
    ]) {
      expect(isConcreteScopePath(entry)).toBe(true);
      expect(hasGlobMagic(entry)).toBe(false);
    }
    for (const entry of ["src/*.ts", "src/?.ts", "src/**", "", "   "]) {
      expect(isConcreteScopePath(entry)).toBe(false);
    }
    expect(hasGlobMagic("src/*.ts")).toBe(true);
    expect(hasGlobMagic("src/?.ts")).toBe(true);
  });

  it("matches a bracket entry only against the literal path, never a sibling", () => {
    expect(matchPath(ROUTE, ROUTE)).toBe(true);
    expect(matchPath(ROUTE, "web/src/app/crm/pipeline/i/page.tsx")).toBe(false);
    expect(matchPath(ROUTE, "web/src/app/crm/pipeline/d/page.tsx")).toBe(false);
  });

  it("lets verify-ac accept a bracket artifact pointer inside the declared scope", () => {
    expect(isFileShapedPointer(ROUTE)).toBe(true);
    expect(isDeclaredArtifactPath(ROUTE, [ROUTE])).toBe(true);
    expect(isDeclaredArtifactPath(ROUTE, ["web/src/app/"])).toBe(true);
    expect(isDeclaredArtifactPath("web/src/app/crm/pipeline/i/page.tsx", [ROUTE])).toBe(false);
    expect(isDeclaredArtifactPath("src/*.ts", ["src/"])).toBe(false);
  });
});
