import { describe, expect, it } from "vitest";
import {
  buildAuthHashV1Preimage,
  computeAuthHashV1,
  effectiveApprovals,
  evaluateForgeHeadBriefApproval,
  type ForgeApprovalGit,
  type ForgeApprovalReader,
  type ForgeReview,
} from "./forge-approval.js";

const REPO = "acme/widgets";
const PR = 42;
const REL = "xbrief/active/story.xbrief.json";
const HEAD = "a".repeat(40);
const OLD = "b".repeat(40);

function brief(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    xBRIEFInfo: { version: "0.8" },
    plan: {
      id: "story-1",
      status: "running",
      acceptance: { clauses: [{ id: 1, text: "does the thing" }] },
      items: [{ id: "clause.1", status: "pending", narrative: { Acceptance: "it works" } }],
      metadata: {
        productPullRequest: 1,
        swarm: { file_scope: ["packages/core/src/a.ts", "packages/core/src/*.ts"] },
      },
      ...overrides,
    },
  };
}

interface FakeForge {
  pull?: unknown;
  reviews?: unknown[];
  briefs?: Record<string, string>;
  permissions?: Record<string, string>;
  fail?: Set<string>;
  calls: string[];
}

function reader(f: FakeForge): ForgeApprovalReader {
  return {
    getJson: (path) => {
      f.calls.push(path);
      if (f.fail?.has("json")) return { ok: false, detail: "HTTP 503" };
      if (path === `repos/${REPO}/pulls/${PR}`) {
        return { ok: true, value: f.pull };
      }
      if (path.startsWith(`repos/${REPO}/pulls/${PR}/reviews`)) {
        if (f.fail?.has("reviews")) return { ok: false, detail: "HTTP 502" };
        return { ok: true, value: f.reviews ?? [] };
      }
      const m = /collaborators\/([^/]+)\/permission$/.exec(path);
      if (m !== null) {
        const login = decodeURIComponent(m[1] ?? "");
        const perm = f.permissions?.[login];
        if (perm === undefined) return { ok: false, detail: "HTTP 404" };
        return { ok: true, value: { permission: perm } };
      }
      return { ok: false, detail: `unexpected ${path}` };
    },
    getRaw: (path) => {
      f.calls.push(path);
      const m = /\?ref=([0-9a-f]{40})$/.exec(path);
      const text = m !== null ? f.briefs?.[m[1] ?? ""] : undefined;
      return text === undefined ? { ok: false, detail: "HTTP 404" } : { ok: true, value: text };
    },
  };
}

function gitAt(head: string | null, parents: string[] = []): ForgeApprovalGit {
  return { headSha: () => head, headParents: () => parents };
}

function pull(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    number: PR,
    user: { login: "author", type: "User" },
    head: { sha: HEAD },
    base: { repo: { full_name: REPO } },
    ...overrides,
  };
}

function review(
  login: string,
  state: string,
  commitId: string = HEAD,
  type = "User",
): Record<string, unknown> {
  return { user: { login, type }, state, commit_id: commitId };
}

function forge(partial: Partial<FakeForge> = {}): FakeForge {
  return {
    pull: pull(),
    reviews: [review("alice", "APPROVED")],
    briefs: { [HEAD]: JSON.stringify(brief()) },
    permissions: { alice: "write" },
    calls: [],
    ...partial,
  };
}

function evaluate(f: FakeForge, git: ForgeApprovalGit = gitAt(HEAD), payload = brief()) {
  return evaluateForgeHeadBriefApproval({
    projectRoot: "/tmp/forge-proj",
    context: { prNumber: PR, repo: REPO, reader: reader(f), git },
    xbriefRelPath: REL,
    headPayload: payload,
  });
}

describe("auth-hash v1 (#6203 clause 2)", () => {
  it("ignores productPullRequest and other delivery metadata", () => {
    const a = computeAuthHashV1(brief(), REL);
    const stamped = brief();
    const plan = stamped.plan as Record<string, unknown>;
    const metadata = plan.metadata as Record<string, unknown>;
    metadata.productPullRequest = 999;
    metadata.deliveryDisposition = "shipped";
    plan.status = "completed";
    plan.updated = "2026-11-12T00:00:00Z";
    expect(computeAuthHashV1(stamped, REL)).toBe(a);
  });

  it("changes when plan.id, path, file_scope or acceptance change", () => {
    const a = computeAuthHashV1(brief(), REL);
    expect(a).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(computeAuthHashV1(brief({ id: "story-2" }), REL)).not.toBe(a);
    expect(computeAuthHashV1(brief(), "xbrief/active/other.xbrief.json")).not.toBe(a);
    expect(
      computeAuthHashV1(
        brief({ metadata: { swarm: { file_scope: ["packages/core/src/b.ts"] } } }),
        REL,
      ),
    ).not.toBe(a);
    expect(computeAuthHashV1(brief({ acceptance: { clauses: [] } }), REL)).not.toBe(a);
    expect(
      computeAuthHashV1(
        brief({ items: [{ id: "clause.1", narrative: { Acceptance: "x" } }] }),
        REL,
      ),
    ).not.toBe(a);
    expect(
      computeAuthHashV1(brief({ narratives: { AcceptanceCriteria: "- new line" } }), REL),
    ).not.toBe(a);
  });

  it("hashes concrete file_scope only and returns null without plan.id", () => {
    const pre = buildAuthHashV1Preimage(brief(), REL);
    expect(pre?.fileScope).toEqual(["packages/core/src/a.ts"]);
    expect(computeAuthHashV1(brief({ id: undefined }), REL)).toBeNull();
  });
});

