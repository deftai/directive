import { describe, expect, it } from "vitest";
import { OverlappingMintError, resolveClaimFromStore, UniqueMembershipError } from "./app-store.js";
import { InProcessAppStore } from "./simulator.js";
import type { OriginRef } from "./types.js";

const origin: OriginRef = { repo: "deftai/directive", issueId: 4204 };

describe("app-store contract", () => {
  it("UniqueMembershipError names the origin", () => {
    const err = new UniqueMembershipError(origin);
    expect(err.name).toBe("UniqueMembershipError");
    expect(err.origin).toEqual(origin);
    expect(err.message).toContain("4204");
  });

  it("OverlappingMintError is concurrent-mint abort", () => {
    const err = new OverlappingMintError();
    expect(err.name).toBe("OverlappingMintError");
    expect(err.message).toMatch(/overlapping concurrent/);
  });

  it("resolveClaimFromStore prefers bound PR node over opaque id", () => {
    const store = new InProcessAppStore();
    const claim = store.mint({
      actor: "dbcall2",
      approvalRef: "op",
      rationale: "batch",
      origins: [origin, { repo: "deftai/directive", issueId: 4218 }],
      repo: "deftai/directive",
      id: "unit-a",
      now: new Date(),
    });
    store.bind(claim.id, "PR_NODE_1");
    expect(resolveClaimFromStore(store, { id: "unit-a" })?.id).toBe("unit-a");
    expect(resolveClaimFromStore(store, { prNodeId: "PR_NODE_1" })?.id).toBe("unit-a");
    expect(resolveClaimFromStore(store, { id: "nope" })).toBeNull();
    expect(resolveClaimFromStore(store, {})).toBeNull();
  });
});
