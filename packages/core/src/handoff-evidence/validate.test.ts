import { describe, expect, it } from "vitest";
import {
  canClaimPass,
  detectRemoteClaims,
  type HandoffEvidence,
  validateHandoffEvidence,
} from "./validate.js";

const boundPrProbe = {
  command: "gh api repos/deftai/directive/pulls/3120",
  snippet:
    '{"number":3120,"html_url":"https://github.com/deftai/directive/pull/3120","head":{"sha":"abc1234deadbeef"}}',
};

const boundShaProbe = {
  command: "git rev-parse HEAD",
  snippet: "abc1234deadbeef0000000000000000000000000",
};

const boundCiProbe = {
  command: "gh api repos/deftai/directive/commits/abc1234/status",
  snippet: '{"state":"success"}',
};

const boundReviewProbe = {
  command: "task pr:watch -- 3120 --one-shot",
  snippet: "CLEAN confidence=5 HEAD=abc1234",
};

describe("detectRemoteClaims", () => {
  it("returns empty when no remote fields are set", () => {
    expect(detectRemoteClaims({ status: "pass" })).toEqual([]);
  });

  it("detects PR, SHA, green CI, and review score", () => {
    const claims = detectRemoteClaims({
      status: "pass",
      pr_url: "https://github.com/o/r/pull/1",
      pr_number: 1,
      head_sha: "abc",
      ci_status: "green",
      review_score: 5,
    });
    expect(claims).toEqual(
      expect.arrayContaining(["pr_url", "pr_number", "head_sha", "ci_status", "review_score"]),
    );
  });

  it("does not treat pending/unknown CI as a remote claim", () => {
    expect(detectRemoteClaims({ status: "partial", ci_status: "pending" })).toEqual([]);
    expect(detectRemoteClaims({ status: "partial", ci_status: "unknown" })).toEqual([]);
  });
});

