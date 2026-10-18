import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { mintOnePrUnitGrant } from "../one-pr-unit/mint.js";
import { getDefaultAppStore } from "../one-pr-unit/simulator.js";
import type { RunGhFn } from "../pr-protected-issues/types.js";
import type { GitRunner } from "../session/git.js";
import {
  classifyStoredDeliveryDisposition,
  defaultFetchClosingIssueIds,
  defaultFetchClosingPrRefs,
  defaultFetchPrPayload,
  discoverDeliveryEvidenceForComplete,
  evaluateDeliveryGate,
  evaluateExperimentArchivedFindingsGate,
  evaluateStoredCompletionProvenanceForWriteGuard,
  type FetchClosingIssueIdsFn,
  type FetchClosingPrRefsFn,
  type FetchPrPayloadFn,
  hasExplicitDeliverySelectors,
  isCodeBearingScope,
  isEligibleStoredDeliveryDisposition,
  NON_DELIVERY_DISPOSITIONS,
  refreshRemoteDeliveryRef,
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

  it("write-guard helper refuses informal keys and validates eligible dispositions (#5602)", () => {
    const informal = evaluateStoredCompletionProvenanceForWriteGuard({
      metadata: {
        completionProvenance: { productMerge: "abc", productPr: 1 },
      },
    });
    expect(informal.ok).toBe(false);
    if (!informal.ok) {
      expect(informal.detail).toMatch(/productMerge|productPr/);
    }

    const nonCode = evaluateStoredCompletionProvenanceForWriteGuard({
      tags: ["docs-only"],
      metadata: { kind: "docs", completedAt: "2026-10-14T00:00:00Z" },
    });
    expect(nonCode.ok).toBe(true);

    const codeMissing = evaluateStoredCompletionProvenanceForWriteGuard({
      references: [
        { type: "x-xbrief/github-issue", uri: "https://github.com/deftai/directive/issues/1" },
      ],
      metadata: { completedAt: "2026-10-14T00:00:00Z" },
    });
    expect(codeMissing.ok).toBe(false);

    // Failed gate outcomes are not eligible writer success stamps (#5602 P1).
    expect(isEligibleStoredDeliveryDisposition("not_delivered")).toBe(false);
    expect(isEligibleStoredDeliveryDisposition("merged_to_integration")).toBe(false);
    expect(isEligibleStoredDeliveryDisposition("delivered")).toBe(true);
    expect(isEligibleStoredDeliveryDisposition("accepted_not_delivered")).toBe(true);

    // Classifier still cast-throughs arbitrary strings; write-guard does not.
    expect(
      classifyStoredDeliveryDisposition({
        metadata: { completionProvenance: { disposition: "shipped-somehow" } },
      }),
    ).toBe("shipped-somehow");
    const castThrough = evaluateStoredCompletionProvenanceForWriteGuard({
      references: [
        { type: "x-xbrief/github-issue", uri: "https://github.com/deftai/directive/issues/1" },
      ],
      metadata: {
        completionProvenance: {
          disposition: "shipped-somehow",
          verifiedAt: "2026-10-14T00:00:00Z",
          verifier: "t",
          deliveryBranch: "master",
          mergeCommit: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          deliveryCommit: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        },
      },
    });
    expect(castThrough.ok).toBe(false);
  });

  it("write-guard exempts code-bearing scope:fail without completionProvenance (#5602)", () => {
    const failed = evaluateStoredCompletionProvenanceForWriteGuard({
      status: "failed",
      references: [
        {
          type: "x-xbrief/github-issue",
          uri: "https://github.com/deftai/directive/issues/5602",
        },
      ],
      metadata: {
        lifecycleWrite: { action: "fail", writtenAt: "2026-10-14T15:00:00Z" },
      },
    });
    expect(failed.ok).toBe(true);
  });

  it("write-guard refuses completed status with fail stamp and no provenance (#5602)", () => {
    const mismatched = evaluateStoredCompletionProvenanceForWriteGuard({
      status: "completed",
      references: [
        {
          type: "x-xbrief/github-issue",
          uri: "https://github.com/deftai/directive/issues/5602",
        },
      ],
      metadata: {
        lifecycleWrite: { action: "fail", writtenAt: "2026-10-14T15:00:00Z" },
      },
    });
    expect(mismatched.ok).toBe(false);
    if (!mismatched.ok) {
      expect(mismatched.detail).toMatch(/missing completionProvenance/);
    }
  });

  it("fails closed on code-bearing complete without evidence", () => {
    root = makeRepo();
    const file = writeCodeBearing(root);
    const result = runTransition("complete", file, new Date(), {
      runGit: gitOk(),
      // Offline: empty complete closing set (no productPullRequest) (#3583).
      fetchClosingPrRefs: () => ({ ok: true, refs: [] }),
    });
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/Delivery auto-discovery found zero|#3041|#3583/);
    expect(result.message).toMatch(/--merge-commit|productPullRequest/);
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
    expect(evidence.verifier).toBe("swarm:finalize-cohort");

    const completeAttr = evidenceFromPrPayload(
      {
        merged_at: "2026-08-02T11:00:00Z",
        base: { ref: "master" },
        head: { sha: "head1" },
        merge_commit_sha: "merge1",
      },
      5,
      "o/r",
      "master",
      "scope:complete",
    );
    expect(completeAttr.verifier).toBe("scope:complete");

    const nullMerged = evidenceFromPrPayload(
      { merged_at: null, base: {}, head: {}, merge_commit_sha: "" },
      6,
      null,
    );
    expect(nullMerged.mergedAt).toBeNull();
    expect(nullMerged.mergeCommit).toBeNull();
    expect(nullMerged.verifier).toBe("swarm:finalize-cohort");

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

describe("experiment_archived Findings gate (#5693)", () => {
  let root = "";

  afterEach(() => {
    if (root) {
      rmSync(root, { recursive: true, force: true });
      root = "";
    }
  });

  function writePlan(
    projectRoot: string,
    plan: Record<string, unknown>,
    name = "story.xbrief.json",
  ): string {
    const file = join(projectRoot, "xbrief", "active", name);
    writeFileSync(
      file,
      JSON.stringify({
        xBRIEFInfo: { version: "0.8" },
        plan,
      }),
      "utf8",
    );
    return file;
  }

  it("evaluateExperimentArchivedFindingsGate requires trim-non-empty Findings", () => {
    expect(evaluateExperimentArchivedFindingsGate({ title: "x" }).ok).toBe(false);
    expect(
      evaluateExperimentArchivedFindingsGate({
        narratives: { Findings: "   " },
      }).ok,
    ).toBe(false);
    expect(
      evaluateExperimentArchivedFindingsGate({
        narratives: { Findings: "learned that X failed under Y" },
      }).ok,
    ).toBe(true);
  });

  it("refuses code-bearing experiment_archived without Findings and leaves brief unmoved", () => {
    root = makeRepo();
    const file = writeCodeBearing(root);
    const before = readFileSync(file, "utf8");
    const result = runTransition("complete", file, new Date("2026-10-18T12:00:00Z"), {
      nonDeliveryDisposition: "experiment_archived",
      runGit: gitOk(),
    });
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/plan\.narratives\.Findings/);
    expect(result.message).toMatch(/#5693/);
    expect(readFileSync(file, "utf8")).toBe(before);
    expect(existsSync(join(root, "xbrief", "completed", "story.xbrief.json"))).toBe(false);
  });

  it("accepts code-bearing experiment_archived with Findings", () => {
    root = makeRepo();
    const file = writePlan(root, {
      title: "code story",
      status: "running",
      narratives: { Findings: "spike showed the API rate-limits at 10 rps" },
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
      items: [],
    });
    const result = runTransition("complete", file, new Date("2026-10-18T12:00:00Z"), {
      nonDeliveryDisposition: "experiment_archived",
      runGit: gitOk(),
    });
    expect(result.ok).toBe(true);
    const dest = join(root, "xbrief", "completed", "story.xbrief.json");
    const data = JSON.parse(readFileSync(dest, "utf8")) as {
      plan: { metadata: { completionProvenance: { disposition: string } } };
    };
    expect(data.plan.metadata.completionProvenance.disposition).toBe("experiment_archived");
  });

  it("refuses non-code experiment_archived without Findings before early return", () => {
    root = makeRepo();
    const file = writePlan(root, {
      title: "docs story",
      status: "running",
      tags: ["docs-only"],
      metadata: { kind: "docs" },
      items: [],
    });
    const before = readFileSync(file, "utf8");
    const result = runTransition("complete", file, new Date("2026-10-18T12:00:00Z"), {
      nonDeliveryDisposition: "experiment_archived",
      runGit: gitOk(),
    });
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/plan\.narratives\.Findings/);
    expect(readFileSync(file, "utf8")).toBe(before);
  });

  it("accepts non-code experiment_archived with Findings", () => {
    root = makeRepo();
    const file = writePlan(root, {
      title: "docs story",
      status: "running",
      tags: ["docs-only"],
      narratives: { Findings: "audience rejected the copy in trial 1" },
      metadata: { kind: "docs" },
      items: [],
    });
    const result = runTransition("complete", file, new Date("2026-10-18T12:00:00Z"), {
      nonDeliveryDisposition: "experiment_archived",
      runGit: gitOk(),
    });
    expect(result.ok).toBe(true);
  });

  it("does not require Findings for cancelled", () => {
    root = makeRepo();
    const cancelled = writeCodeBearing(root, "cancelled.xbrief.json");
    const cancelledResult = runTransition("complete", cancelled, new Date("2026-10-18T12:00:00Z"), {
      nonDeliveryDisposition: "cancelled",
      runGit: gitOk(),
    });
    expect(cancelledResult.ok).toBe(true);
  });

  it("does not require Findings for accepted_not_delivered", () => {
    root = makeRepo();
    const accepted = writeCodeBearing(root, "accepted.xbrief.json");
    const acceptedResult = runTransition("complete", accepted, new Date("2026-10-18T12:00:00Z"), {
      nonDeliveryDisposition: "accepted_not_delivered",
      runGit: gitOk(),
    });
    expect(acceptedResult.ok).toBe(true);
  });
});

describe("delivery-evidence AppSec fetch gate (#5545)", () => {
  it("refreshRemoteDeliveryRef refuses hostile names before spawn and uses tracking argv", () => {
    const calls: string[][] = [];
    const runGit: GitRunner = (_cwd, args) => {
      calls.push([...args]);
      return { code: 0, stdout: "abc\n", stderr: "" };
    };
    for (const hostile of ["--upload-pack=evil", "attacker:main", "-x", "a..b", " ", ""]) {
      calls.length = 0;
      const result = refreshRemoteDeliveryRef("/tmp", hostile, runGit);
      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/Invalid|must match/i);
      expect(calls).toHaveLength(0);
    }
    calls.length = 0;
    const ok = refreshRemoteDeliveryRef("/tmp", "release/1.0", runGit);
    expect(ok.ok).toBe(true);
    expect(calls[0]).toEqual([
      "fetch",
      "origin",
      "--",
      "refs/heads/release/1.0:refs/remotes/origin/release/1.0",
    ]);
    expect(calls[1]).toEqual(["rev-parse", "--verify", "origin/release/1.0"]);
  });

  it("evaluateDeliveryGate refuses empty/unsafe resolved delivery before assumeEvidenceValidated", () => {
    const root = makeRepo();
    writeFileSync(
      join(root, "xbrief", "PROJECT-DEFINITION.xbrief.json"),
      JSON.stringify({
        plan: {
          title: "P",
          status: "running",
          policy: { deliveryBranch: "--upload-pack=x", wipCap: 20 },
        },
      }),
      "utf8",
    );
    try {
      const gate = evaluateDeliveryGate({
        projectRoot: root,
        plan: {
          references: [
            { type: "x-xbrief/github-issue", uri: "https://github.com/deftai/directive/issues/1" },
          ],
        },
        evidence: {
          prNumber: 1,
          mergeCommit: "abc",
          mergedAt: "2026-08-02T11:00:00Z",
          deliveryBranch: "--upload-pack=x",
        },
        assumeEvidenceValidated: true,
        fetchPrPayload: () => ({
          merged_at: "2026-08-02T11:00:00Z",
          merge_commit_sha: "abc",
          base: { ref: "master" },
          head: { sha: "h" },
        }),
        fetchClosingIssueIds: () => [1],
        runGit: () => ({ code: 0, stdout: "", stderr: "" }),
      });
      expect(gate.ok).toBe(false);
      expect(gate.message).toMatch(/Invalid plan\.policy\.deliveryBranch|--upload-pack/i);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("delivery evidence auto-discovery (#3583)", () => {
  let root = "";
  afterEach(() => {
    if (root.length > 0) {
      rmSync(root, { recursive: true, force: true });
      root = "";
    }
  });

  function stampProductPr(file: string, prNumber: number): void {
    const data = JSON.parse(readFileSync(file, "utf8")) as {
      plan: { metadata: Record<string, unknown> };
    };
    data.plan.metadata.productPullRequest = prNumber;
    writeFileSync(file, JSON.stringify(data), "utf8");
  }

  it("hasExplicitDeliverySelectors triggers on --pr or --merge-commit only", () => {
    expect(hasExplicitDeliverySelectors(undefined)).toBe(false);
    expect(hasExplicitDeliverySelectors({})).toBe(false);
    expect(hasExplicitDeliverySelectors({ deliveryBranch: "master" })).toBe(false);
    expect(hasExplicitDeliverySelectors({ prNumber: 9 })).toBe(true);
    expect(hasExplicitDeliverySelectors({ mergeCommit: "abc" })).toBe(true);
  });

  it("auto-discovers from productPullRequest with scope:complete verifier", () => {
    root = makeRepo();
    const file = writeCodeBearing(root);
    stampProductPr(file, 42);
    const identity = identityOk();
    const result = runTransition("complete", file, new Date("2026-08-02T12:00:00Z"), {
      runGit: gitOk(),
      ...identity,
      fetchClosingPrRefs: () => {
        throw new Error("must not open multi-PR search when productPullRequest is stamped");
      },
    });
    expect(result.ok).toBe(true);
    const dest = join(root, "xbrief", "completed", "story.xbrief.json");
    const data = JSON.parse(readFileSync(dest, "utf8")) as {
      plan: {
        metadata: {
          completionProvenance: {
            disposition: string;
            prNumber: number;
            mergeCommit: string;
            verifier: string;
          };
        };
      };
    };
    expect(data.plan.metadata.completionProvenance.disposition).toBe("delivered");
    expect(data.plan.metadata.completionProvenance.prNumber).toBe(42);
    expect(data.plan.metadata.completionProvenance.mergeCommit).toBe("mergecommitsha");
    expect(data.plan.metadata.completionProvenance.verifier).toBe("scope:complete");
  });

  it("skips discovery when explicit --pr is supplied", () => {
    root = makeRepo();
    const file = writeCodeBearing(root);
    stampProductPr(file, 99);
    const identity = identityOk({ prNumber: 42 });
    let closingCalls = 0;
    const result = runTransition("complete", file, new Date("2026-08-02T12:00:00Z"), {
      runGit: gitOk(),
      ...identity,
      fetchClosingPrRefs: () => {
        closingCalls += 1;
        return { ok: true, refs: [] };
      },
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
    expect(closingCalls).toBe(0);
  });

  it("refuses CLI delivery-branch mismatch before discovery", () => {
    root = makeRepo();
    const file = writeCodeBearing(root);
    stampProductPr(file, 42);
    const discovered = discoverDeliveryEvidenceForComplete({
      projectRoot: root,
      plan: JSON.parse(readFileSync(file, "utf8")).plan as Record<string, unknown>,
      evidence: { deliveryBranch: "develop" },
      runGit: gitOk(),
      fetchPrPayload: () => {
        throw new Error("must refuse mismatch before fetch");
      },
    });
    expect(discovered.ok).toBe(false);
    if (!discovered.ok) {
      expect(discovered.message).toMatch(/does not match|deliveryBranch|--delivery-branch|#3583/);
    }
  });

  it("fail-closed on many delivery-base closing PRs", () => {
    root = makeRepo();
    const file = writeCodeBearing(root);
    const payloads: Record<number, Record<string, unknown>> = {
      10: {
        merged_at: "2026-08-01T00:00:00Z",
        merge_commit_sha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        base: { ref: "master" },
        head: { sha: "h1" },
      },
      11: {
        merged_at: "2026-08-02T00:00:00Z",
        merge_commit_sha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        base: { ref: "master" },
        head: { sha: "h2" },
      },
    };
    const fetchPrPayload: FetchPrPayloadFn = (n, repo) => {
      if (repo !== "deftai/directive") return null;
      return payloads[n] ?? null;
    };
    const fetchClosingPrRefs: FetchClosingPrRefsFn = () => ({
      ok: true,
      refs: [
        { repository: "deftai/directive", prNumber: 10 },
        { repository: "deftai/directive", prNumber: 11 },
      ],
    });
    const result = runTransition("complete", file, new Date("2026-08-02T12:00:00Z"), {
      runGit: gitOk(),
      fetchPrPayload,
      fetchClosingPrRefs,
    });
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/found 2 merged delivery-base PRs|#10|#11|refuse to guess/);
  });

  it("fail-closed on incomplete closing-PR discovery", () => {
    root = makeRepo();
    const file = writeCodeBearing(root);
    const result = runTransition("complete", file, new Date(), {
      runGit: gitOk(),
      fetchClosingPrRefs: () => ({
        ok: false,
        error:
          "closing-PR discovery incomplete for deftai/directive#3041: hasNextPage without endCursor",
      }),
    });
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/incomplete|hasNextPage|#3583|#3041/);
  });

  it("filters integration-base closing PRs out of the candidate set", () => {
    root = makeRepo();
    const file = writeCodeBearing(root);
    const result = runTransition("complete", file, new Date(), {
      runGit: gitOk(),
      fetchPrPayload: () => ({
        merged_at: "2026-08-02T11:00:00Z",
        merge_commit_sha: "mergecommitsha",
        base: { ref: "develop" },
        head: { sha: "head" },
      }),
      fetchClosingPrRefs: () => ({
        ok: true,
        refs: [{ repository: "deftai/directive", prNumber: 42 }],
      }),
    });
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/zero merged delivery-base|productPullRequest|#3583/);
  });

  it("singleton closing PR auto-discovers on primary complete", () => {
    root = makeRepo();
    const file = writeCodeBearing(root);
    const identity = identityOk({ prNumber: 42 });
    const result = runTransition("complete", file, new Date("2026-08-02T12:00:00Z"), {
      runGit: gitOk(),
      ...identity,
      fetchClosingPrRefs: () => ({
        ok: true,
        refs: [{ repository: "deftai/directive", prNumber: 42 }],
      }),
    });
    expect(result.ok).toBe(true);
    const dest = join(root, "xbrief", "completed", "story.xbrief.json");
    const data = JSON.parse(readFileSync(dest, "utf8")) as {
      plan: { metadata: { completionProvenance: { verifier: string; prNumber: number } } };
    };
    expect(data.plan.metadata.completionProvenance.verifier).toBe("scope:complete");
    expect(data.plan.metadata.completionProvenance.prNumber).toBe(42);
  });

  it("refuses discovered multi-origin PR without one-PR-unit grant", () => {
    root = makeRepo();
    const file = writeCodeBearing(root);
    const identity = identityOk({
      prNumber: 42,
      closingIssues: [3041, 9999],
    });
    const runGh: RunGhFn = (cmd) => {
      const joined = cmd.join(" ");
      if (joined.includes("repos/deftai/directive/pulls/42")) {
        return {
          returncode: 0,
          stdout: JSON.stringify({ node_id: "PR_kwDOTestNode42" }),
          stderr: "",
        };
      }
      return { returncode: 1, stdout: "", stderr: "unexpected gh" };
    };
    const result = runTransition("complete", file, new Date("2026-08-02T12:00:00Z"), {
      runGit: gitOk(),
      runGh,
      ...identity,
      fetchClosingPrRefs: () => ({
        ok: true,
        refs: [{ repository: "deftai/directive", prNumber: 42 }],
      }),
    });
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/one-PR-unit|missing one-PR-unit consent|#3041|#9999/i);
  });

  it("allows discovered multi-origin PR when App grant is bound to PR node", () => {
    root = makeRepo();
    const file = writeCodeBearing(root);
    const identity = identityOk({
      prNumber: 42,
      closingIssues: [3041, 9999],
    });
    const store = getDefaultAppStore();
    const claim = mintOnePrUnitGrant({
      store,
      actor: "tester",
      approvalRef: "ref-3583",
      rationale: "cohort close",
      origins: [
        { repo: "deftai/directive", issueId: 3041 },
        { repo: "deftai/directive", issueId: 9999 },
      ],
      repo: "deftai/directive",
    });
    store.bind(claim.id, "PR_kwDOTestNode42");
    const runGh: RunGhFn = (cmd) => {
      const joined = cmd.join(" ");
      if (joined.includes("repos/deftai/directive/pulls/42")) {
        return {
          returncode: 0,
          stdout: JSON.stringify({ node_id: "PR_kwDOTestNode42" }),
          stderr: "",
        };
      }
      return { returncode: 1, stdout: "", stderr: "unexpected gh" };
    };
    const result = runTransition("complete", file, new Date("2026-08-02T12:00:00Z"), {
      runGit: gitOk(),
      runGh,
      ...identity,
      fetchClosingPrRefs: () => ({
        ok: true,
        refs: [{ repository: "deftai/directive", prNumber: 42 }],
      }),
    });
    expect(result.ok).toBe(true);
  });

  it("defaultFetchClosingPrRefs fails closed on unreadable nodes", () => {
    const runGh: RunGhFn = () => ({
      returncode: 0,
      stdout: JSON.stringify({
        data: {
          repository: {
            issue: {
              closedByPullRequestsReferences: {
                pageInfo: { hasNextPage: false, endCursor: null },
                nodes: [null],
              },
            },
          },
        },
      }),
      stderr: "",
    });
    const result = defaultFetchClosingPrRefs(3041, "deftai/directive", runGh);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/unreadable closedByPullRequestsReferences node/);
    }
  });

  it("defaultFetchClosingPrRefs fails closed on missing pageInfo", () => {
    const runGh: RunGhFn = () => ({
      returncode: 0,
      stdout: JSON.stringify({
        data: {
          repository: {
            issue: {
              closedByPullRequestsReferences: {
                nodes: [{ number: 42, url: "https://github.com/deftai/directive/pull/42" }],
              },
            },
          },
        },
      }),
      stderr: "",
    });
    const result = defaultFetchClosingPrRefs(3041, "deftai/directive", runGh);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/missing pageInfo/);
    }
  });

  it("shares discovery on completed-brief restamp path", () => {
    root = makeRepo();
    const active = writeCodeBearing(root);
    stampProductPr(active, 42);
    const identity = identityOk();
    const first = runTransition("complete", active, new Date("2026-08-02T12:00:00Z"), {
      runGit: gitOk(),
      ...identity,
      fetchClosingPrRefs: () => {
        throw new Error("productPullRequest seed must skip closing search");
      },
    });
    expect(first.ok).toBe(true);
    const completed = join(root, "xbrief", "completed", "story.xbrief.json");
    const restamp = runTransition("complete", completed, new Date("2026-08-02T13:00:00Z"), {
      runGit: gitOk(),
      ...identity,
      fetchClosingPrRefs: () => {
        throw new Error("productPullRequest seed must skip closing search on restamp");
      },
    });
    expect(restamp.ok).toBe(true);
    const data = JSON.parse(readFileSync(completed, "utf8")) as {
      plan: { metadata: { completionProvenance: { verifier: string } } };
    };
    expect(data.plan.metadata.completionProvenance.verifier).toBe("scope:complete");
  });
});
