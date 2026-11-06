import { describe, expect, it } from "vitest";
import {
  completeRun,
  interruptRun,
  markComplete,
  noteSkillFileOpen,
  observeCommandPhase,
  startControllerRun,
  submitReviewerReport,
} from "./controller.js";
import { bumpGeneration, digestApprovedCriteria } from "./criteria.js";
import {
  canReuseCommandResult,
  evaluateLivePrePrCheck,
  evaluatePrePrEvidence,
} from "./evaluate.js";
import { PRE_PR_PHASES, RENDER_EXPORT_RULE } from "./phases.js";
import { InProcessPrePrStore, mintPublisher, writePrePrRecordDisk } from "./store.js";
import {
  CHECKBOX_NOT_AUTHORITY,
  DISK_STORE_NOT_SOT,
  MARK_COMPLETE_NOT_AUTHORITY,
  ONE_PR_UNIT_NOT_PRE_PR,
  type PrePrExecutionRecord,
  RUN_ID_LOOKUP_HINT,
  SKILL_FILE_OPEN_NOT_COMPLETION,
} from "./types.js";

const REPO = "deftai/directive";
const BASE = "9dc0c3f6cc8108e5caf09b231694bf1af755ec0b";
const HEAD = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const TREE = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const BODY = "pr-body-hash-identical";
const PR_NODE = "PR_kwDOTest4912";

const approved = digestApprovedCriteria({
  sourceRevisionSha: BASE,
  scopePaths: ["packages/core/src/pre-pr-controller/fixture-scope.ts"],
  acceptanceText: "controller-issued completion record matches live PR binding",
  generation: 1,
});

function startPassingRun(
  store: InProcessPrePrStore,
  runId = "ppr_same",
  prNodeId: string | null = PR_NODE,
): string {
  const started = startControllerRun(store, {
    repo: REPO,
    baseSha: BASE,
    headSha: HEAD,
    treeHash: TREE,
    prBodyHash: BODY,
    prNodeId,
    criteria: approved,
    skillVersion: "0.1",
    policyVersion: "1",
    approvedRevisionSha: BASE,
    runId,
  });
  const id = started.runId as string;
  const record = store.getById(id) as PrePrExecutionRecord;
  for (const spec of PRE_PR_PHASES) {
    if (spec.kind === "command-observable") {
      observeCommandPhase(store, id, {
        phaseId: spec.id,
        command: spec.command ?? "",
        exitCode: 0,
        inputHash: record.inputHash,
        skipReason: null,
      });
    } else {
      submitReviewerReport(store, id, {
        phaseId: spec.id,
        reviewedFileManifest: ["packages/core/src/pre-pr-controller/fixture-scope.ts"],
        suppliedContentsHash: "tree-final",
        criteriaDigest: approved.digest,
        reviewerReportRef: "report://semantic",
        controllerObservedHash: "tree-final",
      });
    }
  }
  return id;
}

