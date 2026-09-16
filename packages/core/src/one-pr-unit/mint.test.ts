import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { mintOnePrUnitGrant } from "./mint.js";
import { InProcessAppStore } from "./simulator.js";
import { DirectiveGitHubAppStore } from "./store.js";

describe("mintOnePrUnitGrant", () => {
  it("refuses a single origin", () => {
    const store = new InProcessAppStore();
    expect(() =>
      mintOnePrUnitGrant({
        store,
        actor: "dbcall2",
        approvalRef: "ref",
        rationale: "why",
        origins: [{ repo: "o/r", issueId: 1 }],
        repo: "o/r",
      }),
    ).toThrow(/at least two origins/);
  });

  it("mints reserved and unbound", () => {
    const store = new InProcessAppStore();
    const claim = mintOnePrUnitGrant({
      store,
      actor: "dbcall2",
      approvalRef: "ref",
      rationale: "why",
      origins: [
        { repo: "o/r", issueId: 1 },
        { repo: "o/r", issueId: 2 },
      ],
      repo: "o/r",
    });
    expect(claim.state).toBe("reserved");
    expect(claim.prNodeId).toBeNull();
  });

  it("writes a store a later process can read when DEFT_ONE_PR_UNIT_APP is a path", () => {
    const dir = mkdtempSync(join(tmpdir(), "opu-mint-"));
    const prev = process.env.DEFT_ONE_PR_UNIT_APP;
    process.env.DEFT_ONE_PR_UNIT_APP = dir;
    try {
      const claim = mintOnePrUnitGrant({
        actor: "dbcall2",
        approvalRef: "ref",
        rationale: "why",
        origins: [
          { repo: "o/r", issueId: 1 },
          { repo: "o/r", issueId: 2 },
        ],
        repo: "o/r",
        id: "unit-persist",
      });
      expect(claim.state).toBe("reserved");
      const later = new DirectiveGitHubAppStore(dir);
      expect(later).not.toBeInstanceOf(InProcessAppStore);
      expect(later.getById("unit-persist")?.id).toBe("unit-persist");
    } finally {
      if (prev === undefined) delete process.env.DEFT_ONE_PR_UNIT_APP;
      else process.env.DEFT_ONE_PR_UNIT_APP = prev;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
