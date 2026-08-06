import { describe, expect, it } from "vitest";
import { buildFailureInfo } from "./fingerprint.js";
import { evaluateMaterialProgress, isRevisionChangeMaterial } from "./material-delta.js";

describe("material-delta (#3143)", () => {
  it("treats revision-id change alone as non-material", () => {
    expect(isRevisionChangeMaterial("rev-1", "rev-2")).toBe(false);
    expect(isRevisionChangeMaterial(null, "rev-1")).toBe(false);
  });

  it("accepts code/config deltas that address the failing resource class", () => {
    const failure = buildFailureInfo({
      stage: "validate",
      code: "CONFIG",
      retryability: "deterministic",
      resourceClass: "config",
    });
    const r = evaluateMaterialProgress({
      claims: [
        {
          kind: "configuration",
          addresses: ["config"],
          sourceRevision: "rev-2",
        },
      ],
      failure,
      evaluatedRevision: "rev-2",
    });
    expect(r.isMaterial).toBe(true);
    expect(r.classification).toBe("configuration");
  });

  it("rejects unrelated and source-bound mismatched evidence", () => {
    const failure = buildFailureInfo({
      stage: "accept",
      code: "EVIDENCE",
      retryability: "deterministic",
      resourceClass: "evidence",
    });
    const unrelated = evaluateMaterialProgress({
      claims: [{ kind: "unrelated", addresses: ["docs"], sourceRevision: "rev-2" }],
      failure,
      evaluatedRevision: "rev-2",
    });
    expect(unrelated.isMaterial).toBe(false);
    expect(unrelated.classification).toBe("unrelated");

    const stale = evaluateMaterialProgress({
      claims: [
        {
          kind: "evidence",
          addresses: ["evidence"],
          sourceRevision: "rev-1",
        },
      ],
      failure,
      evaluatedRevision: "rev-3",
    });
    expect(stale.isMaterial).toBe(false);
  });

  it("treats stage advancement as material", () => {
    const r = evaluateMaterialProgress({
      claims: [
        {
          kind: "stage",
          addresses: ["deploy"],
          sourceRevision: "rev-2",
        },
      ],
      failure: buildFailureInfo({ stage: "validate", code: "X", retryability: "deterministic" }),
      evaluatedRevision: "rev-2",
    });
    expect(r.isMaterial).toBe(true);
    expect(r.classification).toBe("stage");
  });
});
