import { describe, expect, it } from "vitest";
import { routeArgv, TOP_LEVEL_UX_VERBS } from "./route-argv.js";

describe("route-argv: migrate top-level verb (#1941)", () => {
  it("registers migrate in the #1670 top-level UX vocabulary", () => {
    expect(TOP_LEVEL_UX_VERBS).toContain("migrate");
  });

  it("routes `migrate` to a dispatch with the migrate verb preserved", () => {
    const routed = routeArgv(["migrate"]);
    expect(routed.kind).toBe("dispatch");
    expect(routed.argv).toEqual(["migrate"]);
  });

  it("forwards trailing args to the migrate handler", () => {
    const routed = routeArgv(["migrate", "--repo-root", "/tmp/x", "--json"]);
    expect(routed.kind).toBe("dispatch");
    expect(routed.argv).toEqual(["migrate", "--repo-root", "/tmp/x", "--json"]);
  });

  it("routes migrate the same way as init and update (parallel branch)", () => {
    expect(routeArgv(["init"]).argv).toEqual(["init"]);
    expect(routeArgv(["update"]).argv).toEqual(["update"]);
    expect(routeArgv(["migrate"]).argv).toEqual(["migrate"]);
  });

  it("every curated top-level UX verb routes as dispatch or stub", () => {
    for (const verb of TOP_LEVEL_UX_VERBS) {
      expect(["dispatch", "stub"]).toContain(routeArgv([verb]).kind);
    }
  });
});
