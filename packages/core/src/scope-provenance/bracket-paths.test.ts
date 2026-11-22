import { describe, expect, it } from "vitest";
import { concreteProductionScopeEntries, isConcreteFileScopeEntry } from "./base-fence.js";
import { assessExtraPaths, matchesExtraPathAllowlist } from "./extra-path-admission.js";
import { buildAuthHashV1Preimage } from "./forge-approval.js";

const ROUTE = "src/app/crm/pipeline/[id]/page.tsx";
const SIBLING = "src/app/crm/pipeline/i/page.tsx";

function brief(scope: readonly string[]): Record<string, unknown> {
  return {
    xBRIEFInfo: { version: "0.8" },
    plan: { id: "s-1", title: "S", status: "running", metadata: { swarm: { file_scope: scope } } },
  };
}

describe("bracket paths in the scope-provenance fence (#6936)", () => {
  it("counts a dynamic-route entry as a concrete production entry", () => {
    expect(isConcreteFileScopeEntry(ROUTE)).toBe(true);
    expect(isConcreteFileScopeEntry("src/*.ts")).toBe(false);
    expect(isConcreteFileScopeEntry("src/?.ts")).toBe(false);
    expect(concreteProductionScopeEntries([ROUTE, "src/lib/a.ts", "src/*.ts"])).toEqual([
      ROUTE,
      "src/lib/a.ts",
    ]);
  });

  it("keeps the entry in concrete-only membership and admits only the literal file", () => {
    expect(matchesExtraPathAllowlist(ROUTE, [ROUTE], "concrete")).toBe(true);
    expect(matchesExtraPathAllowlist(SIBLING, [ROUTE], "concrete")).toBe(false);
    expect(matchesExtraPathAllowlist(SIBLING, [ROUTE], "mint")).toBe(false);
  });

  it("admits a changed bracket file in scope and spends a bracket extra instead of refusing it", () => {
    const inScope = assessExtraPaths({
      allowlist: [ROUTE],
      authority: "concrete",
      otherClass: "refuse",
      changedPaths: [ROUTE],
    });
    expect(inScope.entries).toEqual([]);
    expect(inScope.concreteBaseCount).toBe(1);

    const extra = assessExtraPaths({
      allowlist: ["src/lib/a.ts"],
      authority: "concrete",
      otherClass: "refuse",
      changedPaths: ["src/app/[slug]/page.tsx"],
    });
    expect(extra.refused).toEqual([]);
    expect(extra.spent).toEqual(["src/app/[slug]/page.tsx"]);
    expect(extra.entries[0]?.note).not.toMatch(/glob characters/);
  });

  it("changes the forge-approval hash preimage only for scopes with a bracket entry", () => {
    const plain = buildAuthHashV1Preimage(
      brief(["src/lib/a.ts", "src/*.ts"]),
      "xbrief/active/s.json",
    );
    expect(plain?.fileScope).toEqual(["src/lib/a.ts"]);
    const bracket = buildAuthHashV1Preimage(brief([ROUTE, "src/lib/a.ts"]), "xbrief/active/s.json");
    expect(bracket?.fileScope).toContain(ROUTE);
  });
});
