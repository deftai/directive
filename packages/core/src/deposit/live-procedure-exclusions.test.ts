import { describe, expect, it } from "vitest";
import {
  isDeclaredLiveProcedureExclusion,
  LIVE_PROCEDURE_EXCLUSIONS,
} from "./live-procedure-exclusions.js";

describe("C3 live-procedure exclusion declaration (#3602)", () => {
  it("carries history, example, and prohibition by declaration", () => {
    const kinds = new Set(LIVE_PROCEDURE_EXCLUSIONS.map((e) => e.kind));
    expect(kinds.has("history")).toBe(true);
    expect(kinds.has("example")).toBe(true);
    expect(kinds.has("prohibition")).toBe(true);
  });

  it("declares github.md as a prohibition, not a pattern skip", () => {
    const github = LIVE_PROCEDURE_EXCLUSIONS.find((e) => e.path === "scm/github.md");
    expect(github?.kind).toBe("prohibition");
    expect(isDeclaredLiveProcedureExclusion("scm/github.md")).toBe(true);
    expect(isDeclaredLiveProcedureExclusion("skills/demo/SKILL.md")).toBe(false);
  });

  it("requires a reason on every declared exclusion", () => {
    for (const entry of LIVE_PROCEDURE_EXCLUSIONS) {
      expect(entry.reason.length).toBeGreaterThan(0);
      expect(entry.path.includes("\\")).toBe(false);
    }
  });
});
