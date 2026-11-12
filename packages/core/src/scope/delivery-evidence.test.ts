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
  bodyHasClosingKeywordFor,
  classifyStoredDeliveryDisposition,
  connectedAtMergedAt,
  defaultFetchClosingIssueIds,
  defaultFetchClosingPrRefs,
  defaultFetchPrChangedFiles,
  defaultFetchPrPayload,
  defaultMergeTimeForge,
  discoverDeliveryEvidenceForComplete,
  evaluateDeliveryGate,
  evaluateExperimentArchivedFindingsGate,
  evaluateStoredCompletionProvenanceForWriteGuard,
  type FetchClosingIssueIdsFn,
  type FetchClosingPrRefsFn,
  type FetchPrChangedFilesFn,
  type FetchPrPayloadFn,
  hasExplicitDeliverySelectors,
  isCodeBearingScope,
  isDeliveryBriefLandExcluded,
  isEligibleStoredDeliveryDisposition,
  MERGE_TIME_SCAN_WALL_CLOCK_MS,
  type MergedPrListNode,
  type MergeTimeForge,
  NON_DELIVERY_DISPOSITIONS,
  PR_FILES_LISTING_CAP,
  type PrBodyRevision,
  type PrConnectionEvent,
  type PrFileEntry,
  prDiffAddsBrief,
  type RateLimitSnapshot,
  refreshRemoteDeliveryRef,
  resolveCanonicalProjectRepository,
  resolveCompletionSessionId,
  resolvePlanGithubIssueRef,
  resolvePrOnlyDeliveryIdentity,
  scanSoleMarkCompetitors,
  selectMergeTimeBody,
  soleDeftStoryMark,
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
}): {
  fetchPrPayload: FetchPrPayloadFn;
  fetchClosingIssueIds: FetchClosingIssueIdsFn;
  mergeTimeForge: MergeTimeForge;
} {
  const prNumber = opts?.prNumber ?? 42;
  const issueNumber = opts?.issueNumber ?? 3041;
  const repository = opts?.repository ?? "deftai/directive";
  const mergeCommitSha = opts?.mergeCommitSha ?? "mergecommitsha";
  const headSha = opts?.headSha ?? "implementationhead";
  const prBase = opts?.prBase ?? "master";
  const mergedAt = opts?.mergedAt === undefined ? "2026-08-02T11:00:00Z" : opts.mergedAt;
  const closingIssues = opts?.closingIssues === undefined ? [issueNumber] : opts.closingIssues;
  // #5710: the closer fixtures become merge-time closing keywords in the PR body.
  const closingRefs =
    opts?.closingIssueRefs ??
    (closingIssues ?? []).map((issue) => ({ repository, issueNumber: issue }));
  const body = closingRefs
    .map((ref) =>
      ref.repository === repository
        ? `Closes #${ref.issueNumber}`
        : `Closes ${ref.repository}#${ref.issueNumber}`,
    )
    .join("\n");

  const fetchPrPayload: FetchPrPayloadFn = (n, repo) => {
    if (opts?.lookupFail) return null;
    if (n !== prNumber || repo !== repository) return null;
    return {
      merged_at: mergedAt,
      merge_commit_sha: mergeCommitSha,
      base: { ref: prBase },
      head: { sha: headSha },
      body,
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
  const mergeTimeForge = makeForge(
    opts?.closingLookupFail ? { revisionsFail: [prNumber], eventsFail: [prNumber] } : {},
  );
  return { fetchPrPayload, fetchClosingIssueIds, mergeTimeForge };
}

/** Offline merge-time forge fixture (#5710). Every read is scripted; no network. */
interface ForgeFixture {
  /** Full merged-PR listing, served in pages of `pageSize`. */
  readonly merged?: readonly MergedPrListNode[];
  readonly pageSize?: number;
  /** 0-based page index whose fetch fails. */
  readonly listFailAtPage?: number;
  /** Page index served with hasNextPage but no endCursor. */
  readonly listBrokenCursorAtPage?: number;
  readonly revisions?: Readonly<Record<number, readonly PrBodyRevision[]>>;
  readonly revisionsFail?: readonly number[];
  readonly events?: Readonly<Record<number, readonly PrConnectionEvent[]>>;
  readonly eventsFail?: readonly number[];
  /** Per-PR files; default is one product file. */
  readonly files?: Readonly<Record<number, readonly PrFileEntry[] | "fail">>;
  /** Rate snapshots served in order; the last repeats. null = probe failure. */
  readonly rates?: readonly (RateLimitSnapshot | null)[];
  /** Clock step added after each nowMs() read. */
  readonly clockStepMs?: number;
}

function makeForge(fx: ForgeFixture): MergeTimeForge & { readonly calls: string[] } {
  const calls: string[] = [];
  const pageSize = fx.pageSize ?? 100;
  const merged = fx.merged ?? [];
  let rateIndex = 0;
  let clock = 0;
  const single = <T>(nodes: readonly T[]) => ({
    ok: true as const,
    nodes,
    hasNextPage: false,
    endCursor: null,
  });
  return {
    calls,
    listMergedPrsPage: (_repo, after) => {
      const index = after === null ? 0 : Number(after);
      calls.push(`list:${index}`);
      if (fx.listFailAtPage === index) return { ok: false, error: "secondary rate limit" };
      const nodes = merged.slice(index * pageSize, (index + 1) * pageSize);
      const hasNextPage = (index + 1) * pageSize < merged.length;
      const broken = fx.listBrokenCursorAtPage === index;
      return {
        ok: true,
        nodes,
        hasNextPage,
        endCursor: hasNextPage && !broken ? String(index + 1) : null,
      };
    },
    fetchBodyRevisionsPage: (_repo, n) => {
      calls.push(`revisions:${n}`);
      if (fx.revisionsFail?.includes(n)) return { ok: false, error: "revision read failed" };
      return single(fx.revisions?.[n] ?? []);
    },
    fetchConnectionEventsPage: (_repo, n) => {
      calls.push(`events:${n}`);
      if (fx.eventsFail?.includes(n)) return { ok: false, error: "timeline read failed" };
      return single(fx.events?.[n] ?? []);
    },
    fetchPrFiles: (_repo, n) => {
      calls.push(`files:${n}`);
      const files = fx.files?.[n];
      if (files === "fail") return { ok: false, error: "files read failed" };
      return {
        ok: true,
        files: files ?? [{ status: "modified", filename: "packages/core/src/x.ts" }],
      };
    },
    probeRateLimit: () => {
      const rates = fx.rates ?? [{ graphqlRemaining: 5000, coreRemaining: 5000 }];
      const rate = rates[Math.min(rateIndex, rates.length - 1)] ?? null;
      rateIndex += 1;
      return rate;
    },
    nowMs: () => {
      const now = clock;
      clock += fx.clockStepMs ?? 0;
      return now;
    },
  };
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

    // #5540: migrate-authored complete+migration does not invent or require provenance.
    const migrated = evaluateStoredCompletionProvenanceForWriteGuard({
      status: "completed",
      references: [
        {
          type: "x-xbrief/github-issue",
          uri: "https://github.com/deftai/directive/issues/5540",
        },
      ],
      metadata: {
        lifecycleWrite: {
          action: "complete",
          writtenAt: "2026-10-15T12:00:00Z",
          migration: true,
        },
      },
    });
    expect(migrated.ok).toBe(true);
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
    expect(gate.message).toMatch(/no merge-time association/);
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
    expect(wrongStory.message).toMatch(/no merge-time association/);

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

describe("brief-in-PR-diff identity fallback (#3675)", () => {
  let root: string | undefined;
  afterEach(() => {
    if (root !== undefined) rmSync(root, { recursive: true, force: true });
    root = undefined;
  });

  const brief = "story.xbrief.json";
  const deliveringFiles: FetchPrChangedFilesFn = (n, repo) =>
    n === 42 && repo === "deftai/directive"
      ? [
          { status: "added", filename: `xbrief/active/${brief}` },
          { status: "modified", filename: "packages/core/src/scope/transition.ts" },
        ]
      : null;
  const plan = {
    references: [
      { type: "x-xbrief/github-issue", uri: "https://github.com/deftai/directive/issues/3041" },
    ],
  };
  const evidence = { prNumber: 42, mergeCommit: "mergecommitsha" };

  it("prDiffAddsBrief requires the brief added in a lifecycle folder plus a non-brief file", () => {
    const code = { status: "modified", filename: "src/a.ts" };
    expect(
      prDiffAddsBrief([{ status: "added", filename: `xbrief/active/${brief}` }, code], brief),
    ).toBe(true);
    expect(
      prDiffAddsBrief([{ status: "added", filename: `vbrief/proposed/${brief}` }, code], brief),
    ).toBe(true);
    // Brief only, no code: not delivery.
    expect(prDiffAddsBrief([{ status: "added", filename: `xbrief/active/${brief}` }], brief)).toBe(
      false,
    );
    // Edited or moved (a lifecycle PR), not added.
    expect(
      prDiffAddsBrief([{ status: "modified", filename: `xbrief/active/${brief}` }, code], brief),
    ).toBe(false);
    expect(
      prDiffAddsBrief([{ status: "renamed", filename: `xbrief/completed/${brief}` }, code], brief),
    ).toBe(false);
    // Same name outside a lifecycle folder, or another brief.
    expect(prDiffAddsBrief([{ status: "added", filename: `docs/${brief}` }, code], brief)).toBe(
      false,
    );
    // Lifecycle folder name under an unrelated root must not prove delivery (#6093 Greptile P1).
    expect(
      prDiffAddsBrief([{ status: "added", filename: `docs/active/${brief}` }, code], brief),
    ).toBe(false);
    expect(
      prDiffAddsBrief(
        [{ status: "added", filename: "xbrief/active/other.xbrief.json" }, code],
        brief,
      ),
    ).toBe(false);
    expect(
      prDiffAddsBrief([{ status: "added", filename: `xbrief/active/${brief}` }, code], " "),
    ).toBe(false);
  });

  it("accepts a PR that added the brief when the issue was linked after merge", () => {
    const result = verifyStoryPrMergeIdentity({
      plan,
      evidence,
      mergeCommit: "mergecommitsha",
      ...identityOk({ closingIssues: [] }),
      briefBasename: brief,
      fetchPrChangedFiles: deliveringFiles,
    });
    expect(result.ok).toBe(true);
    expect(result.identityBasis).toBe("brief-in-pr-diff");
    expect(result.message).toMatch(/brief-in-pr-diff/);
  });

  it("still refuses a closer miss without the fallback inputs, a failed lookup, or an edit-only PR", () => {
    const base = {
      plan,
      evidence,
      mergeCommit: "mergecommitsha",
      ...identityOk({ closingIssues: [] }),
    };
    const noFallback = verifyStoryPrMergeIdentity(base);
    expect(noFallback.ok).toBe(false);
    expect(noFallback.message).toMatch(/no merge-time association/);
    expect(noFallback.message).not.toMatch(/brief-in-PR-diff/);

    const lookupFail = verifyStoryPrMergeIdentity({
      ...base,
      briefBasename: brief,
      fetchPrChangedFiles: () => null,
    });
    expect(lookupFail.ok).toBe(false);
    expect(lookupFail.message).toMatch(/lookup failure/);

    const editOnly = verifyStoryPrMergeIdentity({
      ...base,
      briefBasename: brief,
      fetchPrChangedFiles: () => [{ status: "modified", filename: `xbrief/active/${brief}` }],
    });
    expect(editOnly.ok).toBe(false);
    expect(editOnly.message).toMatch(/did not add/);
  });

  it("still enforces merge-commit identity on the fallback path", () => {
    const result = verifyStoryPrMergeIdentity({
      plan,
      evidence: { prNumber: 42, mergeCommit: "othersha" },
      mergeCommit: "othersha",
      ...identityOk({ closingIssues: [] }),
      briefBasename: brief,
      fetchPrChangedFiles: deliveringFiles,
    });
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/merge_commit_sha/);
  });

  it("merge-time keyword joins record their basis and skip the brief-diff read (#5710)", () => {
    root = makeRepo();
    const gate = evaluateDeliveryGate({
      projectRoot: root,
      plan,
      nowIso: "2026-08-02T12:00:00Z",
      evidence: { ...evidence, mergedAt: "2026-08-02T11:00:00Z", repository: "deftai/directive" },
      ...identityOk(),
      briefBasename: brief,
      fetchPrChangedFiles: () => {
        throw new Error("fallback must not run when the closer set matches");
      },
      runGit: gitOk(),
    });
    expect(gate.ok).toBe(true);
    expect(gate.provenance).not.toBeNull();
    expect(gate.provenance?.identityBasis).toBe("merge-time-keyword");
  });

  it("scope:complete records identityBasis when completing via the fallback", () => {
    root = makeRepo();
    const file = writeCodeBearing(root, brief);
    const result = runTransition("complete", file, new Date("2026-08-02T12:00:00Z"), {
      runGit: gitOk(),
      ...identityOk({ closingIssues: [] }),
      fetchPrChangedFiles: deliveringFiles,
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
    const data = JSON.parse(readFileSync(join(root, "xbrief", "completed", brief), "utf8")) as {
      plan: { metadata: { completionProvenance: { identityBasis?: string; disposition: string } } };
    };
    expect(data.plan.metadata.completionProvenance.identityBasis).toBe("brief-in-pr-diff");
    expect(data.plan.metadata.completionProvenance.disposition).toBe("delivered");
  });

  it("defaultFetchPrChangedFiles parses paginated tsv and fails closed", () => {
    const calls: string[][] = [];
    const ok: RunGhFn = (cmd) => {
      calls.push(cmd);
      return {
        returncode: 0,
        stdout: "added\txbrief/active/a.xbrief.json\nmodified\tsrc/a b.ts\n",
        stderr: "",
      };
    };
    expect(defaultFetchPrChangedFiles(7, "o/r", ok)).toEqual([
      { status: "added", filename: "xbrief/active/a.xbrief.json" },
      { status: "modified", filename: "src/a b.ts" },
    ]);
    expect(calls[0]).toContain("--paginate");
    expect(calls[0]?.join(" ")).toContain("repos/o/r/pulls/7/files");
    expect(
      defaultFetchPrChangedFiles(7, "o/r", () => ({ returncode: 1, stdout: "", stderr: "x" })),
    ).toBeNull();
    expect(
      defaultFetchPrChangedFiles(7, "o/r", () => ({
        returncode: 0,
        stdout: "garbage\n",
        stderr: "",
      })),
    ).toBeNull();
    expect(defaultFetchPrChangedFiles(7, "not-a-repo", ok)).toBeNull();
    expect(
      defaultFetchPrChangedFiles(7, "o/r", () => {
        throw new Error("spawn failed");
      }),
    ).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// #5710 Prefer-A Recut-13: PR-only identity, merge-time association, P4 refuse
// ---------------------------------------------------------------------------

const REPO = "deftai/directive";
const MERGED_AT = "2026-11-12T10:00:00Z";
const BEFORE = "2026-11-12T09:00:00Z";
const AFTER = "2026-11-12T11:00:00Z";
const PRODUCT_FILE: PrFileEntry = { status: "modified", filename: "packages/core/src/x.ts" };

/** gitOk plus a canonical `origin` remote (#5710 P1). */
function gitWithOrigin(url: string | null = `https://github.com/${REPO}.git`): GitRunner {
  const base = gitOk();
  return (root, args) => {
    if (args.join(" ") === "remote get-url origin") {
      return url === null
        ? { code: 2, stdout: "", stderr: "No such remote" }
        : { code: 0, stdout: `${url}\n`, stderr: "" };
    }
    return base(root, args);
  };
}

function mergedPayload(opts?: {
  body?: string;
  mergedAt?: string | null;
  mergeCommitSha?: string;
  base?: string;
}): Record<string, unknown> {
  const mergedAt = opts?.mergedAt === undefined ? MERGED_AT : opts.mergedAt;
  return {
    merged_at: mergedAt,
    merge_commit_sha: mergedAt === null ? null : (opts?.mergeCommitSha ?? "mergesha"),
    base: { ref: opts?.base ?? "master" },
    head: { sha: "headsha" },
    body: opts?.body ?? "",
  };
}

function payloadFor(prs: Record<number, Record<string, unknown>>): FetchPrPayloadFn {
  return (n, repo) => (repo === REPO ? (prs[n] ?? null) : null);
}

function issuePlan(issue = 6212, extra?: Record<string, unknown>): Record<string, unknown> {
  return {
    title: "issue story",
    status: "running",
    references: [
      { uri: `https://github.com/${REPO}/issues/${issue}`, type: "x-xbrief/github-issue" },
    ],
    metadata: { kind: "story", swarm: { file_scope: ["packages/core/src/x.ts"] }, ...extra },
    items: [],
  };
}

function prOnlyPlan(stamp: number | null, refs: unknown[] = []): Record<string, unknown> {
  return {
    title: "pr-only story",
    status: "running",
    references: refs,
    metadata: {
      kind: "story",
      swarm: { file_scope: ["packages/core/src/x.ts"] },
      ...(stamp === null ? {} : { productPullRequest: stamp }),
    },
    items: [],
  };
}

function listed(
  number: number,
  body: string,
  opts?: { mergedAt?: string; lastEditedAt?: string | null },
): MergedPrListNode {
  return {
    number,
    body,
    mergedAt: opts?.mergedAt ?? MERGED_AT,
    lastEditedAt: opts?.lastEditedAt ?? null,
  };
}

function joinIssue(opts: {
  plan?: Record<string, unknown>;
  pr: number;
  body: string;
  forge: MergeTimeForge;
  mergedAt?: string;
}) {
  return verifyStoryPrMergeIdentity({
    plan: opts.plan ?? issuePlan(),
    evidence: { prNumber: opts.pr },
    mergeCommit: "mergesha",
    fetchPrPayload: payloadFor({
      [opts.pr]: mergedPayload({ body: opts.body, mergedAt: opts.mergedAt }),
    }),
    mergeTimeForge: opts.forge,
  });
}

describe("PR-only delivery identity (#5710 P1)", () => {
  let root = "";
  afterEach(() => {
    if (root.length > 0) {
      rmSync(root, { recursive: true, force: true });
      root = "";
    }
  });

  const canonical = () => REPO;

  it("clause.1: joins (canonical remote, productPullRequest) when --pr, merge state and merge sha match", () => {
    const fetchPrPayload = payloadFor({ 6215: mergedPayload() });
    const ok = verifyStoryPrMergeIdentity({
      plan: prOnlyPlan(6215),
      evidence: { prNumber: 6215 },
      mergeCommit: "MERGESHA",
      fetchPrPayload,
      resolveCanonicalRepository: canonical,
    });
    expect(ok.ok).toBe(true);
    expect(ok.identityBasis).toBe("pr-only");
    expect(ok.repository).toBe(REPO);

    const refuse = (input: Partial<Parameters<typeof verifyStoryPrMergeIdentity>[0]>) =>
      verifyStoryPrMergeIdentity({
        plan: prOnlyPlan(6215),
        evidence: { prNumber: 6215 },
        mergeCommit: "mergesha",
        fetchPrPayload,
        resolveCanonicalRepository: canonical,
        ...input,
      });
    expect(refuse({ evidence: { prNumber: 6214 } }).message).toMatch(
      /--pr 6214 is not plan.metadata.productPullRequest 6215/,
    );
    expect(refuse({ evidence: {} }).message).toMatch(/needs --pr 6215/);
    expect(refuse({ mergeCommit: "othersha" }).message).toMatch(/merge_commit_sha/);
    expect(
      refuse({ fetchPrPayload: payloadFor({ 6215: mergedPayload({ mergedAt: null }) }) }).message,
    ).toMatch(/is not merged/);
    expect(refuse({ evidence: { prNumber: 6215, repository: "other/repo" } }).message).toMatch(
      /matching assertion only/,
    );
    expect(refuse({ resolveCanonicalRepository: () => null }).message).toMatch(
      /canonical project remote/,
    );
    expect(refuse({ resolveCanonicalRepository: undefined }).ok).toBe(false);
    expect(refuse({ plan: prOnlyPlan(null) }).message).toMatch(
      /no plan.metadata.productPullRequest/,
    );
    // --repo that matches is an assertion only; it never supplies the repository.
    expect(refuse({ evidence: { prNumber: 6215, repository: REPO } }).ok).toBe(true);
  });

  it("clause.1: scope:complete completes an issue-less stamped brief and refuses a mismatched --pr", () => {
    root = makeRepo();
    const name = "pr-only.xbrief.json";
    const write = () => {
      const path = join(root, "xbrief", "active", name);
      writeFileSync(
        path,
        JSON.stringify({ xBRIEFInfo: { version: "0.8" }, plan: prOnlyPlan(6215) }),
      );
      return path;
    };
    const opts = (pr: number) => ({
      runGit: gitWithOrigin(),
      fetchPrPayload: payloadFor({ 6215: mergedPayload(), 6214: mergedPayload() }),
      deliveryEvidence: { prNumber: pr, mergeCommit: "mergesha", mergedAt: MERGED_AT },
    });
    const path = write();
    const refused = runTransition("complete", path, new Date(AFTER), opts(6214));
    expect(refused.ok).toBe(false);
    expect(existsSync(path)).toBe(true);

    const done = runTransition("complete", path, new Date(AFTER), opts(6215));
    expect(done.ok).toBe(true);
    const data = JSON.parse(readFileSync(join(root, "xbrief", "completed", name), "utf8")) as {
      plan: { metadata: { completionProvenance: Record<string, unknown> } };
    };
    expect(data.plan.metadata.completionProvenance).toMatchObject({
      repository: REPO,
      prNumber: 6215,
      identityBasis: "pr-only",
      disposition: "delivered",
    });
  });

  it("clause.2: discovery derives the same PR-only tuple and keeps the delivery-base filter", () => {
    root = makeRepo();
    const found = discoverDeliveryEvidenceForComplete({
      projectRoot: root,
      plan: prOnlyPlan(6215),
      runGit: gitWithOrigin(),
      fetchPrPayload: payloadFor({ 6215: mergedPayload() }),
    });
    expect(found.ok).toBe(true);
    if (!found.ok) return;
    expect(found.discovered).toBe(true);
    expect(found.evidence).toMatchObject({
      repository: REPO,
      prNumber: 6215,
      mergeCommit: "mergesha",
    });

    const integration = discoverDeliveryEvidenceForComplete({
      projectRoot: root,
      plan: prOnlyPlan(6215),
      runGit: gitWithOrigin(),
      fetchPrPayload: payloadFor({ 6215: mergedPayload({ base: "develop" }) }),
    });
    expect(integration.ok).toBe(false);
    if (!integration.ok) expect(integration.message).toMatch(/not a merged delivery-base PR/);

    const noRemote = discoverDeliveryEvidenceForComplete({
      projectRoot: root,
      plan: prOnlyPlan(6215),
      runGit: gitWithOrigin(null),
      fetchPrPayload: payloadFor({ 6215: mergedPayload() }),
    });
    expect(noRemote.ok).toBe(false);
    if (!noRemote.ok) expect(noRemote.message).toMatch(/canonical project remote/);
  });

  it("clause.3: x-xbrief/github-pr is redundant when it matches the stamp and never an identity", () => {
    const fetchPrPayload = payloadFor({ 6214: mergedPayload(), 6215: mergedPayload() });
    const prRef = (n: number) => ({
      uri: `https://github.com/${REPO}/pull/${n}`,
      type: "x-xbrief/github-pr",
    });
    const join = (plan: Record<string, unknown>, pr: number) =>
      verifyStoryPrMergeIdentity({
        plan,
        evidence: { prNumber: pr },
        mergeCommit: "mergesha",
        fetchPrPayload,
        resolveCanonicalRepository: canonical,
      });
    expect(join(prOnlyPlan(6215, [prRef(6215)]), 6215).ok).toBe(true);
    // A different historical PR ref neither overrides nor invalidates the stamp.
    expect(join(prOnlyPlan(6215, [prRef(6214)]), 6215).ok).toBe(true);
    const historical = join(prOnlyPlan(6215, [prRef(6214)]), 6214);
    expect(historical.ok).toBe(false);
    expect(historical.message).toMatch(/does not override/);
    // Unstamped: github-pr alone is not identity.
    const unstamped = join(prOnlyPlan(null, [prRef(6215)]), 6215);
    expect(unstamped.ok).toBe(false);
    expect(unstamped.message).toMatch(/github-pr reference is not a delivery identity/);
    // Today's resolver: an issue URL under any reference type makes the brief issue-anchored.
    const anchored = issuePlan(5710);
    anchored.references = [
      { uri: `https://github.com/${REPO}/issues/5710`, type: "x-xbrief/refs" },
    ];
    expect(resolvePlanGithubIssueRef(anchored)).toEqual({ repository: REPO, issueNumber: 5710 });
    expect(resolvePrOnlyDeliveryIdentity(prOnlyPlan(6215), canonical)).toEqual({
      ok: true,
      repository: REPO,
      prNumber: 6215,
    });
  });

  it("resolveCanonicalProjectRepository reads the origin remote only", () => {
    expect(resolveCanonicalProjectRepository("/x", gitWithOrigin())).toBe(REPO);
    expect(
      resolveCanonicalProjectRepository("/x", gitWithOrigin(`git@github.com:${REPO}.git`)),
    ).toBe(REPO);
    expect(resolveCanonicalProjectRepository("/x", gitWithOrigin(null))).toBeNull();
    expect(
      resolveCanonicalProjectRepository("/x", () => {
        throw new Error("spawn");
      }),
    ).toBeNull();
  });
});

describe("merge-time association (#5710 P3)", () => {
  it("clause.5: accepts a merge-time sole mark, closing keyword, or Connected link", () => {
    expect(
      joinIssue({ pr: 6215, body: "deft-story: 6212", forge: makeForge({}) }).identityBasis,
    ).toBe("merge-time-mark");
    expect(joinIssue({ pr: 6215, body: "Fixes #6212", forge: makeForge({}) }).identityBasis).toBe(
      "merge-time-keyword",
    );
    const connected = makeForge({
      events: {
        6215: [
          {
            kind: "connected",
            createdAt: BEFORE,
            issues: [{ repository: REPO, issueNumber: 6212 }],
          },
        ],
      },
    });
    expect(joinIssue({ pr: 6215, body: "Refs #6212", forge: connected }).identityBasis).toBe(
      "merge-time-connected",
    );
  });

  it("clause.5: a mark or keyword added only after merged_at does not count", () => {
    for (const late of ["Closes #6212", "deft-story: 6212"]) {
      const forge = makeForge({
        revisions: {
          6215: [
            { editedAt: BEFORE, body: "Refs #6212" },
            { editedAt: AFTER, body: late },
          ],
        },
      });
      const result = joinIssue({ pr: 6215, body: late, forge });
      expect(result.ok).toBe(false);
      expect(result.message).toMatch(/no merge-time association/);
    }
    // A Connected link made after merge, or one disconnected before merge, does not count.
    const ref = [{ repository: REPO, issueNumber: 6212 }];
    const lateLink = makeForge({
      events: { 6215: [{ kind: "connected", createdAt: AFTER, issues: ref }] },
    });
    expect(joinIssue({ pr: 6215, body: "", forge: lateLink }).ok).toBe(false);
    const unlinked = makeForge({
      events: {
        6215: [
          { kind: "connected", createdAt: "2026-11-12T08:00:00Z", issues: ref },
          { kind: "disconnected", createdAt: BEFORE, issues: ref },
        ],
      },
    });
    expect(joinIssue({ pr: 6215, body: "", forge: unlinked }).ok).toBe(false);
    // A keyword removed after merge still counts: the merge-time revision is read.
    const removed = makeForge({
      revisions: {
        6215: [
          { editedAt: BEFORE, body: "Closes #6212" },
          { editedAt: AFTER, body: "" },
        ],
      },
    });
    expect(joinIssue({ pr: 6215, body: "", forge: removed }).identityBasis).toBe(
      "merge-time-keyword",
    );
  });

  it("clause.5: current-state closingIssuesReferences alone is insufficient", () => {
    const result = evaluateDeliveryGate({
      projectRoot: makeRepo(),
      plan: issuePlan(),
      nowIso: AFTER,
      evidence: { prNumber: 6215, mergeCommit: "mergesha", mergedAt: MERGED_AT },
      fetchPrPayload: payloadFor({ 6215: mergedPayload({ body: "" }) }),
      fetchClosingIssueIds: () => [{ repository: REPO, issueNumber: 6212 }],
      mergeTimeForge: makeForge({}),
      runGit: gitOk(),
      assumeEvidenceValidated: true,
    } as Parameters<typeof evaluateDeliveryGate>[0]);
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/closingIssuesReferences alone is insufficient/);
  });

  it("clause.5: closing keyword forms and look-alikes", () => {
    for (const body of [
      "Closes #6212",
      "fixed: #6212",
      "RESOLVES deftai/directive#6212",
      "close https://github.com/deftai/directive/issues/6212",
      "Fix DeftAI/Directive#6212.",
    ]) {
      expect(bodyHasClosingKeywordFor(body, REPO, 6212)).toBe(true);
    }
    for (const body of [
      "Refs #6212",
      "Closes #62120",
      "Closes other/repo#6212",
      "Closes https://github.com/other/repo/issues/6212",
      "preclosed #6212",
      "deft-story: 6212",
    ]) {
      expect(bodyHasClosingKeywordFor(body, REPO, 6212)).toBe(false);
    }
  });

  it("selectMergeTimeBody and connectedAtMergedAt fail closed on unreadable history", () => {
    expect(selectMergeTimeBody([], "current", MERGED_AT)).toEqual({ ok: true, body: "current" });
    expect(selectMergeTimeBody([], null, MERGED_AT)).toEqual({ ok: true, body: "" });
    expect(selectMergeTimeBody([{ editedAt: AFTER, body: "x" }], "x", MERGED_AT).ok).toBe(false);
    expect(selectMergeTimeBody([{ editedAt: BEFORE, body: null }], "x", MERGED_AT).ok).toBe(false);
    expect(selectMergeTimeBody([{ editedAt: "nope", body: "x" }], "x", MERGED_AT).ok).toBe(false);
    expect(selectMergeTimeBody([], "x", "nope").ok).toBe(false);
    const ref = [{ repository: REPO, issueNumber: 1 }];
    expect(
      connectedAtMergedAt(
        [{ kind: "connected", createdAt: "bad", issues: ref }],
        REPO,
        1,
        MERGED_AT,
      ).ok,
    ).toBe(false);
    expect(connectedAtMergedAt([], REPO, 1, "bad").ok).toBe(false);
    expect(
      connectedAtMergedAt(
        [{ kind: "connected", createdAt: BEFORE, issues: [{ repository: "o/r", issueNumber: 1 }] }],
        REPO,
        1,
        MERGED_AT,
      ),
    ).toEqual({ ok: true, connected: false });
  });

  it("clause.7: the stranded shape refuses and names the three accepted bases", () => {
    const stranded = joinIssue({
      pr: 6148,
      plan: issuePlan(6147),
      body: "Refs #6147",
      forge: makeForge({}),
    });
    expect(stranded.ok).toBe(false);
    expect(stranded.message).toMatch(/\(a\) a unique sole `deft-story: N` mark/);
    expect(stranded.message).toMatch(/\(b\) a closing keyword/);
    expect(stranded.message).toMatch(/\(c\) a Connected issue link/);
    expect(stranded.message).toMatch(/identity-migration/);
    // No forge at all: still fails closed with the same named bases.
    const noForge = verifyStoryPrMergeIdentity({
      plan: issuePlan(6147),
      evidence: { prNumber: 6148 },
      mergeCommit: "mergesha",
      fetchPrPayload: payloadFor({ 6148: mergedPayload({ body: "Closes #6147" }) }),
    });
    expect(noForge.ok).toBe(false);
    expect(noForge.message).toMatch(/Accepted bases: \(a\)/);
  });

  it("clause.8: productPullRequest === --pr is not an identity proof on the issue-anchored path", () => {
    const stamped = joinIssue({
      plan: issuePlan(6212, { productPullRequest: 6215 }),
      pr: 6215,
      body: "Refs #6212",
      forge: makeForge({}),
    });
    const unstamped = joinIssue({
      plan: issuePlan(6212),
      pr: 6215,
      body: "Refs #6212",
      forge: makeForge({}),
    });
    expect(stamped.ok).toBe(false);
    expect(stamped).toEqual(unstamped);
    // A failed issue-anchored check never falls back to the PR-only path.
    expect(stamped.message).not.toMatch(/pr-only|canonical project remote/);
  });
});

describe("sole-mark uniqueness scan (#5710 P3)", () => {
  const mark = "deft-story: 6212";
  const briefOnly: PrFileEntry[] = [
    { status: "modified", filename: "xbrief/active/2026-11-12-6212-x.xbrief.json" },
  ];
  const briefAndChangelog: PrFileEntry[] = [
    ...briefOnly,
    { status: "modified", filename: "CHANGELOG.md" },
  ];
  const completedRename: PrFileEntry[] = [
    {
      status: "renamed",
      filename: "xbrief/completed/2026-11-12-6212-x.xbrief.json",
      previousFilename: "xbrief/active/2026-11-12-6212-x.xbrief.json",
    },
  ];

  it("clause.6: #6212 shape — product #6215 passes when only brief-land PRs #6214/#6216 share the mark", () => {
    const forge = makeForge({
      merged: [listed(6214, mark), listed(6215, mark), listed(6216, mark), listed(6217, mark)],
      files: { 6214: briefOnly, 6216: briefAndChangelog, 6217: completedRename },
    });
    const result = joinIssue({ pr: 6215, body: mark, forge });
    expect(result.ok).toBe(true);
    expect(result.identityBasis).toBe("merge-time-mark");
    // Brief-land PRs are themselves excluded candidates and refuse even alone.
    const alone = joinIssue({
      pr: 6214,
      body: mark,
      forge: makeForge({ files: { 6214: briefOnly } }),
    });
    expect(alone.ok).toBe(false);
    expect(alone.message).toMatch(/delivery-brief-land excluded/);
  });

  it("clause.6: two non-excluded sole-mark PRs both refuse", () => {
    const forge = makeForge({ merged: [listed(10, mark), listed(11, mark)] });
    for (const [pr, other] of [
      [10, 11],
      [11, 10],
    ] as const) {
      const result = joinIssue({ pr, body: mark, forge });
      expect(result.ok).toBe(false);
      expect(result.message).toMatch(new RegExp(`#${other} also carry a sole`));
    }
  });

  it("clause.6: multi-story mark PRs (#6208 / #6213 shape) are sole for no story", () => {
    const multi = "deft-story: 5710\ndeft-story: 5882\ndeft-story: 6203";
    expect(soleDeftStoryMark(multi)).toBeNull();
    expect(soleDeftStoryMark("deft-story: 6212\n deft-story: 6212 ")).toBe(6212);
    const candidate = joinIssue({
      pr: 6208,
      plan: issuePlan(5710),
      body: multi,
      forge: makeForge({}),
    });
    expect(candidate.ok).toBe(false);
    // As a would-be competitor it is ignored, so the product PR still passes.
    const forge = makeForge({
      merged: [listed(6208, multi), listed(6213, multi), listed(9000, "deft-story: 5710")],
    });
    expect(joinIssue({ pr: 9000, plan: issuePlan(5710), body: "deft-story: 5710", forge }).ok).toBe(
      true,
    );
  });

  it("clause.6: a competing mark removed after merge still competes (merge-time body)", () => {
    const forge = makeForge({
      merged: [listed(20, "", { lastEditedAt: AFTER })],
      revisions: {
        20: [
          { editedAt: BEFORE, body: mark },
          { editedAt: AFTER, body: "" },
        ],
      },
    });
    const result = joinIssue({ pr: 21, body: mark, forge });
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/#20 also carry/);
    // Unreconstructable merge-time body of a listed PR is an unknown: refuse.
    const hidden = makeForge({
      merged: [listed(20, "", { lastEditedAt: AFTER })],
      revisionsFail: [20],
    });
    expect(joinIssue({ pr: 21, body: mark, forge: hidden }).message).toMatch(/uniqueness unknown/);
    // An edit before merge needs no replay: the current body is the merge-time body.
    const preMerge = makeForge({ merged: [listed(20, "Refs #6212", { lastEditedAt: BEFORE })] });
    expect(joinIssue({ pr: 21, body: mark, forge: preMerge }).ok).toBe(true);
    expect(preMerge.calls).not.toContain("revisions:20");
  });

  it("clause.6: finds a duplicate beyond the first page", () => {
    const merged = [1, 2, 3, 4, 5].map((n) => listed(n, n === 5 ? mark : ""));
    const forge = makeForge({ merged, pageSize: 2 });
    const result = joinIssue({ pr: 99, body: mark, forge });
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/#5 also carry/);
    expect(forge.calls).toEqual(expect.arrayContaining(["list:0", "list:1", "list:2"]));
  });

  it("clause.6: refuses on an incomplete page, unreadable competitor or truncated listing", () => {
    const merged = [1, 2, 3].map((n) => listed(n, n === 3 ? mark : ""));
    const cases: ForgeFixture[] = [
      { merged, pageSize: 1, listFailAtPage: 1 },
      { merged, pageSize: 1, listBrokenCursorAtPage: 1 },
      { merged, files: { 3: "fail" } },
      {
        merged,
        files: {
          3: Array.from({ length: PR_FILES_LISTING_CAP }, (_, i) => ({
            status: "added",
            filename: `src/f${i}.ts`,
          })),
        },
      },
    ];
    for (const fixture of cases) {
      const result = joinIssue({ pr: 99, body: mark, forge: makeForge(fixture) });
      expect(result.ok).toBe(false);
      expect(result.message).toMatch(/uniqueness unknown, refusing/);
    }
    // A candidate whose own files cannot be read or are truncated also refuses.
    expect(joinIssue({ pr: 99, body: mark, forge: makeForge({ files: { 99: "fail" } }) }).ok).toBe(
      false,
    );
  });

  it("clause.6: refuses when the budget is exhausted before every merged PR is classified", () => {
    const merged = [listed(1, ""), listed(2, "")];
    const budgets: ForgeFixture[] = [
      { merged, rates: [{ graphqlRemaining: 199, coreRemaining: 5000 }] },
      { merged, rates: [null] },
      // Mark hit needs a REST files read: core below 100 refuses.
      {
        merged: [listed(1, mark)],
        rates: [
          { graphqlRemaining: 5000, coreRemaining: 5000 },
          { graphqlRemaining: 5000, coreRemaining: 5000 },
          { graphqlRemaining: 5000, coreRemaining: 5000 },
          { graphqlRemaining: 5000, coreRemaining: 99 },
        ],
      },
      { merged, clockStepMs: MERGE_TIME_SCAN_WALL_CLOCK_MS },
    ];
    for (const fixture of budgets) {
      const result = joinIssue({ pr: 99, body: mark, forge: makeForge(fixture) });
      expect(result.ok).toBe(false);
      expect(result.message).toMatch(/scan budget (exhausted|unknown)/);
    }
  });

  it("isDeliveryBriefLandExcluded differs from activation brief-land shape", () => {
    expect(isDeliveryBriefLandExcluded([{ status: "modified", filename: "CHANGELOG.md" }])).toBe(
      true,
    );
    expect(isDeliveryBriefLandExcluded(completedRename)).toBe(true);
    expect(
      isDeliveryBriefLandExcluded([{ status: "removed", filename: "vbrief/pending/a.json" }]),
    ).toBe(true);
    expect(isDeliveryBriefLandExcluded([])).toBe(true);
    expect(isDeliveryBriefLandExcluded([...briefOnly, PRODUCT_FILE])).toBe(false);
    expect(
      isDeliveryBriefLandExcluded([
        { status: "renamed", filename: "xbrief/active/a.json", previousFilename: "docs/a.json" },
      ]),
    ).toBe(false);
    expect(isDeliveryBriefLandExcluded([{ status: "added", filename: "docs/active/a.json" }])).toBe(
      false,
    );
  });

  it("scanSoleMarkCompetitors skips the candidate and reports excluded hits as non-competitors", () => {
    const forge = makeForge({
      merged: [listed(1, mark), listed(2, mark), listed(3, "deft-story: 1")],
      files: { 2: briefOnly },
    });
    expect(
      scanSoleMarkCompetitors({ repository: REPO, issueNumber: 6212, candidatePr: 1, forge }),
    ).toEqual({
      ok: true,
      competitors: [],
    });
    expect(
      scanSoleMarkCompetitors({
        repository: REPO,
        issueNumber: 6212,
        candidatePr: 9,
        forge: makeForge({ merged: [listed(1, mark)] }),
      }),
    ).toEqual({ ok: true, competitors: [1] });
  });
});

describe("default merge-time forge (#5710)", () => {
  function gh(responses: Record<string, unknown>): RunGhFn & { calls: string[][] } {
    const calls: string[][] = [];
    const fn = ((cmd: readonly string[]) => {
      calls.push([...cmd]);
      const joined = cmd.join(" ");
      for (const [needle, value] of Object.entries(responses)) {
        if (joined.includes(needle)) {
          if (value === "FAIL") return { returncode: 1, stdout: "", stderr: "boom" };
          return {
            returncode: 0,
            stdout: typeof value === "string" ? value : JSON.stringify(value),
            stderr: "",
          };
        }
      }
      return { returncode: 1, stdout: "", stderr: `unexpected ${joined}` };
    }) as RunGhFn & { calls: string[][] };
    fn.calls = calls;
    return fn;
  }
  const page = (
    key: string,
    nodes: unknown[],
    hasNextPage = false,
    endCursor: string | null = null,
  ) => ({
    data: { repository: { [key]: { pageInfo: { hasNextPage, endCursor }, nodes } } },
  });

  it("parses merged-PR, revision and connection-event pages", () => {
    const run = gh({
      "pullRequests(": page(
        "pullRequests",
        [{ number: 1, mergedAt: MERGED_AT, body: null, lastEditedAt: null }],
        true,
        "c1",
      ),
      userContentEdits: {
        data: {
          repository: {
            pullRequest: {
              userContentEdits: {
                pageInfo: { hasNextPage: false, endCursor: null },
                nodes: [
                  { editedAt: BEFORE, deletedAt: null, diff: "body" },
                  { editedAt: AFTER, deletedAt: AFTER, diff: "gone" },
                ],
              },
            },
          },
        },
      },
      timelineItems: {
        data: {
          repository: {
            pullRequest: {
              timelineItems: {
                pageInfo: { hasNextPage: false, endCursor: null },
                nodes: [
                  {
                    __typename: "ConnectedEvent",
                    createdAt: BEFORE,
                    source: { __typename: "PullRequest" },
                    subject: {
                      __typename: "Issue",
                      number: 7,
                      repository: { nameWithOwner: REPO },
                    },
                  },
                  {
                    __typename: "DisconnectedEvent",
                    createdAt: AFTER,
                    source: { __typename: "Issue", number: 7, repository: { nameWithOwner: REPO } },
                    subject: { __typename: "PullRequest" },
                  },
                ],
              },
            },
          },
        },
      },
    });
    const forge = defaultMergeTimeForge(run);
    expect(forge.listMergedPrsPage(REPO, null)).toEqual({
      ok: true,
      nodes: [{ number: 1, mergedAt: MERGED_AT, body: "", lastEditedAt: null }],
      hasNextPage: true,
      endCursor: "c1",
    });
    expect(forge.fetchBodyRevisionsPage(REPO, 1, "c0")).toMatchObject({
      ok: true,
      nodes: [
        { editedAt: BEFORE, body: "body" },
        { editedAt: AFTER, body: null },
      ],
    });
    expect(run.calls.at(-1)).toEqual(expect.arrayContaining(["after=c0", "number=1"]));
    expect(forge.fetchConnectionEventsPage(REPO, 1, null)).toMatchObject({
      ok: true,
      nodes: [
        { kind: "connected", issues: [{ repository: REPO, issueNumber: 7 }] },
        { kind: "disconnected", issues: [{ repository: REPO, issueNumber: 7 }] },
      ],
    });
    expect(forge.listMergedPrsPage("bad", null).ok).toBe(false);
    expect(forge.fetchBodyRevisionsPage("bad", 1, null).ok).toBe(false);
    expect(forge.fetchConnectionEventsPage("bad", 1, null).ok).toBe(false);
    expect(typeof forge.nowMs()).toBe("number");
  });

  it("fails closed on GraphQL errors, missing pageInfo, bad nodes and gh failures", () => {
    const cases: unknown[] = [
      "FAIL",
      "not json",
      { errors: [{ message: "x" }], data: null },
      { data: null },
      { data: { repository: { pullRequests: { nodes: [] } } } },
      page("pullRequests", [{ number: "x" }]),
    ];
    for (const value of cases) {
      expect(
        defaultMergeTimeForge(gh({ "pullRequests(": value })).listMergedPrsPage(REPO, null).ok,
      ).toBe(false);
    }
    const throws: RunGhFn = () => {
      throw new Error("spawn");
    };
    expect(defaultMergeTimeForge(throws).listMergedPrsPage(REPO, null).ok).toBe(false);
  });

  it("lists changed files with rename sources and refuses an incomplete listing", () => {
    const ok = gh({
      "/files": "renamed\txbrief/completed/a.json\txbrief/active/a.json\nmodified\tsrc/a.ts\t\n",
      "pulls/5": { changed_files: 2 },
    });
    expect(defaultMergeTimeForge(ok).fetchPrFiles(REPO, 5)).toEqual({
      ok: true,
      files: [
        {
          status: "renamed",
          filename: "xbrief/completed/a.json",
          previousFilename: "xbrief/active/a.json",
        },
        { status: "modified", filename: "src/a.ts" },
      ],
    });
    const short = gh({ "/files": "modified\tsrc/a.ts\t\n", "pulls/5": { changed_files: 3000 } });
    expect(defaultMergeTimeForge(short).fetchPrFiles(REPO, 5)).toMatchObject({
      ok: false,
      error: expect.stringMatching(/truncated/),
    });
    expect(defaultMergeTimeForge(gh({ "pulls/5": {} })).fetchPrFiles(REPO, 5).ok).toBe(false);
    expect(
      defaultMergeTimeForge(gh({ "/files": "FAIL", "pulls/5": { changed_files: 1 } })).fetchPrFiles(
        REPO,
        5,
      ).ok,
    ).toBe(false);
    expect(
      defaultMergeTimeForge(
        gh({ "/files": "garbage\n", "pulls/5": { changed_files: 1 } }),
      ).fetchPrFiles(REPO, 5).ok,
    ).toBe(false);
    expect(defaultMergeTimeForge(ok).fetchPrFiles("bad", 5).ok).toBe(false);
  });

  it("reads the live rate limit and returns null on any failure", () => {
    const ok = gh({
      rate_limit: { resources: { core: { remaining: 4000 }, graphql: { remaining: 300 } } },
    });
    expect(defaultMergeTimeForge(ok).probeRateLimit()).toEqual({
      graphqlRemaining: 300,
      coreRemaining: 4000,
    });
    expect(defaultMergeTimeForge(gh({ rate_limit: "FAIL" })).probeRateLimit()).toBeNull();
    expect(defaultMergeTimeForge(gh({ rate_limit: "nope" })).probeRateLimit()).toBeNull();
    expect(
      defaultMergeTimeForge(gh({ rate_limit: { resources: {} } })).probeRateLimit(),
    ).toBeNull();
  });
});

describe("non-delivery refuse for a merged stamped PR (#5710 P4)", () => {
  let root = "";
  afterEach(() => {
    if (root.length > 0) {
      rmSync(root, { recursive: true, force: true });
      root = "";
    }
  });

  const gate = (
    plan: Record<string, unknown>,
    fetchPrPayload: FetchPrPayloadFn,
    runGit = gitWithOrigin(),
  ) =>
    evaluateDeliveryGate({
      projectRoot: root,
      plan,
      nowIso: AFTER,
      nonDeliveryDisposition: "cancelled",
      fetchPrPayload,
      runGit,
    });

  it("clause.9: refuses when the stamped PR is merged, including to an integration branch", () => {
    root = makeRepo();
    const stamped = issuePlan(6212, { productPullRequest: 6215 });
    const merged = gate(stamped, payloadFor({ 6215: mergedPayload() }));
    expect(merged.ok).toBe(false);
    expect(merged.message).toMatch(
      /stamped productPullRequest #6215 in deftai\/directive is merged/,
    );
    expect(merged.provenance).toBeNull();
    expect(gate(stamped, payloadFor({ 6215: mergedPayload({ base: "develop" }) })).ok).toBe(false);
    // PR-only brief resolves the stamp in the canonical remote.
    expect(gate(prOnlyPlan(6215), payloadFor({ 6215: mergedPayload() })).ok).toBe(false);
  });

  it("clause.9: fails closed when merge state cannot be established", () => {
    root = makeRepo();
    const stamped = issuePlan(6212, { productPullRequest: 6215 });
    for (const fetch of [
      payloadFor({}),
      payloadFor({ 6215: { base: { ref: "master" } } }),
      payloadFor({ 6215: { merged_at: 12 } }),
      payloadFor({ 6215: { merged_at: " " } }),
      (() => {
        throw new Error("timeout");
      }) as FetchPrPayloadFn,
    ]) {
      const result = gate(stamped, fetch);
      expect(result.ok).toBe(false);
      expect(result.message).toMatch(
        /could not establish whether stamped productPullRequest #6215/,
      );
    }
    const noRemote = gate(
      prOnlyPlan(6215),
      payloadFor({ 6215: mergedPayload() }),
      gitWithOrigin(null),
    );
    expect(noRemote.ok).toBe(false);
    expect(noRemote.message).toMatch(/cannot resolve the repository/);
  });

  it("clause.9: a confirmed unmerged stamp, or no stamp, keeps the non-delivery path", () => {
    root = makeRepo();
    const unmerged = gate(
      issuePlan(6212, { productPullRequest: 6215 }),
      payloadFor({ 6215: mergedPayload({ mergedAt: null }) }),
    );
    expect(unmerged.ok).toBe(true);
    expect(unmerged.provenance?.disposition).toBe("cancelled");
    const unstamped = gate(issuePlan(6212), () => {
      throw new Error("no lookup without a stamp");
    });
    expect(unstamped.ok).toBe(true);
  });

  it("clause.9: scope:complete records nothing when it refuses a non-delivery disposition", () => {
    root = makeRepo();
    const path = join(root, "xbrief", "active", "stamped.xbrief.json");
    const raw = JSON.stringify({
      xBRIEFInfo: { version: "0.8" },
      plan: issuePlan(6212, { productPullRequest: 6215 }),
    });
    writeFileSync(path, raw);
    for (const fetchPrPayload of [payloadFor({ 6215: mergedPayload() }), payloadFor({})]) {
      const result = runTransition("complete", path, new Date(AFTER), {
        runGit: gitWithOrigin(),
        nonDeliveryDisposition: "superseded",
        fetchPrPayload,
      });
      expect(result.ok).toBe(false);
      expect(readFileSync(path, "utf8")).toBe(raw);
      expect(existsSync(join(root, "xbrief", "completed", "stamped.xbrief.json"))).toBe(false);
    }
  });
});
