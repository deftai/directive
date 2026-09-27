import { describe, expect, it } from "vitest";
import {
  detectScopeLimitPhrase,
  evaluateUntraceableSurfaces,
  SCOPE_LIMIT_PHRASES,
  seedOperatorScopeCeiling,
} from "./index.js";

describe("index (#4545)", () => {
  it("re-exports the seed and surface-check entry points", () => {
    expect(SCOPE_LIMIT_PHRASES.length).toBeGreaterThan(0);
    expect(detectScopeLimitPhrase("nothing beyond this")?.phrase).toBe("nothing beyond");
    const seeded = seedOperatorScopeCeiling("add vehicle\n\nnothing beyond the list");
    expect(seeded.ok).toBe(true);
    if (!seeded.ok) return;
    const check = evaluateUntraceableSurfaces({
      requirementLines: seeded.ceiling.requirementLines,
      surfaces: [{ kind: "server-action", id: "addVehicleAction" }],
    });
    expect(check.severity).toBe("clean");
  });
});