describe("validateHandoffEvidence — invented-done", () => {
  it("fails status pass with PR URL and no proof_status / probes as invented-done", () => {
    const evidence: HandoffEvidence = {
      status: "pass",
      pr_url: "https://github.com/deftai/directive/pull/99999",
      pr_number: 99999,
      head_sha: "ffffffffffffffffffffffffffffffffffffffff",
      ci_status: "green",
      review_score: 5,
      work: { state: "done" },
      ship: { state: "done" },
      gate: { state: "done" },
    };
    const result = validateHandoffEvidence(evidence);
    expect(result.ok).toBe(false);
    expect(result.failClass).toBe("invented-done");
    expect(result.hasRemoteClaims).toBe(true);
    expect(result.reasons.join(" ")).toMatch(/invented-done/i);
    expect(result.reasons.join(" ")).toMatch(/proof_status=bound/);
  });

  it("fails when proof_status is unbound under pass with remote claims", () => {
    const result = validateHandoffEvidence({
      status: "pass",
      proof_status: "unbound",
      pr_number: 42,
      work: { state: "done" },
      ship: { state: "done" },
    });
    expect(result.ok).toBe(false);
    expect(result.failClass).toBe("invented-done");
  });

  it("fails when proof_status is bound but probe snippets are missing", () => {
    const result = validateHandoffEvidence({
      status: "pass",
      proof_status: "bound",
      pr_number: 42,
      head_sha: "abc1234deadbeef",
      work: { state: "done" },
      ship: { state: "done" },
      probes: {
        pr: { command: "gh api ...", snippet: "" },
        sha: { command: "", snippet: "abc1234deadbeef" },
      },
    });
    expect(result.ok).toBe(false);
    expect(result.failClass).toBe("invented-done");
    expect(result.unboundClaims.length).toBeGreaterThan(0);
  });

  it("fails when probes are non-empty but do not mention the claimed values", () => {
    const result = validateHandoffEvidence({
      status: "pass",
      proof_status: "bound",
      pr_number: 99999,
      head_sha: "ffffffffffffffffffffffffffffffffffffffff",
      work: { state: "done" },
      ship: { state: "done" },
      probes: {
        pr: { command: "gh api ...", snippet: '{"number":1,"ok":true}' },
        sha: { command: "git rev-parse HEAD", snippet: "abc1234deadbeef0000000000000000000000000" },
      },
    });
    expect(result.ok).toBe(false);
    expect(result.failClass).toBe("invented-done");
    expect(result.unboundClaims).toEqual(expect.arrayContaining(["pr_number", "head_sha"]));
  });

  it("rejects substring collisions (PR 12 in 3120, score 5 in 15s, mixed CI)", () => {
    expect(
      validateHandoffEvidence({
        status: "pass",
        proof_status: "bound",
        pr_number: 12,
        work: { state: "done" },
        ship: { state: "done" },
        probes: { pr: { command: "gh api", snippet: '{"number":3120}' } },
      }).unboundClaims,
    ).toContain("pr_number");

    expect(
      validateHandoffEvidence({
        status: "pass",
        proof_status: "bound",
        review_score: 5,
        work: { state: "done" },
        ship: { state: "done" },
        probes: { review: { command: "task pr:watch", snippet: "elapsed=15s confidence=3" } },
      }).unboundClaims,
    ).toContain("review_score");

    expect(
      validateHandoffEvidence({
        status: "pass",
        proof_status: "bound",
        ci_status: "green",
        work: { state: "done" },
        ship: { state: "done" },
        probes: {
          ci: {
            command: "gh api status",
            snippet: '{"state":"success","checks":[{"state":"failure"}]}',
          },
        },
      }).unboundClaims,
    ).toContain("ci_status");
  });

  it("never throws on malformed SHA in cross-claim checks", () => {
    expect(() =>
      validateHandoffEvidence({
        status: "pass",
        proof_status: "bound",
        pr_number: 3120,
        head_sha: "((((((",
        work: { state: "done" },
        ship: { state: "done" },
        probes: {
          pr: boundPrProbe,
          sha: { command: "git rev-parse HEAD", snippet: "(((((( not hex" },
        },
      }),
    ).not.toThrow();
  });

  it("rejects PR+SHA binds that do not co-appear in the PR probe", () => {
    const result = validateHandoffEvidence({
      status: "pass",
      proof_status: "bound",
      pr_number: 3120,
      head_sha: "abc1234deadbeef0000000000000000000000000",
      work: { state: "done" },
      ship: { state: "done" },
      probes: {
        pr: {
          command: "gh api repos/deftai/directive/pulls/3120",
          snippet: '{"number":3120,"html_url":"https://github.com/deftai/directive/pull/3120"}',
        },
        sha: boundShaProbe,
      },
    });
    expect(result.ok).toBe(false);
    expect(result.unboundClaims.length).toBeGreaterThan(0);
  });

  it("rejects non-toolish or trivial probe commands/snippets", () => {
    expect(
      validateHandoffEvidence({
        status: "pass",
        proof_status: "bound",
        pr_number: 3120,
        work: { state: "done" },
        ship: { state: "done" },
        probes: { pr: { command: "I checked the PR", snippet: "number 3120 is fine" } },
      }).unboundClaims,
    ).toContain("pr_number");
  });

  it("rejects review_score bound only via unrelated numeric fields (p0=5)", () => {
    expect(
      validateHandoffEvidence({
        status: "pass",
        proof_status: "bound",
        review_score: 5,
        work: { state: "done" },
        ship: { state: "done" },
        probes: {
          review: { command: "task pr:watch", snippet: "confidence=3 p0=5 elapsed=15s" },
        },
      }).unboundClaims,
    ).toContain("review_score");
  });

  it("rejects cross-repo PR URL binds and never throws on regex metachar claims", () => {
    expect(
      validateHandoffEvidence({
        status: "pass",
        proof_status: "bound",
        pr_url: "https://github.com/deftai/directive/pull/3120",
        work: { state: "done" },
        ship: { state: "done" },
        probes: {
          pr: {
            command: "gh api",
            snippet: "https://github.com/otherorg/otherrepo/pull/3120 number=3120",
          },
        },
      }).unboundClaims,
    ).toContain("pr_url");

    expect(() =>
      validateHandoffEvidence({
        status: "pass",
        proof_status: "bound",
        pr_number: "(",
        review_score: ".*",
        work: { state: "done" },
        ship: { state: "done" },
        probes: {
          pr: { command: "x", snippet: "junk (" },
          review: { command: "y", snippet: "junk .*" },
        },
      }),
    ).not.toThrow();
  });

  it("fails n/a-no-remote-claim when remote claims are present under pass", () => {
    const result = validateHandoffEvidence({
      status: "pass",
      proof_status: "n/a-no-remote-claim",
      pr_url: "https://example.com/pr/1",
      work: { state: "done" },
    });
    expect(result.ok).toBe(false);
    expect(result.failClass).toBe("invented-done");
  });
});

