import { describe, expect, it } from "vitest";
import { closedVerbEnvBypassKey, evaluateClosedVerb } from "./closed-verb.js";
import { builtinReleaseVerbClassification, loadVerbClassification } from "./verb-classification.js";

describe("release-promote-latest closed verb (#5852 P2)", () => {
  it("is its own row with its own env bypass key (builtin; file overlays builtin)", () => {
    const builtin = builtinReleaseVerbClassification().verbs["release-promote-latest"];
    const loaded = loadVerbClassification(process.cwd()).verbs["release-promote-latest"];
    expect(builtin?.env_bypass).toBe("DEFT_ALLOW_RELEASE_PROMOTE_LATEST");
    expect(loaded).toEqual(builtin);
    expect(builtin?.authz_operations).toEqual(["release-promote-latest"]);
    expect(builtin?.authz_operations).not.toContain("deployment");
    expect(closedVerbEnvBypassKey("release-promote-latest")).toBe(
      "DEFT_ALLOW_RELEASE_PROMOTE_LATEST",
    );
  });

  it("is not authorized by the release-publish bypass", () => {
    const d = evaluateClosedVerb({
      verb: "release-promote-latest",
      target: "0.129.0",
      grants: [],
      env: { DEFT_ALLOW_RELEASE_PUBLISH: "1" },
    });
    expect(d.allowed).toBe(false);
  });

  it("allows only via its own explicit bypass", () => {
    const d = evaluateClosedVerb({
      verb: "release-promote-latest",
      target: "0.129.0",
      grants: [],
      env: { DEFT_ALLOW_RELEASE_PROMOTE_LATEST: "1" },
    });
    expect(d.allowed).toBe(true);
  });
});
