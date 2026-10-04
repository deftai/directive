import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { GitRunner } from "../session/git.js";
import {
  classifyStoredDeliveryDisposition,
  defaultFetchClosingIssueIds,
  defaultFetchPrPayload,
  evaluateDeliveryGate,
  type FetchClosingIssueIdsFn,
  type FetchPrPayloadFn,
  isCodeBearingScope,
  NON_DELIVERY_DISPOSITIONS,
  resolveCompletionSessionId,
  resolvePlanGithubIssueRef,
  verifyStoryPrMergeIdentity,
} from "./delivery-evidence.js";
import { runTransition } from "./transition.js";

function makeRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "delivery-ev-"));
  for (const folder of ["proposed", "pending", "active", "completed", "cancelled"]) {
    mkdirSync(join(root, "xbrief", folder), { recursive: true });
  }
  writeFileSync(
    join(root, "xbrief", "PROJECT-DEFINITION.xbrief.json"),
    JSON.stringify({
      plan: {
        title: "P",
        status: "running",
        policy: { deliveryBranch: "master", wipCap: 20 },
      },
    }),
    "utf8",
  );
  return root;
}

function writeCodeBearing(root: string, name = "story.xbrief.json"): string {
  const path = join(root, "xbrief", "active", name);
  writeFileSync(
    path,
    JSON.stringify({
      xBRIEFInfo: { version: "0.8" },
      plan: {
        title: "code story",
        status: "running",
        references: [
          {
            uri: "https://github.com/deftai/directive/issues/3041",
            type: "x-xbrief/github-issue",
          },
        ],
        metadata: {
          kind: "story",
          swarm: { file_scope: ["packages/core/src/scope/transition.ts"] },
        },
        // Empty items: delivery gate isolation; acceptance evidence is #3240.
        items: [],
      },
    }),
    "utf8",
  );
  return path;
}

function gitOk(opts?: { fetchFail?: boolean; notAncestor?: boolean; tip?: string }): GitRunner {
  return (_root, args) => {
    const joined = args.join(" ");
    if (joined.startsWith("fetch ") && opts?.fetchFail) {
      return { code: 1, stdout: "", stderr: "could not resolve host" };
    }
    if (joined.includes("merge-base") && joined.includes("--is-ancestor")) {
      return { code: opts?.notAncestor ? 1 : 0, stdout: "", stderr: "" };
    }
    if (joined.includes("rev-parse") && joined.includes("origin/")) {
      return { code: 0, stdout: opts?.tip ?? "deliverytipsha", stderr: "" };
    }
    if (joined.includes("symbolic-ref")) {
      return { code: 0, stdout: "origin/master", stderr: "" };
    }
    if (joined.includes("show-ref")) {
      return { code: 0, stdout: "", stderr: "" };
    }
    return { code: 0, stdout: "ok", stderr: "" };
  };
}

/** Prefer-A identity fixtures for writeCodeBearing issue #3041 (#3675). */
function identityOk(opts?: {
  prNumber?: number;
  issueNumber?: number;
  repository?: string;
  mergeCommitSha?: string;
  mergedAt?: string | null;
  headSha?: string;
  prBase?: string;
  closingIssues?: number[] | null;
  /** When set, overrides closingIssues with full refs (cross-repo tests). */
  closingIssueRefs?: { repository: string; issueNumber: number }[] | null;
  lookupFail?: boolean;
  closingLookupFail?: boolean;
}): { fetchPrPayload: FetchPrPayloadFn; fetchClosingIssueIds: FetchClosingIssueIdsFn } {
  const prNumber = opts?.prNumber ?? 42;
  const issueNumber = opts?.issueNumber ?? 3041;
  const repository = opts?.repository ?? "deftai/directive";
  const mergeCommitSha = opts?.mergeCommitSha ?? "mergecommitsha";
  const headSha = opts?.headSha ?? "implementationhead";
  const prBase = opts?.prBase ?? "master";
  const mergedAt = opts?.mergedAt === undefined ? "2026-08-02T11:00:00Z" : opts.mergedAt;
  const closingIssues = opts?.closingIssues === undefined ? [issueNumber] : opts.closingIssues;

  const fetchPrPayload: FetchPrPayloadFn = (n, repo) => {
    if (opts?.lookupFail) return null;
    if (n !== prNumber || repo !== repository) return null;
    return {
      merged_at: mergedAt,
      merge_commit_sha: mergeCommitSha,
      base: { ref: prBase },
      head: { sha: headSha },
    };
  };
  const fetchClosingIssueIds: FetchClosingIssueIdsFn = (n, repo) => {
    if (opts?.closingLookupFail) return null;
    if (n !== prNumber || repo !== repository) return null;
    if (opts?.closingIssueRefs !== undefined) {
      return opts.closingIssueRefs;
    }
    if (closingIssues === null) {
      return null;
    }
    return closingIssues.map((issue) => ({ repository, issueNumber: issue }));
  };
  return { fetchPrPayload, fetchClosingIssueIds };
}

