import { describe, expect, it } from "vitest";
import { evaluateUntraceableSurfaces } from "./surface-check.js";
import { UNTRACEABLE_SURFACE_REMEDIATION } from "./types.js";

describe("surface-check (#4545)", () => {
  it("warns on delete actions when requirements are add-only", () => {
    const result = evaluateUntraceableSurfaces({
      requirementLines: ["add vehicle"],
      surfaces: [
        { kind: "server-action", id: "addVehicleAction" },
        { kind: "server-action", id: "deleteVehicleAction" },
      ],
    });
    expect(result.severity).toBe("warn");
    expect(result.untraceable.map((u) => u.surface.id)).toEqual(["deleteVehicleAction"]);
    expect(result.remediation).toBe(UNTRACEABLE_SURFACE_REMEDIATION);
  });
});