describe("Limb 6 pre-PR evidence (identical code/body, different trusted evidence)", () => {
  it("passes with a controller-issued store record and blocks without one", () => {
    const store = new InProcessPrePrStore();
    const runId = startPassingRun(store);
    const publisher = mintPublisher();
    expect(completeRun(store, publisher, runId, undefined, { skipNamedMergeGate: true }).ok).toBe(
      true,
    );
    const live = {
      repo: REPO,
      baseSha: BASE,
      headSha: HEAD,
      prNodeId: PR_NODE,
      prBodyHash: BODY,
    };
    const pass = evaluatePrePrEvidence({
      record: store.getById(runId),
      liveBinding: live,
      presentedRunId: runId,
      approvedCriteria: approved,
      currentGeneration: 1,
    });
    expect(pass.ok).toBe(true);
    expect(pass.code).toBe("allow-pass");

    const block = evaluatePrePrEvidence({
      record: null,
      liveBinding: live,
      presentedRunId: runId,
      presentedIdWithoutStore: true,
      approvedCriteria: approved,
      currentGeneration: 1,
    });
    expect(block.ok).toBe(false);
    expect(block.code).toBe("deny-not-bearer");
    expect(block.message).toContain(RUN_ID_LOOKUP_HINT);
  });

  it("does not treat checkbox, author token, disk JSON, or one-PR-unit as pass", () => {
    const live = {
      repo: REPO,
      baseSha: BASE,
      headSha: HEAD,
      prNodeId: PR_NODE,
      prBodyHash: BODY,
    };
    const base = {
      record: null as PrePrExecutionRecord | null,
      liveBinding: live,
      approvedCriteria: approved,
      currentGeneration: 1,
    };
    expect(evaluatePrePrEvidence({ ...base, checkboxComplete: true }).code).toBe(
      "deny-checkbox-not-authority",
    );
    expect(evaluatePrePrEvidence({ ...base, authorToken: "I ran pre-pr" }).code).toBe(
      "deny-author-token",
    );
    expect(
      evaluatePrePrEvidence({ ...base, diskJsonPath: ".deft/pre-pr-controller/x.json" }).code,
    ).toBe("deny-disk-not-sot");
    expect(evaluatePrePrEvidence({ ...base, onePrUnitOk: true }).code).toBe(
      "deny-one-pr-unit-not-pre-pr",
    );
    expect(evaluatePrePrEvidence({ ...base, onePrUnitOk: true }).message).toContain(
      ONE_PR_UNIT_NOT_PRE_PR,
    );
    expect(CHECKBOX_NOT_AUTHORITY.length).toBeGreaterThan(0);
    expect(writePrePrRecordDisk(".", {} as PrePrExecutionRecord).code).toBe("deny-disk-not-sot");
    expect(writePrePrRecordDisk(".", {} as PrePrExecutionRecord).message).toBe(DISK_STORE_NOT_SOT);
  });

  it("blocks a replay bound to a different repo or SHA", () => {
    const store = new InProcessPrePrStore();
    const runId = startPassingRun(store, "ppr_replay");
    completeRun(store, mintPublisher(), runId, undefined, { skipNamedMergeGate: true });
    const record = store.getById(runId);
    const crossRepo = evaluatePrePrEvidence({
      record,
      liveBinding: {
        repo: "other/repo",
        baseSha: BASE,
        headSha: HEAD,
        prNodeId: PR_NODE,
        prBodyHash: BODY,
      },
      approvedCriteria: approved,
      currentGeneration: 1,
    });
    expect(crossRepo.ok).toBe(false);
    expect(crossRepo.code).toBe("deny-binding");
    const shaDrift = evaluatePrePrEvidence({
      record,
      liveBinding: {
        repo: REPO,
        baseSha: BASE,
        headSha: "cccccccccccccccccccccccccccccccccccccccc",
        prNodeId: PR_NODE,
        prBodyHash: BODY,
      },
      approvedCriteria: approved,
      currentGeneration: 1,
    });
    expect(shaDrift.code).toBe("deny-binding");
    const otherPr = evaluatePrePrEvidence({
      record,
      liveBinding: {
        repo: REPO,
        baseSha: BASE,
        headSha: HEAD,
        prNodeId: "PR_other",
        prBodyHash: BODY,
      },
      approvedCriteria: approved,
      currentGeneration: 1,
    });
    expect(otherPr.code).toBe("deny-binding");
  });
});

describe("Limb 1 trust boundary", () => {
  it("mints no pass on omitted phase, command failure, or interruption", () => {
    const store = new InProcessPrePrStore();
    const started = startControllerRun(store, {
      repo: REPO,
      baseSha: BASE,
      headSha: HEAD,
      treeHash: TREE,
      prBodyHash: BODY,
      prNodeId: PR_NODE,
      criteria: approved,
      skillVersion: "0.1",
      policyVersion: "1",
      approvedRevisionSha: BASE,
      runId: "ppr_fail",
    });
    const id = started.runId as string;
    const publisher = mintPublisher();
    expect(completeRun(store, publisher, id, undefined, { skipNamedMergeGate: true }).code).toBe(
      "deny-omitted-phase",
    );

    const record = store.getById(id) as PrePrExecutionRecord;
    observeCommandPhase(store, id, {
      phaseId: "merge_chokepoint",
      command: "deft check",
      exitCode: 1,
      inputHash: record.inputHash,
      skipReason: null,
    });
    expect(completeRun(store, publisher, id, undefined, { skipNamedMergeGate: true }).code).toBe(
      "deny-failed",
    );

    const store2 = new InProcessPrePrStore();
    const id2 = startPassingRun(store2, "ppr_int");
    interruptRun(store2, id2);
    expect(
      completeRun(store2, mintPublisher(), id2, undefined, { skipNamedMergeGate: true }).code,
    ).toBe("deny-interrupted");
  });

  it("refuses complete without publisher credentials", () => {
    const store = new InProcessPrePrStore();
    const id = startPassingRun(store, "ppr_nopub");
    expect(
      completeRun(store, { forged: true }, id, undefined, { skipNamedMergeGate: true }).code,
    ).toBe("deny-publisher-required");
    expect(store.getById(id)?.outcome).toBe("none");
  });
});