function gitInit(cwd: string): void {
  execFileSync("git", ["init"], { cwd, encoding: "utf8" });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd, encoding: "utf8" });
  execFileSync("git", ["config", "user.name", "test"], { cwd, encoding: "utf8" });
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

describe("delivery evidence (#3041)", () => {
  let root = "";
  afterEach(() => {
    if (root.length > 0) {
      rmSync(root, { recursive: true, force: true });
      root = "";
    }
  });

  it("classifies code-bearing scopes via issue ref / file_scope", () => {
    expect(
      isCodeBearingScope({
        references: [{ type: "x-xbrief/github-issue", uri: "https://github.com/o/r/issues/1" }],
      }),
    ).toBe(true);
    expect(
      isCodeBearingScope({
        metadata: { swarm: { file_scope: ["a.ts"] } },
      }),
    ).toBe(true);
    expect(isCodeBearingScope({ title: "minimal" })).toBe(false);
    expect(
      isCodeBearingScope({
        tags: ["docs-only"],
        references: [{ type: "x-xbrief/github-issue", uri: "https://github.com/o/r/issues/1" }],
      }),
    ).toBe(false);
  });

  it("legacy completed records without provenance are unverified", () => {
    expect(
      classifyStoredDeliveryDisposition({ metadata: { completedAt: "2026-01-01T00:00:00Z" } }),
    ).toBe("unverified");
    expect(classifyStoredDeliveryDisposition({})).toBe("unknown");
    expect(
      classifyStoredDeliveryDisposition({
        metadata: {
          completionProvenance: { disposition: "delivered", handoffState: "delivered" },
        },
      }),
    ).toBe("delivered");
  });

  it("fails closed on code-bearing complete without evidence", () => {
    root = makeRepo();
    const file = writeCodeBearing(root);
    const result = runTransition("complete", file, new Date(), { runGit: gitOk() });
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/Delivery evidence required|#3041/);
    expect(result.message).toMatch(/--merge-commit/);
    expect(result.message).toMatch(/policy:show --field=deliveryBranch/);
    expect(result.message).toMatch(/Do not use --non-delivery for work that shipped/);
    expect(readFileSync(file, "utf8")).toContain("running");
  });

  it("accepts explicit non-delivery disposition", () => {
    root = makeRepo();
    const file = writeCodeBearing(root);
    const result = runTransition("complete", file, new Date("2026-08-02T12:00:00Z"), {
      nonDeliveryDisposition: "accepted_not_delivered",
      runGit: gitOk(),
    });
    expect(result.ok).toBe(true);
    const dest = join(root, "xbrief", "completed", "story.xbrief.json");
    const data = JSON.parse(readFileSync(dest, "utf8")) as {
      plan: {
        metadata: {
          completionProvenance: { disposition: string; handoffState: string; deployed: null };
        };
      };
    };
    expect(data.plan.metadata.completionProvenance.disposition).toBe("accepted_not_delivered");
    expect(data.plan.metadata.completionProvenance.deployed).toBeNull();
    expect(NON_DELIVERY_DISPOSITIONS).toContain("accepted_not_delivered");
  });

  it("accepts direct delivery merge with ancestry", () => {
    root = makeRepo();
    const file = writeCodeBearing(root);
    const identity = identityOk();
    const result = runTransition("complete", file, new Date("2026-08-02T12:00:00Z"), {
      runGit: gitOk(),
      ...identity,
      deliveryEvidence: {
        repository: "deftai/directive",
        prNumber: 42,
        prBase: "master",
        mergeCommit: "mergecommitsha",
        mergedAt: "2026-08-02T11:00:00Z",
        deliveryBranch: "master",
      },
    });
    expect(result.ok).toBe(true);
    const dest = join(root, "xbrief", "completed", "story.xbrief.json");
    const data = JSON.parse(readFileSync(dest, "utf8")) as {
      plan: {
        metadata: {
          completionProvenance: {
            disposition: string;
            handoffState: string;
            mergeCommit: string;
            deliveryBranch: string;
            uatVerified: null;
          };
        };
      };
    };
    expect(data.plan.metadata.completionProvenance.disposition).toBe("delivered");
    expect(data.plan.metadata.completionProvenance.handoffState).toBe("delivered");
    expect(data.plan.metadata.completionProvenance.mergeCommit).toBe("mergecommitsha");
    expect(data.plan.metadata.completionProvenance.deliveryBranch).toBe("master");
    expect(data.plan.metadata.completionProvenance.uatVerified).toBeNull();
  });

  it("treats intermediate-branch PR base as delivered when ancestry passes (#3380)", () => {
    root = makeRepo();
    const file = writeCodeBearing(root);
    const identity = identityOk({
      prNumber: 7,
      mergeCommitSha: "abc",
      prBase: "feature/integration",
    });
    const result = runTransition("complete", file, new Date("2026-08-02T12:00:00Z"), {
      runGit: gitOk(),
      ...identity,
      deliveryEvidence: {
        prNumber: 7,
        prBase: "feature/integration",
        mergeCommit: "abc",
        mergedAt: "2026-08-02T11:00:00Z",
        deliveryBranch: "master",
      },
    });
    expect(result.ok).toBe(true);
    const dest = join(root, "xbrief", "completed", "story.xbrief.json");
    const data = JSON.parse(readFileSync(dest, "utf8")) as {
      plan: {
        metadata: {
          completionProvenance: {
            disposition: string;
            handoffState: string;
            prBase: string;
          };
        };
      };
    };
    expect(data.plan.metadata.completionProvenance.disposition).toBe("delivered");
    expect(data.plan.metadata.completionProvenance.handoffState).toBe("delivered");
    expect(data.plan.metadata.completionProvenance.prBase).toBe("feature/integration");
  });

  it("records merged_to_integration when intermediate PR base fails ancestry (#3380)", () => {
    root = makeRepo();
    const identity = identityOk({
      repository: "o/r",
      issueNumber: 1,
      prNumber: 7,
      mergeCommitSha: "abc",
      prBase: "develop",
    });
    const gate = evaluateDeliveryGate({
      projectRoot: root,
      plan: {
        references: [{ type: "x-xbrief/github-issue", uri: "https://github.com/o/r/issues/1" }],
      },
      nowIso: "2026-08-02T12:00:00Z",
      evidence: {
        prNumber: 7,
        prBase: "develop",
        mergeCommit: "abc",
        mergedAt: "2026-08-02T11:00:00Z",
        deliveryBranch: "master",
      },
      ...identity,
      runGit: gitOk({ notAncestor: true }),
    });
    expect(gate.ok).toBe(false);
    expect(gate.provenance?.disposition).toBe("merged_to_integration");
    expect(gate.provenance?.handoffState).toBe("merged_to_integration");
    expect(gate.provenance?.prBase).toBe("develop");
    expect(gate.message).toMatch(/--merge-commit/);
    expect(gate.message).toMatch(/policy:show --field=deliveryBranch/);
    expect(gate.message).not.toMatch(/never shipped|did not ship|work never/i);
  });

  it("rejects when remote refresh fails", () => {
    root = makeRepo();
    const identity = identityOk({
      repository: "o/r",
      issueNumber: 1,
      prNumber: 9,
      mergeCommitSha: "abc",
    });
    const gate = evaluateDeliveryGate({
      projectRoot: root,
      plan: {
        references: [{ type: "x-xbrief/github-issue", uri: "https://github.com/o/r/issues/1" }],
      },
      nowIso: "2026-08-02T12:00:00Z",
      evidence: {
        prNumber: 9,
        prBase: "master",
        mergeCommit: "abc",
        mergedAt: "2026-08-02T11:00:00Z",
        deliveryBranch: "master",
      },
      ...identity,
      runGit: gitOk({ fetchFail: true }),
    });
    expect(gate.ok).toBe(false);
    expect(gate.message).toMatch(/fetch|resolve host|failed/i);
  });

  it("rejects when merge commit is not an ancestor of delivery ref", () => {
    root = makeRepo();
    const identity = identityOk({
      repository: "o/r",
      issueNumber: 1,
      prNumber: 9,
      mergeCommitSha: "stranded",
    });
    const gate = evaluateDeliveryGate({
      projectRoot: root,
      plan: {
        references: [{ type: "x-xbrief/github-issue", uri: "https://github.com/o/r/issues/1" }],
      },
      nowIso: "2026-08-02T12:00:00Z",
      evidence: {
        prNumber: 9,
        prBase: "master",
        mergeCommit: "stranded",
        mergedAt: "2026-08-02T11:00:00Z",
        deliveryBranch: "master",
      },
      ...identity,
      runGit: gitOk({ notAncestor: true }),
    });
    expect(gate.ok).toBe(false);
    expect(gate.message).toMatch(/not an ancestor|delivery/i);
    expect(gate.message).toMatch(/--merge-commit/);
    expect(gate.provenance?.disposition).toBe("not_delivered");
  });

  it("resolveCompletionSessionId prefers DEFT_SESSION_ID then ritual-state (#3357)", () => {
    root = makeRepo();
    expect(resolveCompletionSessionId(root, { DEFT_SESSION_ID: "env-sess" })).toBe("env-sess");
    expect(resolveCompletionSessionId(root, {})).toBeNull();
  });

  it("stamps completedSessionId onto metadata on complete (#3357)", () => {
    root = makeRepo();
    const path = join(root, "xbrief", "active", "docs.xbrief.json");
    writeFileSync(
      path,
      JSON.stringify({
        xBRIEFInfo: { version: "0.8" },
        plan: { title: "docs", status: "running", items: [] },
      }),
      "utf8",
    );
    const prev = process.env.DEFT_SESSION_ID;
    process.env.DEFT_SESSION_ID = "stamp-sess-3357";
    try {
      const result = runTransition("complete", path);
      expect(result.ok).toBe(true);
      const dest = join(root, "xbrief", "completed", "docs.xbrief.json");
      const data = JSON.parse(readFileSync(dest, "utf8")) as {
        plan: { metadata: { completedSessionId?: string } };
      };
      expect(data.plan.metadata.completedSessionId).toBe("stamp-sess-3357");
    } finally {
      if (prev === undefined) {
        delete process.env.DEFT_SESSION_ID;
      } else {
        process.env.DEFT_SESSION_ID = prev;
      }
    }
  });

  it("allows non-code-bearing complete without evidence", () => {
    root = makeRepo();
    const path = join(root, "xbrief", "active", "docs.xbrief.json");
    writeFileSync(
      path,
      JSON.stringify({
        xBRIEFInfo: { version: "0.8" },
        plan: { title: "docs", status: "running", items: [] },
      }),
      "utf8",
    );
    const result = runTransition("complete", path);
    expect(result.ok).toBe(true);
  });

  it("honors delivery.required and kind/process-only carve-outs", () => {
    expect(
      isCodeBearingScope({
        metadata: { delivery: { required: true } },
      }),
    ).toBe(true);
    expect(
      isCodeBearingScope({
        metadata: { delivery: { required: false }, kind: "story" },
        references: [{ type: "x-xbrief/github-issue", uri: "https://github.com/o/r/issues/1" }],
      }),
    ).toBe(false);
    expect(isCodeBearingScope({ metadata: { kind: "docs" } })).toBe(false);
    expect(isCodeBearingScope({ metadata: { kind: "process" } })).toBe(false);
    expect(isCodeBearingScope({ metadata: { kind: "research" } })).toBe(false);
    expect(isCodeBearingScope({ tags: ["process-only"] })).toBe(false);
    expect(isCodeBearingScope({ tags: ["non-code"] })).toBe(false);
    expect(isCodeBearingScope({ tags: [1, "feature"] as unknown as string[] })).toBe(false);
  });

  it("rejects invalid non-delivery disposition and missing merge data", () => {
    root = makeRepo();
    const bad = evaluateDeliveryGate({
      projectRoot: root,
      plan: {
        references: [{ type: "x-xbrief/github-issue", uri: "https://github.com/o/r/issues/1" }],
      },
      nowIso: "2026-08-02T12:00:00Z",
      // @ts-expect-error intentional invalid disposition
      nonDeliveryDisposition: "shipped_anyway",
      runGit: gitOk(),
    });
    expect(bad.ok).toBe(false);

    const missing = evaluateDeliveryGate({
      projectRoot: root,
      plan: {
        references: [{ type: "x-xbrief/github-issue", uri: "https://github.com/o/r/issues/1" }],
      },
      nowIso: "2026-08-02T12:00:00Z",
      evidence: { prBase: "master", deliveryBranch: "master" },
      runGit: gitOk(),
    });
    expect(missing.ok).toBe(false);
    expect(missing.message).toMatch(/missing/i);
  });

  it("accepts assumeEvidenceValidated without remote ancestry after Prefer-A identity join", () => {
    root = makeRepo();
    const identity = identityOk({
      repository: "o/r",
      issueNumber: 1,
      prNumber: 9,
      mergeCommitSha: "abc",
    });
    const gate = evaluateDeliveryGate({
      projectRoot: root,
      plan: {
        references: [{ type: "x-xbrief/github-issue", uri: "https://github.com/o/r/issues/1" }],
      },
      nowIso: "2026-08-02T12:00:00Z",
      evidence: {
        prBase: "master",
        mergeCommit: "abc",
        mergedAt: "2026-08-02T11:00:00Z",
        deliveryBranch: "master",
        repository: "o/r",
        prNumber: 9,
      },
      ...identity,
      assumeEvidenceValidated: true,
      runGit: gitOk({ fetchFail: true }),
    });
    expect(gate.ok).toBe(true);
    expect(gate.provenance?.disposition).toBe("delivered");
    expect(gate.provenance?.deployed).toBeNull();
    expect(gate.message).toMatch(/Prefer-A identity join|pre-validated/i);
  });

  it("assumeEvidenceValidated still refuses tip-as-merge without Prefer-A identity (#3675)", () => {
    root = makeRepo();
    const identity = identityOk({
      repository: "o/r",
      issueNumber: 1,
      prNumber: 9,
      mergeCommitSha: "realmergesha",
    });
    const gate = evaluateDeliveryGate({
      projectRoot: root,
      plan: {
        references: [{ type: "x-xbrief/github-issue", uri: "https://github.com/o/r/issues/1" }],
      },
      nowIso: "2026-08-02T12:00:00Z",
      evidence: {
        prBase: "master",
        mergeCommit: "deliverytipsha",
        mergedAt: "2026-08-02T11:00:00Z",
        deliveryBranch: "master",
        repository: "o/r",
        prNumber: 9,
      },
      ...identity,
      assumeEvidenceValidated: true,
      runGit: gitOk({ fetchFail: true }),
    });
    expect(gate.ok).toBe(false);
    expect(gate.message).toMatch(/does not equal|identity/i);
    expect(gate.provenance).toBeNull();
  });

  it("evidenceFromPrPayload and refresh tip failures", async () => {
    root = makeRepo();
    const { evidenceFromPrPayload, refreshRemoteDeliveryRef, verifyDeliveryAncestry } =
      await import("./delivery-evidence.js");
    const evidence = evidenceFromPrPayload(
      {
        merged_at: "2026-08-02T11:00:00Z",
        base: { ref: "master" },
        head: { sha: "head1" },
        merge_commit_sha: "merge1",
      },
      5,
      "o/r",
      "master",
    );
    expect(evidence.prBase).toBe("master");
    expect(evidence.mergeCommit).toBe("merge1");
    expect(evidence.implementationCommit).toBe("head1");

    const nullMerged = evidenceFromPrPayload(
      { merged_at: null, base: {}, head: {}, merge_commit_sha: "" },
      6,
      null,
    );
    expect(nullMerged.mergedAt).toBeNull();
    expect(nullMerged.mergeCommit).toBeNull();

    const failTip: GitRunner = (_r, args) => {
      const j = args.join(" ");
      if (j.startsWith("fetch ")) return { code: 0, stdout: "", stderr: "" };
      if (j.includes("rev-parse")) return { code: 1, stdout: "", stderr: "missing" };
      return { code: 0, stdout: "", stderr: "" };
    };
    const refresh = refreshRemoteDeliveryRef(root, "master", failTip);
    expect(refresh.ok).toBe(false);

    const ancestryTip = verifyDeliveryAncestry(root, "abc", "master", failTip);
    expect(ancestryTip.ok).toBe(false);

    const failAncestorLookup: GitRunner = (_r, args) => {
      const j = args.join(" ");
      if (j.startsWith("fetch ")) return { code: 0, stdout: "", stderr: "" };
      if (j.includes("rev-parse") && j.includes("origin/")) {
        return { code: 0, stdout: "tipsha", stderr: "" };
      }
      if (j.includes("merge-base")) return { code: 128, stdout: "", stderr: "fatal" };
      return { code: 0, stdout: "", stderr: "" };
    };
    const anc = verifyDeliveryAncestry(root, "abc", "master", failAncestorLookup);
    expect(anc.ok).toBe(false);
    expect(anc.error).toBeTruthy();
  });

  it("resolvePlanGithubIssueRef reads expected repo/issue from plan (#3675)", () => {
    expect(
      resolvePlanGithubIssueRef({
        references: [
          { type: "x-xbrief/github-issue", uri: "https://github.com/deftai/directive/issues/3675" },
        ],
      }),
    ).toEqual({ repository: "deftai/directive", issueNumber: 3675 });
    expect(
      resolvePlanGithubIssueRef({
        references: [
          {
            type: "x-xbrief/github-issue",
            uri: "https://github.com/o/r/issues/1?view=1#section",
          },
        ],
      }),
    ).toEqual({ repository: "o/r", issueNumber: 1 });
    expect(resolvePlanGithubIssueRef({ references: [] })).toBeNull();
  });

  it("refuses cross-repository closing issue number collision (#3675)", () => {
    root = makeRepo();
    const plan = {
      references: [{ type: "x-xbrief/github-issue", uri: "https://github.com/o/r/issues/1" }],
    };
    const gate = evaluateDeliveryGate({
      projectRoot: root,
      plan,
      nowIso: "2026-08-02T12:00:00Z",
      evidence: {
        prNumber: 9,
        mergeCommit: "abc",
        mergedAt: "2026-08-02T11:00:00Z",
        deliveryBranch: "master",
      },
      ...identityOk({
        repository: "o/r",
        issueNumber: 1,
        prNumber: 9,
        mergeCommitSha: "abc",
        closingIssueRefs: [{ repository: "other/repo", issueNumber: 1 }],
      }),
      runGit: gitOk(),
    });
    expect(gate.ok).toBe(false);
    expect(gate.message).toMatch(/closer set|wrong story|absent association/i);
    expect(gate.provenance).toBeNull();
  });

  it("refuses tip-as-merge under Prefer-A even when same-SHA ancestry would short-circuit (#3675)", () => {
    root = makeRepo();
    const tip = "deliverytipsha";
    const identity = identityOk({
      repository: "o/r",
      issueNumber: 1,
      prNumber: 9,
      mergeCommitSha: "realmergesha",
    });
    // notAncestor:true would never be consulted for same-SHA tip; Prefer-A must refuse first.
    const gate = evaluateDeliveryGate({
      projectRoot: root,
      plan: {
        references: [{ type: "x-xbrief/github-issue", uri: "https://github.com/o/r/issues/1" }],
      },
      nowIso: "2026-08-02T12:00:00Z",
      evidence: {
        repository: "o/r",
        prNumber: 9,
        prBase: "master",
        mergeCommit: tip,
        mergedAt: "2026-08-02T11:00:00Z",
        deliveryBranch: "master",
      },
      ...identity,
      runGit: gitOk({ tip, notAncestor: true }),
    });
    expect(gate.ok).toBe(false);
    expect(gate.message).toMatch(/does not equal|identity join/i);
    expect(gate.provenance).toBeNull();
  });

  it("refuses wrong story PR, wrong repo, mismatched merge SHA, unmerged PR, lookup failure (#3675)", () => {
    root = makeRepo();
    const plan = {
      references: [{ type: "x-xbrief/github-issue", uri: "https://github.com/o/r/issues/1" }],
    };

    const wrongStory = evaluateDeliveryGate({
      projectRoot: root,
      plan,
      nowIso: "2026-08-02T12:00:00Z",
      evidence: {
        prNumber: 9,
        mergeCommit: "abc",
        mergedAt: "2026-08-02T11:00:00Z",
        deliveryBranch: "master",
      },
      ...identityOk({
        repository: "o/r",
        issueNumber: 1,
        prNumber: 9,
        mergeCommitSha: "abc",
        closingIssues: [999],
      }),
      runGit: gitOk(),
    });
    expect(wrongStory.ok).toBe(false);
    expect(wrongStory.message).toMatch(/closer set|wrong story|absent association/i);

    const wrongRepo = evaluateDeliveryGate({
      projectRoot: root,
      plan,
      nowIso: "2026-08-02T12:00:00Z",
      evidence: {
        repository: "other/repo",
        prNumber: 9,
        mergeCommit: "abc",
        mergedAt: "2026-08-02T11:00:00Z",
        deliveryBranch: "master",
      },
      ...identityOk({ repository: "o/r", issueNumber: 1, prNumber: 9, mergeCommitSha: "abc" }),
      runGit: gitOk(),
    });
    expect(wrongRepo.ok).toBe(false);
    expect(wrongRepo.message).toMatch(/does not match|expected repository/i);

    const mismatch = evaluateDeliveryGate({
      projectRoot: root,
      plan,
      nowIso: "2026-08-02T12:00:00Z",
      evidence: {
        prNumber: 9,
        mergeCommit: "foreignancestor",
        mergedAt: "2026-08-02T11:00:00Z",
        deliveryBranch: "master",
      },
      ...identityOk({
        repository: "o/r",
        issueNumber: 1,
        prNumber: 9,
        mergeCommitSha: "realmergesha",
      }),
      runGit: gitOk(),
    });
    expect(mismatch.ok).toBe(false);
    expect(mismatch.message).toMatch(/does not equal|merge_commit_sha/i);

    const unmerged = evaluateDeliveryGate({
      projectRoot: root,
      plan,
      nowIso: "2026-08-02T12:00:00Z",
      evidence: {
        prNumber: 9,
        mergeCommit: "abc",
        mergedAt: "2026-08-02T11:00:00Z",
        deliveryBranch: "master",
      },
      ...identityOk({
        repository: "o/r",
        issueNumber: 1,
        prNumber: 9,
        mergeCommitSha: "abc",
        mergedAt: null,
      }),
      runGit: gitOk(),
    });
    expect(unmerged.ok).toBe(false);
    expect(unmerged.message).toMatch(/not merged/i);

    const lookup = evaluateDeliveryGate({
      projectRoot: root,
      plan,
      nowIso: "2026-08-02T12:00:00Z",
      evidence: {
        prNumber: 9,
        mergeCommit: "abc",
        mergedAt: "2026-08-02T11:00:00Z",
        deliveryBranch: "master",
      },
      ...identityOk({
        repository: "o/r",
        issueNumber: 1,
        prNumber: 9,
        mergeCommitSha: "abc",
        lookupFail: true,
      }),
      runGit: gitOk(),
    });
    expect(lookup.ok).toBe(false);
    expect(lookup.message).toMatch(/lookup failure|could not fetch PR/i);

    const absentPr = evaluateDeliveryGate({
      projectRoot: root,
      plan,
      nowIso: "2026-08-02T12:00:00Z",
      evidence: {
        mergeCommit: "abc",
        mergedAt: "2026-08-02T11:00:00Z",
        deliveryBranch: "master",
      },
      ...identityOk({ repository: "o/r", issueNumber: 1, mergeCommitSha: "abc" }),
      runGit: gitOk(),
    });
    expect(absentPr.ok).toBe(false);
    expect(absentPr.message).toMatch(/missing story-associated PR|absent/i);
  });

  it("accepts squash delivery without requiring head-in-merge containment (#3675)", () => {
    root = makeRepo();
    const identity = identityOk({
      repository: "o/r",
      issueNumber: 1,
      prNumber: 11,
      mergeCommitSha: "squashmerge",
      headSha: "abandonedhead",
    });
    const gate = evaluateDeliveryGate({
      projectRoot: root,
      plan: {
        references: [{ type: "x-xbrief/github-issue", uri: "https://github.com/o/r/issues/1" }],
      },
      nowIso: "2026-08-02T12:00:00Z",
      evidence: {
        prNumber: 11,
        mergeCommit: "squashmerge",
        mergedAt: "2026-08-02T11:00:00Z",
        deliveryBranch: "master",
        implementationCommit: "abandonedhead",
      },
      ...identity,
      runGit: gitOk({ tip: "squashmerge" }),
    });
    expect(gate.ok).toBe(true);
    expect(gate.provenance?.disposition).toBe("delivered");
    expect(gate.provenance?.implementationCommit).toBe("abandonedhead");
  });

  it("delivery-gate refusal leaves no durable delivered stamp on complete (#3675)", () => {
    root = makeRepo();
    const file = writeCodeBearing(root);
    const identity = identityOk({ mergeCommitSha: "realmergesha" });
    const result = runTransition("complete", file, new Date("2026-08-02T12:00:00Z"), {
      runGit: gitOk(),
      ...identity,
      deliveryEvidence: {
        repository: "deftai/directive",
        prNumber: 42,
        mergeCommit: "deliverytipsha",
        mergedAt: "2026-08-02T11:00:00Z",
        deliveryBranch: "master",
      },
    });
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/identity join|does not equal/i);
    expect(readFileSync(file, "utf8")).toContain("running");
    expect(readFileSync(file, "utf8")).not.toMatch(/"disposition":\s*"delivered"/);
  });

  it("real git history: unrelated ancestor refuses; legitimate tip merge accepts (#3675)", () => {
    root = makeRepo();
    gitInit(root);
    writeFileSync(join(root, "a.txt"), "a\n", "utf8");
    git(root, ["add", "a.txt"]);
    git(root, ["commit", "-m", "base"]);
    const base = git(root, ["rev-parse", "HEAD"]);

    writeFileSync(join(root, "unrelated.txt"), "u\n", "utf8");
    git(root, ["add", "unrelated.txt"]);
    git(root, ["commit", "-m", "unrelated ancestor"]);
    const unrelated = git(root, ["rev-parse", "HEAD"]);

    writeFileSync(join(root, "story.txt"), "s\n", "utf8");
    git(root, ["add", "story.txt"]);
    git(root, ["commit", "-m", "story merge"]);
    const storyMerge = git(root, ["rev-parse", "HEAD"]);

    // Fake origin/master tip at storyMerge via local ref for ancestry.
    git(root, ["update-ref", "refs/remotes/origin/master", storyMerge]);

    const realGit: GitRunner = (cwd, args) => {
      try {
        if (args[0] === "fetch" && args[1] === "origin") {
          return { code: 0, stdout: "", stderr: "" };
        }
        const stdout = execFileSync("git", args, { cwd, encoding: "utf8" });
        return { code: 0, stdout: typeof stdout === "string" ? stdout : "", stderr: "" };
      } catch (err: unknown) {
        const e = err as { status?: number; stdout?: string; stderr?: string };
        return {
          code: typeof e.status === "number" ? e.status : 1,
          stdout: typeof e.stdout === "string" ? e.stdout : "",
          stderr: typeof e.stderr === "string" ? e.stderr : "",
        };
      }
    };

    const plan = {
      references: [
        { type: "x-xbrief/github-issue", uri: "https://github.com/deftai/directive/issues/3041" },
      ],
    };

    const refuseUnrelated = evaluateDeliveryGate({
      projectRoot: root,
      plan,
      nowIso: "2026-08-02T12:00:00Z",
      evidence: {
        prNumber: 42,
        mergeCommit: unrelated,
        mergedAt: "2026-08-02T11:00:00Z",
        deliveryBranch: "master",
      },
      ...identityOk({ mergeCommitSha: storyMerge }),
      runGit: realGit,
    });
    expect(refuseUnrelated.ok).toBe(false);
    expect(refuseUnrelated.message).toMatch(/does not equal|identity join/i);

    const acceptTip = evaluateDeliveryGate({
      projectRoot: root,
      plan,
      nowIso: "2026-08-02T12:00:00Z",
      evidence: {
        prNumber: 42,
        mergeCommit: storyMerge,
        mergedAt: "2026-08-02T11:00:00Z",
        deliveryBranch: "master",
      },
      ...identityOk({ mergeCommitSha: storyMerge }),
      runGit: realGit,
    });
    expect(acceptTip.ok).toBe(true);
    expect(acceptTip.provenance?.disposition).toBe("delivered");
    expect(acceptTip.provenance?.mergeCommit).toBe(storyMerge);

    // Integration path: story merge is ancestor of tip but not tip itself.
    git(root, ["commit", "--allow-empty", "-m", "later integration"]);
    const tip = git(root, ["rev-parse", "HEAD"]);
    git(root, ["update-ref", "refs/remotes/origin/master", tip]);
    const acceptViaIntegration = evaluateDeliveryGate({
      projectRoot: root,
      plan,
      nowIso: "2026-08-02T12:00:00Z",
      evidence: {
        prNumber: 42,
        prBase: "feature/integration",
        mergeCommit: storyMerge,
        mergedAt: "2026-08-02T11:00:00Z",
        deliveryBranch: "master",
      },
      ...identityOk({ mergeCommitSha: storyMerge, prBase: "feature/integration" }),
      runGit: realGit,
    });
    expect(acceptViaIntegration.ok).toBe(true);
    expect(acceptViaIntegration.provenance?.disposition).toBe("delivered");
    expect(base.length).toBeGreaterThan(0);
  });

  it("verifyStoryPrMergeIdentity binds implementationCommit via PR head, not git ancestry (#3675)", () => {
    const result = verifyStoryPrMergeIdentity({
      plan: {
        references: [{ type: "x-xbrief/github-issue", uri: "https://github.com/o/r/issues/1" }],
      },
      evidence: {
        prNumber: 3,
        mergeCommit: "squash",
        implementationCommit: "head-on-abandoned-branch",
      },
      mergeCommit: "squash",
      ...identityOk({
        repository: "o/r",
        issueNumber: 1,
        prNumber: 3,
        mergeCommitSha: "squash",
        headSha: "head-on-abandoned-branch",
      }),
    });
    expect(result.ok).toBe(true);
    expect(result.headSha).toBe("head-on-abandoned-branch");
  });

  it("refuses mismatched implementationCommit and closing-ref lookup failure (#3675)", () => {
    const mismatchImpl = verifyStoryPrMergeIdentity({
      plan: {
        references: [{ type: "x-xbrief/github-issue", uri: "https://github.com/o/r/issues/1" }],
      },
      evidence: {
        prNumber: 3,
        mergeCommit: "squash",
        implementationCommit: "other-head",
      },
      mergeCommit: "squash",
      ...identityOk({
        repository: "o/r",
        issueNumber: 1,
        prNumber: 3,
        mergeCommitSha: "squash",
        headSha: "head-on-abandoned-branch",
      }),
    });
    expect(mismatchImpl.ok).toBe(false);
    expect(mismatchImpl.message).toMatch(/implementationCommit/i);

    const closingFail = verifyStoryPrMergeIdentity({
      plan: {
        references: [{ type: "x-xbrief/github-issue", uri: "https://github.com/o/r/issues/1" }],
      },
      evidence: { prNumber: 3, mergeCommit: "squash" },
      mergeCommit: "squash",
      ...identityOk({
        repository: "o/r",
        issueNumber: 1,
        prNumber: 3,
        mergeCommitSha: "squash",
        closingLookupFail: true,
      }),
    });
    expect(closingFail.ok).toBe(false);
    expect(closingFail.message).toMatch(/closingIssuesReferences/i);
  });

  it("defaultFetchPrPayload / defaultFetchClosingIssueIds fail closed on bad inputs (#3675)", () => {
    expect(
      defaultFetchPrPayload(1, "not-a-repo", () => ({ returncode: 0, stdout: "{}", stderr: "" })),
    ).toBeNull();
    expect(
      defaultFetchPrPayload(1, "o/r", () => ({ returncode: 1, stdout: "", stderr: "boom" })),
    ).toBeNull();
    expect(
      defaultFetchPrPayload(1, "o/r", () => ({ returncode: 0, stdout: "not-json", stderr: "" })),
    ).toBeNull();
    expect(
      defaultFetchPrPayload(1, "o/r", () => ({ returncode: 0, stdout: "[]", stderr: "" })),
    ).toBeNull();
    expect(
      defaultFetchPrPayload(1, "o/r", () => ({
        returncode: 0,
        stdout: JSON.stringify({ merge_commit_sha: "abc" }),
        stderr: "",
      })),
    ).toEqual({ merge_commit_sha: "abc" });

    expect(
      defaultFetchClosingIssueIds(1, "o/r", () => ({
        returncode: 0,
        stdout: JSON.stringify({
          data: {
            repository: {
              pullRequest: {
                closingIssuesReferences: { nodes: [{ number: 7 }] },
              },
            },
          },
        }),
        stderr: "",
      })),
    ).toEqual([{ repository: "o/r", issueNumber: 7 }]);
    expect(
      defaultFetchClosingIssueIds(1, "o/r", () => ({
        returncode: 0,
        stdout: JSON.stringify({
          data: {
            repository: {
              pullRequest: {
                closingIssuesReferences: {
                  nodes: [
                    {
                      number: 7,
                      url: "https://github.com/other/repo/issues/7?view=1",
                      repository: { nameWithOwner: "other/repo" },
                    },
                  ],
                },
              },
            },
          },
        }),
        stderr: "",
      })),
    ).toEqual([{ repository: "other/repo", issueNumber: 7 }]);
    expect(
      defaultFetchClosingIssueIds(1, "o/r", () => ({ returncode: 1, stdout: "", stderr: "no" })),
    ).toBeNull();
    expect(
      defaultFetchClosingIssueIds(1, "not-a-repo", () => ({
        returncode: 0,
        stdout: "{}",
        stderr: "",
      })),
    ).toBeNull();

    expect(
      resolvePlanGithubIssueRef({
        references: [{ type: "other", uri: "https://example.com/x" }],
      }),
    ).toBeNull();
    expect(
      resolvePlanGithubIssueRef({
        references: [
          {
            type: "x-xbrief/github-issue",
            uri: "https://github.com/deftai/directive/issues/99/",
          },
        ],
      }),
    ).toEqual({ repository: "deftai/directive", issueNumber: 99 });
  });
});
