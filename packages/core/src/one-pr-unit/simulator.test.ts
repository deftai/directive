import { describe, expect, it } from "vitest";
import { OverlappingMintError, UniqueMembershipError } from "./app-store.js";
import { InProcessAppStore } from "./simulator.js";
import type { OriginRef } from "./types.js";

const REPO = "deftai/directive";
const TWO: OriginRef[] = [
  { repo: REPO, issueId: 4204 },
  { repo: REPO, issueId: 4218 },
];
const FIVE: OriginRef[] = [4204, 4218, 4161, 3918, 3849].map((issueId) => ({
  repo: REPO,
  issueId,
}));

const FIXTURE_NOW = new Date("2026-09-14T00:00:00Z");

function mintArgs(origins: readonly OriginRef[], id?: string, now: Date = new Date()) {
  return {
    actor: "dbcall2",
    approvalRef: "operator 2026-09-14",
    rationale: "batch",
    origins,
    repo: REPO,
    id,
    now,
  };
}

describe("InProcessAppStore unique membership", () => {
  it("reserves the whole exact set in one transaction", () => {
    const store = new InProcessAppStore();
    const claim = store.mint(mintArgs(FIVE, "unit-five"));
    expect(claim.state).toBe("reserved");
    expect(claim.prNodeId).toBeNull();
    expect(claim.origins).toHaveLength(5);
    expect(store.membershipOf({ repo: REPO, issueId: 4161 })?.id).toBe("unit-five");
  });

  it("aborts overlapping concurrent mints via the before-reserve seam", () => {
    const store = new InProcessAppStore();
    let nested = false;
    store.onBeforeReserve = () => {
      if (nested) return;
      nested = true;
      expect(() => store.mint(mintArgs(TWO, "second"))).toThrow(OverlappingMintError);
    };
    const first = store.mint(mintArgs(TWO, "first"));
    expect(first.state).toBe("reserved");
    expect(store.getById("second")).toBeNull();
  });

  it("fails unique membership when any origin is already reserved", () => {
    const store = new InProcessAppStore();
    store.mint(mintArgs(TWO, "a"));
    expect(() =>
      store.mint(
        mintArgs(
          [
            { repo: REPO, issueId: 4218 },
            { repo: REPO, issueId: 1 },
          ],
          "b",
        ),
      ),
    ).toThrow(UniqueMembershipError);
  });

  it("binds irreversibly to a GitHub PR node id", () => {
    const store = new InProcessAppStore();
    store.mint(mintArgs(TWO, "unit"));
    const bound = store.bind("unit", "PR_kwDONode1");
    expect(bound.state).toBe("bound");
    expect(bound.prNodeId).toBe("PR_kwDONode1");
    expect(() => store.bind("unit", "PR_other")).toThrow(/different PR node id/);
    expect(store.getByPrNodeId("PR_kwDONode1")?.id).toBe("unit");
  });

  it("expires after 24 hours and releases membership", () => {
    const store = new InProcessAppStore();
    store.mint(mintArgs(TWO, "ttl", FIXTURE_NOW));
    const expired = store.expireDue(new Date("2026-09-15T00:00:01Z"));
    expect(expired[0]?.state).toBe("expired");
    expect(store.membershipOf(TWO[0] as OriginRef)).toBeNull();
  });

  it("only the minting operator may revoke", () => {
    const store = new InProcessAppStore();
    store.mint(mintArgs(TWO, "rev"));
    expect(() => store.revoke("rev", "agent")).toThrow(/minting operator/);
    expect(store.revoke("rev", "dbcall2").state).toBe("revoked");
  });

  it("unmerged PR revokes the bound claim", () => {
    const store = new InProcessAppStore();
    store.mint(mintArgs(TWO, "unmerged"));
    store.bind("unmerged", "PR_closed");
    expect(store.revokeUnmerged("PR_closed").state).toBe("revoked");
  });
});