describe("Limb 3 invocation funnel", () => {
  it("does not treat skill-file-open or mark-complete as a pass", () => {
    const store = new InProcessPrePrStore();
    const id = startPassingRun(store, "ppr_mark");
    expect(noteSkillFileOpen().code).toBe("deny-skill-file-open");
    expect(noteSkillFileOpen().message).toBe(SKILL_FILE_OPEN_NOT_COMPLETION);
    expect(markComplete(store, id).code).toBe("deny-mark-complete");
    expect(markComplete(store, id).message).toBe(MARK_COMPLETE_NOT_AUTHORITY);
    expect(store.getById(id)?.outcome).toBe("none");
  });
});

describe("Limb 4 criteria authority", () => {
  it("rejects head-side weakening, stale generation, and out-of-order older completion", () => {
    const store = new InProcessPrePrStore();
    const id = startPassingRun(store, "ppr_crit");
    completeRun(store, mintPublisher(), id, undefined, { skipNamedMergeGate: true });
    const record = store.getById(id);
    const live = {
      repo: REPO,
      baseSha: BASE,
      headSha: HEAD,
      prNodeId: PR_NODE,
      prBodyHash: BODY,
    };
    const weakened = digestApprovedCriteria({
      sourceRevisionSha: HEAD,
      scopePaths: [],
      acceptanceText: "weakened by head-side xbrief/active",
      generation: 1,
    });
    expect(
      evaluatePrePrEvidence({
        record,
        liveBinding: live,
        approvedCriteria: approved,
        currentGeneration: 1,
        headCriteria: weakened,
      }).code,
    ).toBe("deny-head-weakening");

    const bumped = bumpGeneration(approved, {
      sourceRevisionSha: BASE,
      scopePaths: ["packages/core/src/pre-pr-controller/fixture-scope.ts"],
      acceptanceText: "controller-issued completion record matches live PR binding",
      generation: 1,
    });
    expect(
      evaluatePrePrEvidence({
        record,
        liveBinding: live,
        approvedCriteria: bumped,
        currentGeneration: bumped.generation,
      }).code,
    ).toBe("deny-generation-stale");

    expect(
      evaluatePrePrEvidence({
        record,
        liveBinding: live,
        approvedCriteria: approved,
        currentGeneration: 1,
        lastInvalidationAt: "2099-01-01T00:00:00Z",
      }).code,
    ).toBe("deny-out-of-order");
  });
});

describe("live evaluate and interrupted records", () => {
  it("maps interrupted records and presented ids through the live check", () => {
    const store = new InProcessPrePrStore();
    const runId = startPassingRun(store, "ppr_live");
    interruptRun(store, runId);
    const live = {
      repo: REPO,
      baseSha: BASE,
      headSha: HEAD,
      prNodeId: PR_NODE,
      prBodyHash: BODY,
    };
    expect(
      evaluatePrePrEvidence({
        record: store.getById(runId),
        liveBinding: live,
        approvedCriteria: approved,
        currentGeneration: 1,
      }).code,
    ).toBe("deny-interrupted");
    const empty = new InProcessPrePrStore();
    startPassingRun(empty, "ppr_incomplete");
    expect(
      evaluatePrePrEvidence({
        record: empty.getById("ppr_incomplete"),
        liveBinding: live,
        approvedCriteria: approved,
        currentGeneration: 1,
      }).code,
    ).toBe("deny-incomplete");
    expect(
      evaluateLivePrePrCheck({
        store: new InProcessPrePrStore(),
        liveBinding: live,
        presentedRunId: "ghost",
        approvedCriteria: approved,
        currentGeneration: 1,
      }).code,
    ).toBe("deny-not-bearer");
    expect(
      canReuseCommandResult({
        previousInputHash: "abc",
        currentInputHash: "abc",
        previousCommand: "deft check",
        currentCommand: "deft check",
        previousExitCode: 2,
      }).code,
    ).toBe("deny-command-failure");
  });
});