describe("validateHandoffEvidence — enum shape", () => {
  it("rejects unsupported proof_status and axis state strings", () => {
    const result = validateHandoffEvidence({
      status: "pass",
      proof_status: "verified",
      work: { state: "almost_done" },
      ship: { state: "done" },
      gate: { state: "n/a" },
    });
    expect(result.ok).toBe(false);
    expect(result.failClass).toBe("shape-error");
    expect(result.reasons.join(" ")).toMatch(/proof_status/);
    expect(result.reasons.join(" ")).toMatch(/work\.state/);
  });

  it("rejects unsupported status tokens", () => {
    const result = validateHandoffEvidence({
      status: "success",
      proof_status: "n/a-no-remote-claim",
      work: { state: "done" },
    });
    expect(result.ok).toBe(false);
    expect(result.failClass).toBe("shape-error");
    expect(result.reasons.join(" ")).toMatch(/status must be one of/);
  });
});

describe("validateHandoffEvidence — empty-done", () => {
  it("fails status pass with no axes and no remote claims as empty-done", () => {
    const result = validateHandoffEvidence({
      status: "pass",
      proof_status: "n/a-no-remote-claim",
    });
    expect(result.ok).toBe(false);
    expect(result.failClass).toBe("empty-done");
    expect(result.hasRemoteClaims).toBe(false);
  });

  it("ranks invented-done stricter than empty-done when both shapes apply", () => {
    // Remote claims under pass without binding wins invented-done even if axes empty.
    const result = validateHandoffEvidence({
      status: "pass",
      pr_number: 1,
    });
    expect(result.failClass).toBe("invented-done");
    expect(result.failClass).not.toBe("empty-done");
  });
});

describe("validateHandoffEvidence — bound pass and legal partial", () => {
  it("accepts status pass with bound proof and probes for each remote claim", () => {
    const evidence: HandoffEvidence = {
      status: "pass",
      proof_status: "bound",
      work: { state: "done" },
      ship: { state: "done" },
      gate: { state: "done" },
      pr_url: "https://github.com/deftai/directive/pull/3120",
      pr_number: 3120,
      head_sha: "abc1234deadbeef0000000000000000000000000",
      ci_status: "green",
      review_score: 5,
      probes: {
        pr: boundPrProbe,
        sha: boundShaProbe,
        ci: boundCiProbe,
        review: boundReviewProbe,
      },
    };
    const result = validateHandoffEvidence(evidence);
    expect(result.ok).toBe(true);
    expect(result.failClass).toBe("none");
    expect(result.unboundClaims).toEqual([]);
  });

  it("accepts legal partial: local work done + ship not_started without PR fields", () => {
    const result = validateHandoffEvidence({
      status: "partial",
      proof_status: "n/a-no-remote-claim",
      work: { state: "done" },
      ship: { state: "not_started" },
      gate: { state: "not_started" },
    });
    expect(result.ok).toBe(true);
    expect(result.failClass).toBe("none");
    expect(result.hasRemoteClaims).toBe(false);
  });

  it("accepts local-only pass with n/a-no-remote-claim and work done", () => {
    const result = validateHandoffEvidence({
      status: "pass",
      proof_status: "n/a-no-remote-claim",
      work: { state: "done" },
      ship: { state: "n/a" },
      gate: { state: "n/a" },
    });
    expect(result.ok).toBe(true);
    expect(result.failClass).toBe("none");
  });

  it("marks non-pass unbound remote claims as unbound-remote-claim (not invented-done)", () => {
    const result = validateHandoffEvidence({
      status: "blocked",
      proof_status: "unbound",
      pr_number: 7,
      work: { state: "done" },
      ship: { state: "in_progress" },
    });
    expect(result.ok).toBe(false);
    expect(result.failClass).toBe("unbound-remote-claim");
  });
});

describe("canClaimPass", () => {
  it("returns false for invented remote PR without probes", () => {
    expect(
      canClaimPass({
        status: "partial",
        pr_number: 1,
      }),
    ).toBe(false);
  });

  it("returns true for bound evidence", () => {
    expect(
      canClaimPass({
        status: "blocked",
        proof_status: "bound",
        work: { state: "done" },
        ship: { state: "done" },
        gate: { state: "done" },
        pr_number: 3120,
        head_sha: "abc1234deadbeef0000000000000000000000000",
        probes: {
          pr: boundPrProbe,
          sha: boundShaProbe,
        },
      }),
    ).toBe(true);
  });
});
