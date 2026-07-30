import { describe, expect, it } from "vitest";
import {
  ENV_SESSION_SLASH_VERB,
  evaluateIntentCeiling,
  evaluateIntentCeilingFromEnv,
  isImplementSlashVerb,
  isNonImplementSlashVerb,
  normalizeSessionVerb,
} from "./intent-ceiling.js";

describe("normalizeSessionVerb", () => {
  it("strips leading slash and namespaces", () => {
    expect(normalizeSessionVerb("/github-issue")).toBe("github-issue");
    expect(normalizeSessionVerb("/deft:directive:github-issue")).toBe("github-issue");
    expect(normalizeSessionVerb("deft:directive:build")).toBe("build");
    expect(normalizeSessionVerb("/ship-hotfix")).toBe("ship-hotfix");
  });

  it("returns null for empty", () => {
    expect(normalizeSessionVerb("")).toBeNull();
    expect(normalizeSessionVerb(null)).toBeNull();
    expect(normalizeSessionVerb("   ")).toBeNull();
  });
});

describe("evaluateIntentCeiling", () => {
  it("allows when no slash verb (free-text #810 path)", () => {
    const d = evaluateIntentCeiling({ sessionVerb: null, requestedOp: "implement" });
    expect(d.allowed).toBe(true);
    expect(d.code).toBe("intent-allow-no-slash");
  });

  it("allows implement slash verbs for all lifecycle ops", () => {
    for (const verb of ["/build", "/ship", "/ship-hotfix", "/swarm", "/implement"]) {
      for (const op of ["implement", "push", "pr", "merge", "deploy"] as const) {
        const d = evaluateIntentCeiling({ sessionVerb: verb, requestedOp: op });
        expect(d.allowed, `${verb} ${op}`).toBe(true);
        expect(d.code).toBe("intent-allow-implement-verb");
      }
    }
  });

  it("denies non-implement slash verbs for implement/push/pr/merge/deploy", () => {
    for (const verb of ["/github-issue", "/triage", "/refine", "/discuss", "/research"]) {
      for (const op of ["implement", "push", "pr", "merge", "deploy"] as const) {
        const d = evaluateIntentCeiling({ sessionVerb: verb, requestedOp: op });
        expect(d.allowed, `${verb} ${op}`).toBe(false);
        expect(d.code).toBe("intent-deny-non-implement");
        expect(d.reason).toContain("#1193");
      }
    }
  });

  it("denies unknown slash stems fail-closed", () => {
    const d = evaluateIntentCeiling({ sessionVerb: "/mystery-cmd", requestedOp: "merge" });
    expect(d.allowed).toBe(false);
    expect(d.code).toBe("intent-deny-unknown-slash");
  });

  it("reads DEFT_SESSION_SLASH_VERB from env", () => {
    const env = { [ENV_SESSION_SLASH_VERB]: "/github-issue" } as NodeJS.ProcessEnv;
    const d = evaluateIntentCeilingFromEnv("implement", env);
    expect(d.allowed).toBe(false);
    expect(d.sessionVerb).toBe("github-issue");
  });
});

describe("verb sets", () => {
  it("classifies known stems", () => {
    expect(isImplementSlashVerb("build")).toBe(true);
    expect(isNonImplementSlashVerb("github-issue")).toBe(true);
    expect(isImplementSlashVerb("github-issue")).toBe(false);
  });
});