describe("command reuse", () => {
  it("reuses a validated check only on full input-binding match", () => {
    const ok = canReuseCommandResult({
      previousInputHash: "abc",
      currentInputHash: "abc",
      previousCommand: "deft check",
      currentCommand: "deft check",
      previousExitCode: 0,
    });
    expect(ok.ok).toBe(true);
    expect(
      canReuseCommandResult({
        previousInputHash: "abc",
        currentInputHash: "def",
        previousCommand: "deft check",
        currentCommand: "deft check",
        previousExitCode: 0,
      }).code,
    ).toBe("deny-reuse-mismatch");
    expect(
      canReuseCommandResult({
        previousInputHash: "abc",
        currentInputHash: "abc",
        previousCommand: "deft check",
        currentCommand: RENDER_EXPORT_RULE,
        previousExitCode: 0,
      }).code,
    ).toBe("deny-reuse-mismatch");
  });
});

describe("PR node identity and body hash", () => {
  it("denies when either side is missing a PR node id or the live body hash drifts", () => {
    const store = new InProcessPrePrStore();
    const nullId = startPassingRun(store, "ppr_null_node", null);
    completeRun(store, mintPublisher(), nullId, undefined, { skipNamedMergeGate: true });
    const liveWithId = {
      repo: REPO,
      baseSha: BASE,
      headSha: HEAD,
      prNodeId: PR_NODE,
      prBodyHash: BODY,
    };
    expect(
      evaluatePrePrEvidence({
        record: store.getById(nullId),
        liveBinding: liveWithId,
        approvedCriteria: approved,
        currentGeneration: 1,
      }).code,
    ).toBe("deny-binding");

    const withId = startPassingRun(store, "ppr_has_node", PR_NODE);
    completeRun(store, mintPublisher(), withId, undefined, { skipNamedMergeGate: true });
    expect(
      evaluatePrePrEvidence({
        record: store.getById(withId),
        liveBinding: {
          repo: REPO,
          baseSha: BASE,
          headSha: HEAD,
          prNodeId: null,
          prBodyHash: BODY,
        },
        approvedCriteria: approved,
        currentGeneration: 1,
      }).code,
    ).toBe("deny-binding");
    expect(
      evaluatePrePrEvidence({
        record: store.getById(withId),
        liveBinding: {
          repo: REPO,
          baseSha: BASE,
          headSha: HEAD,
          prNodeId: PR_NODE,
          prBodyHash: "drifted-body",
        },
        approvedCriteria: approved,
        currentGeneration: 1,
      }).code,
    ).toBe("deny-binding");
  });

  it("uses live approved criteria so a same-generation digest update denies the old pass", () => {
    const store = new InProcessPrePrStore();
    const runId = startPassingRun(store, "ppr_headcrit");
    completeRun(store, mintPublisher(), runId, undefined, { skipNamedMergeGate: true });
    const live = {
      repo: REPO,
      baseSha: BASE,
      headSha: HEAD,
      prNodeId: PR_NODE,
      prBodyHash: BODY,
    };
    const weakened = digestApprovedCriteria({
      sourceRevisionSha: HEAD,
      scopePaths: [],
      acceptanceText: "weakened by head-side xbrief/active",
      generation: 1,
    });
    expect(
      evaluateLivePrePrCheck({
        store,
        liveBinding: live,
        presentedRunId: runId,
        approvedCriteria: approved,
        currentGeneration: 1,
        headCriteria: weakened,
      }).code,
    ).toBe("deny-head-weakening");
    const liveApproved = digestApprovedCriteria({
      sourceRevisionSha: BASE,
      scopePaths: ["packages/core/src/pre-pr-controller/fixture-scope.ts"],
      acceptanceText: "updated live approved same generation",
      generation: 1,
    });
    expect(
      evaluateLivePrePrCheck({
        store,
        liveBinding: live,
        presentedRunId: runId,
        approvedCriteria: liveApproved,
        currentGeneration: 1,
        headCriteria: liveApproved,
      }).code,
    ).toBe("deny-criteria-invalidated");
  });
});