describe("effectiveApprovals", () => {
  const r = (login: string, state: string): ForgeReview => ({
    login,
    userType: "User",
    state,
    commitId: HEAD,
  });

  it("lets a later COMMENTED review keep an approval", () => {
    expect(effectiveApprovals([r("a", "APPROVED"), r("a", "COMMENTED")])).toHaveLength(1);
  });

  it("drops withdrawn approvals (later CHANGES_REQUESTED or DISMISSED)", () => {
    expect(effectiveApprovals([r("a", "APPROVED"), r("a", "CHANGES_REQUESTED")])).toEqual([]);
    expect(effectiveApprovals([r("a", "DISMISSED")])).toEqual([]);
  });
});

describe("evaluateForgeHeadBriefApproval (#6203 clause 3)", () => {
  it("admits an effective APPROVED review by a non-author User with write on head", () => {
    const verdict = evaluate(forge());
    expect(verdict).toMatchObject({ kind: "admit", approver: "alice", commitId: HEAD });
  });

  it("admits an earlier-commit approval whose brief hashes the same as head", () => {
    const stampedLater = brief();
    const f = forge({
      reviews: [review("alice", "APPROVED", OLD)],
      briefs: {
        [HEAD]: JSON.stringify(stampedLater),
        [OLD]: JSON.stringify(
          brief({
            metadata: {
              productPullRequest: 0,
              swarm: { file_scope: ["packages/core/src/a.ts", "packages/core/src/*.ts"] },
            },
          }),
        ),
      },
    });
    expect(evaluate(f).kind).toBe("admit");
  });

  it("admits on GitHub's synthetic merge commit whose second parent is the PR head", () => {
    const verdict = evaluate(forge(), gitAt("c".repeat(40), ["d".repeat(40), HEAD]));
    expect(verdict.kind).toBe("admit");
  });

  it("rejects Bot and App reviewers", () => {
    const bot = evaluate(
      forge({ reviews: [review("ci[bot]", "APPROVED", HEAD, "Bot")], permissions: {} }),
    );
    expect(bot).toMatchObject({ kind: "reject" });
    expect(bot.kind === "reject" && bot.reason).toMatch(/not a User/);
  });

  it("rejects the PR author's own approval", () => {
    const v = evaluate(forge({ reviews: [review("Author", "APPROVED")] }));
    expect(v.kind === "reject" && v.reason).toMatch(/PR author/);
  });

  it("rejects a withdrawn approval", () => {
    const v = evaluate(
      forge({ reviews: [review("alice", "APPROVED"), review("alice", "CHANGES_REQUESTED")] }),
    );
    expect(v.kind === "reject" && v.reason).toMatch(/no currently effective APPROVED/);
  });

  it("rejects an approval whose reviewed brief hash differs (file_scope widened after)", () => {
    const f = forge({
      reviews: [review("alice", "APPROVED", OLD)],
      briefs: {
        [HEAD]: JSON.stringify(brief()),
        [OLD]: JSON.stringify(brief({ metadata: { swarm: { file_scope: ["x.ts"] } } })),
      },
    });
    const v = evaluate(f);
    expect(v.kind === "reject" && v.reason).toMatch(/auth-hash mismatch/);
  });

  it("rejects a reviewer without repo write", () => {
    const v = evaluate(forge({ permissions: { alice: "read" } }));
    expect(v.kind === "reject" && v.reason).toMatch(/no repo write/);
  });

  it("rejects when the evaluated HEAD is not the PR head", () => {
    const v = evaluate(forge(), gitAt("e".repeat(40), ["f".repeat(40)]));
    expect(v.kind === "reject" && v.reason).toMatch(/not the PR head/);
  });

  it("rejects when the evaluated brief differs from the PR head brief", () => {
    const v = evaluate(forge(), gitAt(HEAD), brief({ id: "story-other" }));
    expect(v.kind === "reject" && v.reason).toMatch(/differs from the PR head/);
  });

  it("rejects a PR whose base repo is another repository", () => {
    const v = evaluate(forge({ pull: pull({ base: { repo: { full_name: "evil/fork" } } }) }));
    expect(v.kind === "reject" && v.reason).toMatch(/base repo/);
  });
});

describe("evaluateForgeHeadBriefApproval unavailable forge (#6203 clause 4)", () => {
  it("rejects without throwing when the forge is unavailable", () => {
    expect(evaluate(forge({ fail: new Set(["json"]) })).kind).toBe("reject");
    expect(evaluate(forge({ fail: new Set(["reviews"]) })).kind).toBe("reject");
  });

  it("rejects without throwing when the reader throws", () => {
    const throwing: ForgeApprovalReader = {
      getJson: () => {
        throw new Error("boom");
      },
      getRaw: () => {
        throw new Error("boom");
      },
    };
    const v = evaluateForgeHeadBriefApproval({
      projectRoot: "/tmp/forge-proj",
      context: { prNumber: PR, repo: REPO, reader: throwing, git: gitAt(HEAD) },
      xbriefRelPath: REL,
      headPayload: brief(),
    });
    expect(v.kind === "reject" && v.reason).toMatch(/unavailable: boom/);
  });

  it("rejects a non-positive PR number and a bad repo slug before any call", () => {
    const f = forge();
    const bad = evaluateForgeHeadBriefApproval({
      projectRoot: "/tmp/forge-proj",
      context: { prNumber: 0, repo: REPO, reader: reader(f), git: gitAt(HEAD) },
      xbriefRelPath: REL,
      headPayload: brief(),
    });
    expect(bad.kind).toBe("reject");
    const slug = evaluateForgeHeadBriefApproval({
      projectRoot: "/tmp/forge-proj",
      context: { prNumber: PR, repo: "not a slug", reader: reader(f), git: gitAt(HEAD) },
      xbriefRelPath: REL,
      headPayload: brief(),
    });
    expect(slug.kind).toBe("reject");
    expect(f.calls).toEqual([]);
  });
});
