import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { revokeGrant } from "../authz/actions.js";
import {
  admitGateOverrideForAttempt,
  mintGateOverrideTemplateGrant,
} from "../authz/gate-override.js";
import {
  completeRun,
  computeControllerObservedHash,
  failRun,
  observeCommandPhase,
  runObservablesComplete,
  startControllerRun,
  submitReviewerReport,
} from "./controller.js";
import { digestApprovedCriteria } from "./criteria.js";
import { evaluatePrePrEvidence } from "./evaluate.js";
import {
  ALLOWED_SKIP_REASONS,
  COVERAGE_HEADROOM_MODE_SKIP,
  COVERAGE_HEADROOM_WAIVED_SKIP,
  LINT_ITERATION_MODE_SKIP,
  PRE_PR_PHASES,
} from "./phases.js";
import { InProcessPrePrStore, mintPublisher, type PrePrExecutionStore } from "./store.js";
import { type CommandObservation, deny, type PrePrExecutionRecord } from "./types.js";

// Pass-through fs spies so a test can make lstat or open misbehave for the
// coverage report path only. There is no production hook between the presence
// check and the read: the symlink-swap case mocks lstatSync.
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    lstatSync: vi.fn(actual.lstatSync),
    openSync: vi.fn(actual.openSync),
    readFileSync: vi.fn(actual.readFileSync),
  };
});
const realFs = await vi.importActual<typeof import("node:fs")>("node:fs");
afterEach(() => {
  vi.mocked(lstatSync).mockImplementation(realFs.lstatSync);
  vi.mocked(openSync).mockImplementation(realFs.openSync);
  vi.mocked(readFileSync).mockImplementation(realFs.readFileSync);
});

const approved = digestApprovedCriteria({
  sourceRevisionSha: "base",
  scopePaths: ["a.ts"],
  acceptanceText: "ac",
  generation: 1,
});

function start(store: InProcessPrePrStore, runId: string): PrePrExecutionRecord {
  startControllerRun(store, {
    repo: "deftai/directive",
    baseSha: "base",
    headSha: "head",
    treeHash: "tree",
    prBodyHash: "body",
    prNodeId: null,
    criteria: approved,
    skillVersion: "0.1",
    policyVersion: "1",
    approvedRevisionSha: "base",
    runId,
  });
  return store.getById(runId) as PrePrExecutionRecord;
}

function fillPhasesExceptCoverage(
  store: InProcessPrePrStore,
  rec: PrePrExecutionRecord,
  coverage: { command: string; exitCode: number; skipReason: string | null },
  options?: { readonly projectRoot?: string },
): void {
  for (const spec of PRE_PR_PHASES) {
    if (spec.kind !== "command-observable") continue;
    if (spec.id === "coverage_headroom") {
      observeCommandPhase(
        store,
        rec.id,
        {
          phaseId: spec.id,
          command: coverage.command,
          exitCode: coverage.exitCode,
          inputHash: rec.inputHash,
          skipReason: coverage.skipReason,
        },
        options,
      );
    } else {
      observeCommandPhase(store, rec.id, {
        phaseId: spec.id,
        command: spec.command ?? "",
        exitCode: 0,
        inputHash: rec.inputHash,
        skipReason: null,
      });
    }
  }
  for (const phase of ["read", "write", "diff", "loop"] as const) {
    submitReviewerReport(store, rec.id, {
      phaseId: phase,
      reviewedFileManifest: ["docs/design.md"],
      suppliedContentsHash: "h",
      criteriaDigest: approved.digest,
      reviewerReportRef: "r",
      controllerObservedHash: "h",
    });
  }
}

function fillPhasesWithLintModeSkip(
  store: InProcessPrePrStore,
  rec: PrePrExecutionRecord,
  options?: { readonly projectRoot?: string },
): void {
  for (const spec of PRE_PR_PHASES) {
    if (spec.kind !== "command-observable") continue;
    if (spec.id === "lint_iteration") {
      observeCommandPhase(
        store,
        rec.id,
        {
          phaseId: spec.id,
          command: "vitest run --coverage <changed-paths>",
          exitCode: 5,
          inputHash: rec.inputHash,
          skipReason: LINT_ITERATION_MODE_SKIP,
        },
        options,
      );
    } else if (spec.id === "coverage_headroom") {
      observeCommandPhase(
        store,
        rec.id,
        {
          phaseId: spec.id,
          command: "deft coverage:hotspots",
          exitCode: 5,
          inputHash: rec.inputHash,
          skipReason: COVERAGE_HEADROOM_MODE_SKIP,
        },
        options,
      );
    } else {
      observeCommandPhase(store, rec.id, {
        phaseId: spec.id,
        command: spec.command ?? "",
        exitCode: 0,
        inputHash: rec.inputHash,
        skipReason: null,
      });
    }
  }
  for (const phase of ["read", "write", "diff", "loop"] as const) {
    submitReviewerReport(store, rec.id, {
      phaseId: phase,
      reviewedFileManifest: ["docs/design.md"],
      suppliedContentsHash: "h",
      criteriaDigest: approved.digest,
      reviewerReportRef: "r",
      controllerObservedHash: "h",
    });
  }
}

describe("computeControllerObservedHash", () => {
  it("returns null for a directory reviewed path without throwing", () => {
    const dir = mkdtempSync(join(tmpdir(), "pre-pr-hash-dir-"));
    try {
      mkdirSync(join(dir, "nested"), { recursive: true });
      expect(() => computeControllerObservedHash({ reviewedFiles: [dir] })).not.toThrow();
      expect(computeControllerObservedHash({ reviewedFiles: [dir] })).toBeNull();
      expect(computeControllerObservedHash({ reviewedFiles: [join(dir, "nested")] })).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("hashes a readable file and returns null for a missing path", () => {
    const dir = mkdtempSync(join(tmpdir(), "pre-pr-hash-file-"));
    try {
      const file = join(dir, "reviewed.ts");
      writeFileSync(file, "contents\n");
      const hash = computeControllerObservedHash({ reviewedFiles: [file] });
      expect(typeof hash).toBe("string");
      expect(hash?.length).toBeGreaterThan(0);
      expect(
        computeControllerObservedHash({ reviewedFiles: [join(dir, "missing.ts")] }),
      ).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("startControllerRun put deny", () => {
  it("returns ok false and a null run id when store.put denies", () => {
    const store: PrePrExecutionStore = {
      put: () =>
        deny("deny-missing-record", "pre-PR private store HMAC secret could not be created"),
      getById: () => null,
      getByPrNodeId: () => null,
      list: () => [],
    };
    const started = startControllerRun(store, {
      repo: "deftai/directive",
      baseSha: "base",
      headSha: "head",
      treeHash: "tree",
      prBodyHash: "body",
      prNodeId: null,
      criteria: approved,
      skillVersion: "0.1",
      policyVersion: "1",
      approvedRevisionSha: "base",
      runId: "ppr_put_deny",
    });
    expect(started.ok).toBe(false);
    expect(started.runId).toBeNull();
    expect(started.decision.ok).toBe(false);
    expect(started.decision.code).toBe("deny-missing-record");
  });
});

describe("controller observations", () => {
  it("accepts the closed plan_sequence skip and rejects a mismatched input hash", () => {
    const store = new InProcessPrePrStore();
    const rec = start(store, "ppr_skip");
    expect(
      observeCommandPhase(store, rec.id, {
        phaseId: "plan_sequence",
        command: "deft verify:plan-sequence",
        exitCode: 0,
        inputHash: rec.inputHash,
        skipReason: ALLOWED_SKIP_REASONS.plan_sequence ?? "",
      }).ok,
    ).toBe(true);
    expect(
      observeCommandPhase(store, rec.id, {
        phaseId: "merge_chokepoint",
        command: "deft check",
        exitCode: 0,
        inputHash: "other",
        skipReason: null,
      }).code,
    ).toBe("deny-input-mismatch");
    expect(
      observeCommandPhase(store, rec.id, {
        phaseId: "read",
        command: "n/a",
        exitCode: 0,
        inputHash: rec.inputHash,
        skipReason: null,
      }).code,
    ).toBe("deny-input-mismatch");
  });

  it("stores reviewer prose without letting it mint a pass, and write-change clears no-change", () => {
    const store = new InProcessPrePrStore();
    const rec = start(store, "ppr_sem");
    expect(
      submitReviewerReport(store, rec.id, {
        phaseId: "merge_chokepoint",
        reviewedFileManifest: ["a.ts"],
        suppliedContentsHash: "h1",
        criteriaDigest: approved.digest,
        reviewerReportRef: "looks good",
        controllerObservedHash: "h1",
      }).code,
    ).toBe("deny-input-mismatch");
    expect(
      submitReviewerReport(store, rec.id, {
        phaseId: "loop",
        reviewedFileManifest: ["a.ts"],
        suppliedContentsHash: "final",
        criteriaDigest: approved.digest,
        reviewerReportRef: "ship it",
        controllerObservedHash: "final",
      }).ok,
    ).toBe(true);
    expect(store.getById(rec.id)?.finalNoChange).toBe(true);
    expect(
      submitReviewerReport(store, rec.id, {
        phaseId: "write",
        reviewedFileManifest: ["a.ts"],
        suppliedContentsHash: "before",
        criteriaDigest: approved.digest,
        reviewerReportRef: "fixed",
        controllerObservedHash: "after",
      }).ok,
    ).toBe(true);
    expect(store.getById(rec.id)?.finalNoChange).toBe(false);
    expect(completeRun(store, mintPublisher(), rec.id).ok).toBe(false);
  });

  it("allows a closed skip with a non-zero exit and refuses a missing run", () => {
    const store = new InProcessPrePrStore();
    const rec = start(store, "ppr_skip_exit");
    expect(
      observeCommandPhase(store, rec.id, {
        phaseId: "plan_sequence",
        command: "deft verify:plan-sequence",
        exitCode: 1,
        inputHash: rec.inputHash,
        skipReason: ALLOWED_SKIP_REASONS.plan_sequence ?? "",
      }).ok,
    ).toBe(true);
    expect(store.getById(rec.id)?.state).toBe("running");
    expect(
      observeCommandPhase(store, "missing", {
        phaseId: "branch_policy",
        command: "deft verify:branch",
        exitCode: 0,
        inputHash: rec.inputHash,
        skipReason: null,
      }).code,
    ).toBe("deny-missing-record");
    expect(completeRun(store, mintPublisher(), "missing").code).toBe("deny-missing-record");
  });

  it("refuses a second publish and a semantic digest mismatch", () => {
    const store = new InProcessPrePrStore();
    const rec = start(store, "ppr_second");
    for (const phase of [
      "branch_policy",
      "plan_sequence",
      "lint_iteration",
      "coverage_headroom",
      "render_export",
      "merge_chokepoint",
    ] as const) {
      const spec = PRE_PR_PHASES.find((p) => p.id === phase);
      observeCommandPhase(store, rec.id, {
        phaseId: phase,
        command: spec?.command ?? "cmd",
        exitCode: 0,
        inputHash: rec.inputHash,
        skipReason: null,
      });
    }
    for (const phase of ["read", "write", "diff", "loop"] as const) {
      submitReviewerReport(store, rec.id, {
        phaseId: phase,
        reviewedFileManifest: ["a.ts"],
        suppliedContentsHash: "h",
        criteriaDigest: approved.digest,
        reviewerReportRef: "r",
        controllerObservedHash: "h",
      });
    }
    expect(completeRun(store, mintPublisher(), rec.id).ok).toBe(true);
    expect(
      observeCommandPhase(store, rec.id, {
        phaseId: "branch_policy",
        command: "deft verify:branch",
        exitCode: 0,
        inputHash: rec.inputHash,
        skipReason: null,
      }).code,
    ).toBe("deny-incomplete");
    const rec2 = start(store, "ppr_digest");
    expect(
      submitReviewerReport(store, rec2.id, {
        phaseId: "read",
        reviewedFileManifest: ["a.ts"],
        suppliedContentsHash: "h",
        criteriaDigest: "not-the-approved-digest",
        reviewerReportRef: "r",
        controllerObservedHash: "h",
      }).code,
    ).toBe("deny-criteria-invalidated");
  });

  it("denies required phases recorded out of PRE_PR_PHASES order", () => {
    const store = new InProcessPrePrStore();
    const rec = start(store, "ppr_order");
    const at = (sec: number) => new Date(`2026-01-01T00:00:${String(sec).padStart(2, "0")}Z`);
    for (const [i, spec] of PRE_PR_PHASES.entries()) {
      const now = spec.id === "merge_chokepoint" ? at(1) : at(10 + i);
      if (spec.kind === "command-observable") {
        observeCommandPhase(store, rec.id, {
          phaseId: spec.id,
          command: spec.command ?? "cmd",
          exitCode: 0,
          inputHash: rec.inputHash,
          skipReason: null,
          now,
        });
      } else {
        submitReviewerReport(store, rec.id, {
          phaseId: spec.id,
          reviewedFileManifest: ["a.ts"],
          suppliedContentsHash: "h",
          criteriaDigest: approved.digest,
          reviewerReportRef: "r",
          controllerObservedHash: "h",
          now,
        });
      }
    }
    const decided = runObservablesComplete(store.getById(rec.id) as PrePrExecutionRecord);
    expect(decided.code).toBe("deny-out-of-order");
    expect(completeRun(store, mintPublisher(), rec.id).code).toBe("deny-out-of-order");
  });

  it("denies write, diff, and loop when supplied and observed hashes differ", () => {
    for (const mismatch of ["write", "diff", "loop"] as const) {
      const store = new InProcessPrePrStore();
      const rec = start(store, `ppr_hash_${mismatch}`);
      for (const spec of PRE_PR_PHASES) {
        if (spec.kind === "command-observable") {
          observeCommandPhase(store, rec.id, {
            phaseId: spec.id,
            command: spec.command ?? "cmd",
            exitCode: 0,
            inputHash: rec.inputHash,
            skipReason: null,
          });
        } else {
          const match = spec.id !== mismatch;
          submitReviewerReport(store, rec.id, {
            phaseId: spec.id,
            reviewedFileManifest: ["a.ts"],
            suppliedContentsHash: match ? "h" : "supplied",
            criteriaDigest: approved.digest,
            reviewerReportRef: "r",
            controllerObservedHash: match ? "h" : "observed",
          });
        }
      }
      const decided = runObservablesComplete(store.getById(rec.id) as PrePrExecutionRecord);
      expect(decided.ok).toBe(false);
      expect(["deny-omitted-phase", "deny-incomplete"]).toContain(decided.code);
    }
  });

  it("failRun blocks evaluate even with a presented id", () => {
    const store = new InProcessPrePrStore();
    const rec = start(store, "ppr_failrun");
    failRun(store, rec.id);
    const d = evaluatePrePrEvidence({
      record: store.getById(rec.id),
      liveBinding: {
        repo: "deftai/directive",
        baseSha: "base",
        headSha: "head",
        prNodeId: null,
        prBodyHash: "body",
      },
      approvedCriteria: approved,
      currentGeneration: 1,
    });
    expect(d.code).toBe("deny-failed");
  });

  it("coverage_headroom rejects arbitrary exit-0 audits and forged skip without re-derivation (#5421)", () => {
    const store = new InProcessPrePrStore();
    const rec = start(store, "ppr_cov_audit");
    observeCommandPhase(store, rec.id, {
      phaseId: "coverage_headroom",
      command: "changed-file audit",
      exitCode: 0,
      inputHash: rec.inputHash,
      skipReason: null,
    });
    expect(runObservablesComplete(store.getById(rec.id) as PrePrExecutionRecord).ok).toBe(false);

    const store2 = new InProcessPrePrStore();
    const rec2 = start(store2, "ppr_cov_forge");
    observeCommandPhase(store2, rec2.id, {
      phaseId: "coverage_headroom",
      command: "deft coverage:hotspots",
      exitCode: 2,
      inputHash: rec2.inputHash,
      skipReason: ALLOWED_SKIP_REASONS.coverage_headroom ?? "",
    });
    // Exact token without matching re-derivation (default cwd is not an inert binding).
    expect(runObservablesComplete(store2.getById(rec2.id) as PrePrExecutionRecord).ok).toBe(false);
  });

  it("coverage_headroom rejects measured exit-1 laundered as authorized skip", () => {
    const store = new InProcessPrePrStore();
    const rec = start(store, "ppr_cov_exit1");
    for (const spec of PRE_PR_PHASES) {
      if (spec.kind !== "command-observable") continue;
      if (spec.id === "coverage_headroom") {
        observeCommandPhase(store, rec.id, {
          phaseId: spec.id,
          command: spec.command ?? "",
          exitCode: 1,
          inputHash: rec.inputHash,
          skipReason: ALLOWED_SKIP_REASONS.coverage_headroom ?? "",
        });
      } else {
        observeCommandPhase(store, rec.id, {
          phaseId: spec.id,
          command: spec.command ?? "",
          exitCode: 0,
          inputHash: rec.inputHash,
          skipReason: null,
        });
      }
    }
    for (const phase of ["read", "write", "diff", "loop"] as const) {
      submitReviewerReport(store, rec.id, {
        phaseId: phase,
        reviewedFileManifest: ["docs/design.md"],
        suppliedContentsHash: "h",
        criteriaDigest: approved.digest,
        reviewerReportRef: "r",
        controllerObservedHash: "h",
      });
    }
    const decided = runObservablesComplete(store.getById(rec.id) as PrePrExecutionRecord, {
      applicabilityDeps: {
        runGit: (args) => {
          const joined = args.join(" ");
          if (joined.includes("rev-parse") && joined.includes("^{tree}")) {
            return { ok: true as const, stdout: "tree" };
          }
          if (joined.includes("rev-parse")) {
            return { ok: true as const, stdout: args.includes("base") ? "base" : "head" };
          }
          if (joined.includes("name-status")) {
            return { ok: true as const, stdout: "A\tdocs/design.md\n" };
          }
          return { ok: true as const, stdout: "" };
        },
        classifyPath: () => "inert",
      },
    });
    expect(decided.ok).toBe(false);
  });

  it("coverage_headroom accepts authorized skip when applicability re-derives not-applicable", () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "pre-pr-cov-na-"));
    try {
      const store = new InProcessPrePrStore();
      const rec = start(store, "ppr_cov_na");
      for (const spec of PRE_PR_PHASES) {
        if (spec.kind !== "command-observable") continue;
        if (spec.id === "coverage_headroom") {
          observeCommandPhase(
            store,
            rec.id,
            {
              phaseId: spec.id,
              command: spec.command ?? "",
              exitCode: 3,
              inputHash: rec.inputHash,
              skipReason: ALLOWED_SKIP_REASONS.coverage_headroom ?? "",
            },
            { projectRoot },
          );
        } else {
          observeCommandPhase(store, rec.id, {
            phaseId: spec.id,
            command: spec.command ?? "",
            exitCode: 0,
            inputHash: rec.inputHash,
            skipReason: null,
          });
        }
      }
      for (const phase of ["read", "write", "diff", "loop"] as const) {
        submitReviewerReport(store, rec.id, {
          phaseId: phase,
          reviewedFileManifest: ["docs/design.md"],
          suppliedContentsHash: "h",
          criteriaDigest: approved.digest,
          reviewerReportRef: "r",
          controllerObservedHash: "h",
        });
      }
      const decided = runObservablesComplete(store.getById(rec.id) as PrePrExecutionRecord, {
        projectRoot,
        applicabilityDeps: {
          runGit: (args) => {
            const joined = args.join(" ");
            if (joined.includes("rev-parse") && joined.includes("^{tree}")) {
              return { ok: true as const, stdout: "tree" };
            }
            if (joined.includes("rev-parse")) {
              return { ok: true as const, stdout: args.includes("base") ? "base" : "head" };
            }
            if (joined.includes("name-status")) {
              return { ok: true as const, stdout: "A\tdocs/design.md\n" };
            }
            return { ok: true as const, stdout: "" };
          },
          classifyPath: () => "inert",
        },
      });
      expect(decided.ok).toBe(true);
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it("coverage_headroom accepts authorized skip under not-applicable when a coverage report exists", () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "pre-pr-cov-report-"));
    try {
      mkdirSync(join(projectRoot, "coverage"), { recursive: true });
      writeFileSync(join(projectRoot, "coverage", "coverage-final.json"), "{}");
      const store = new InProcessPrePrStore();
      const rec = start(store, "ppr_cov_report");
      for (const spec of PRE_PR_PHASES) {
        if (spec.kind !== "command-observable") continue;
        if (spec.id === "coverage_headroom") {
          observeCommandPhase(
            store,
            rec.id,
            {
              phaseId: spec.id,
              command: spec.command ?? "",
              exitCode: 3,
              inputHash: rec.inputHash,
              skipReason: ALLOWED_SKIP_REASONS.coverage_headroom ?? "",
            },
            { projectRoot },
          );
        } else {
          observeCommandPhase(store, rec.id, {
            phaseId: spec.id,
            command: spec.command ?? "",
            exitCode: 0,
            inputHash: rec.inputHash,
            skipReason: null,
          });
        }
      }
      for (const phase of ["read", "write", "diff", "loop"] as const) {
        submitReviewerReport(store, rec.id, {
          phaseId: phase,
          reviewedFileManifest: ["docs/design.md"],
          suppliedContentsHash: "h",
          criteriaDigest: approved.digest,
          reviewerReportRef: "r",
          controllerObservedHash: "h",
        });
      }
      const decided = runObservablesComplete(store.getById(rec.id) as PrePrExecutionRecord, {
        projectRoot,
        applicabilityDeps: {
          runGit: (args) => {
            const joined = args.join(" ");
            if (joined.includes("rev-parse") && joined.includes("^{tree}")) {
              return { ok: true as const, stdout: "tree" };
            }
            if (joined.includes("rev-parse")) {
              return { ok: true as const, stdout: args.includes("base") ? "base" : "head" };
            }
            if (joined.includes("name-status")) {
              return { ok: true as const, stdout: "A\tdocs/design.md\n" };
            }
            return { ok: true as const, stdout: "" };
          },
          classifyPath: () => "inert",
        },
      });
      expect(decided.ok).toBe(true);
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it("coverage_headroom measured pass requires the authorized hotspots command", () => {
    const store = new InProcessPrePrStore();
    const rec = start(store, "ppr_cov_measured");
    for (const spec of PRE_PR_PHASES) {
      if (spec.kind !== "command-observable") continue;
      observeCommandPhase(store, rec.id, {
        phaseId: spec.id,
        command: spec.command ?? "",
        exitCode: 0,
        inputHash: rec.inputHash,
        skipReason: null,
      });
    }
    for (const phase of ["read", "write", "diff", "loop"] as const) {
      submitReviewerReport(store, rec.id, {
        phaseId: phase,
        reviewedFileManifest: ["a.ts"],
        suppliedContentsHash: "h",
        criteriaDigest: approved.digest,
        reviewerReportRef: "r",
        controllerObservedHash: "h",
      });
    }
    expect(runObservablesComplete(store.getById(rec.id) as PrePrExecutionRecord).ok).toBe(true);
  });

  it("coverage_headroom measured pass accepts --json and task wrappers", () => {
    for (const command of [
      "deft coverage:hotspots --json",
      "task coverage:hotspots",
      "task deft:coverage:hotspots -- --json",
    ]) {
      const store = new InProcessPrePrStore();
      const rec = start(store, `ppr_cov_${command.length}`);
      for (const spec of PRE_PR_PHASES) {
        if (spec.kind !== "command-observable") continue;
        observeCommandPhase(store, rec.id, {
          phaseId: spec.id,
          command: spec.id === "coverage_headroom" ? command : (spec.command ?? ""),
          exitCode: 0,
          inputHash: rec.inputHash,
          skipReason: null,
        });
      }
      for (const phase of ["read", "write", "diff", "loop"] as const) {
        submitReviewerReport(store, rec.id, {
          phaseId: phase,
          reviewedFileManifest: ["a.ts"],
          suppliedContentsHash: "h",
          criteriaDigest: approved.digest,
          reviewerReportRef: "r",
          controllerObservedHash: "h",
        });
      }
      expect(runObservablesComplete(store.getById(rec.id) as PrePrExecutionRecord).ok).toBe(true);
    }
  });

  it("coverage_headroom measured pass rejects project-root and base-ref redirects", () => {
    for (const command of [
      "deft coverage:hotspots --project-root=/other/project",
      "deft coverage:hotspots --base-ref=origin/other",
      "task coverage:hotspots -- --project-root=/other/project --json",
    ]) {
      const store = new InProcessPrePrStore();
      const rec = start(store, `ppr_rej_${command.length}`);
      for (const spec of PRE_PR_PHASES) {
        if (spec.kind !== "command-observable") continue;
        observeCommandPhase(store, rec.id, {
          phaseId: spec.id,
          command: spec.id === "coverage_headroom" ? command : (spec.command ?? ""),
          exitCode: 0,
          inputHash: rec.inputHash,
          skipReason: null,
        });
      }
      for (const phase of ["read", "write", "diff", "loop"] as const) {
        submitReviewerReport(store, rec.id, {
          phaseId: phase,
          reviewedFileManifest: ["a.ts"],
          suppliedContentsHash: "h",
          criteriaDigest: approved.digest,
          reviewerReportRef: "r",
          controllerObservedHash: "h",
        });
      }
      expect(runObservablesComplete(store.getById(rec.id) as PrePrExecutionRecord).ok).toBe(false);
    }
  });

  it("coverage_headroom accepts exit 4 waived after admission re-verify (#5674)", () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "pre-pr-cov-waive-"));
    try {
      const store = new InProcessPrePrStore();
      const rec = start(store, "ppr_cov_waive");
      const attemptId = rec.id;
      const minted = mintGateOverrideTemplateGrant({
        projectRoot,
        target: "unknown-path",
        planRef: attemptId,
        baseSha: rec.baseSha,
        headSha: rec.headSha,
        treeHash: rec.treeHash,
      });
      expect(minted.ok).toBe(true);
      const admitted = admitGateOverrideForAttempt(projectRoot, {
        refuseCode: "unknown-path",
        baseSha: rec.baseSha,
        headSha: rec.headSha,
        treeHash: rec.treeHash,
        attemptId,
        observedRefuseReason: "coverage-applicability: unknown path",
      });
      expect(admitted.ok).toBe(true);

      // Exit-4 waived satisfaction requires an available Istanbul report
      // (SLizard fp:c76cd7fc); empty object measures as hotspots exit 0.
      mkdirSync(join(projectRoot, "coverage"), { recursive: true });
      writeFileSync(join(projectRoot, "coverage", "coverage-final.json"), "{}");

      const observed = observeCommandPhase(
        store,
        rec.id,
        {
          phaseId: "coverage_headroom",
          command: `deft coverage:hotspots --attempt-id ${attemptId}`,
          exitCode: 4,
          inputHash: rec.inputHash,
          skipReason: COVERAGE_HEADROOM_WAIVED_SKIP,
        },
        { projectRoot },
      );
      expect(observed.ok).toBe(true);
      expect(store.getById(rec.id)?.state).toBe("running");

      fillPhasesExceptCoverage(
        store,
        rec,
        {
          command: `deft coverage:hotspots --attempt-id ${attemptId}`,
          exitCode: 4,
          skipReason: COVERAGE_HEADROOM_WAIVED_SKIP,
        },
        { projectRoot },
      );
      const decided = runObservablesComplete(store.getById(rec.id) as PrePrExecutionRecord, {
        projectRoot,
      });
      expect(decided.ok).toBe(true);
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it("coverage_headroom rejects exit 4 waived when coverage-final.json is missing under full (SLizard fp:c76cd7fc)", () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "pre-pr-cov-waive-noreport-"));
    try {
      mkdirSync(join(projectRoot, "xbrief"), { recursive: true });
      writeFileSync(
        join(projectRoot, "xbrief/PROJECT-DEFINITION.xbrief.json"),
        JSON.stringify({
          xBRIEFInfo: { version: "0.8", description: "t", updated: "2026-01-01T00:00:00Z" },
          plan: {
            title: "t",
            status: "running",
            "x-directive/policy": { coverageMode: "full" },
          },
        }),
      );
      const store = new InProcessPrePrStore();
      const rec = start(store, "ppr_cov_waive_noreport");
      const attemptId = rec.id;
      const minted = mintGateOverrideTemplateGrant({
        projectRoot,
        target: "unknown-path",
        planRef: attemptId,
        baseSha: rec.baseSha,
        headSha: rec.headSha,
        treeHash: rec.treeHash,
      });
      expect(minted.ok).toBe(true);
      const admitted = admitGateOverrideForAttempt(projectRoot, {
        refuseCode: "unknown-path",
        baseSha: rec.baseSha,
        headSha: rec.headSha,
        treeHash: rec.treeHash,
        attemptId,
        observedRefuseReason: "coverage-applicability: unknown path",
      });
      expect(admitted.ok).toBe(true);

      fillPhasesExceptCoverage(
        store,
        rec,
        {
          command: `deft coverage:hotspots --attempt-id ${attemptId}`,
          exitCode: 4,
          skipReason: COVERAGE_HEADROOM_WAIVED_SKIP,
        },
        { projectRoot },
      );
      expect(
        runObservablesComplete(store.getById(rec.id) as PrePrExecutionRecord, {
          projectRoot,
        }).ok,
      ).toBe(false);
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it("coverage_headroom accepts exit 4 waived with no report under initial (#5791)", () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "pre-pr-cov-waive-initial-"));
    try {
      mkdirSync(join(projectRoot, "xbrief"), { recursive: true });
      writeFileSync(
        join(projectRoot, "xbrief/PROJECT-DEFINITION.xbrief.json"),
        JSON.stringify({
          xBRIEFInfo: { version: "0.8", description: "t", updated: "2026-01-01T00:00:00Z" },
          plan: {
            title: "t",
            status: "running",
            "x-directive/policy": { coverageMode: "initial" },
          },
        }),
      );
      const store = new InProcessPrePrStore();
      const rec = start(store, "ppr_cov_waive_initial");
      const attemptId = rec.id;
      const minted = mintGateOverrideTemplateGrant({
        projectRoot,
        target: "unknown-path",
        planRef: attemptId,
        baseSha: rec.baseSha,
        headSha: rec.headSha,
        treeHash: rec.treeHash,
      });
      expect(minted.ok).toBe(true);
      const admitted = admitGateOverrideForAttempt(projectRoot, {
        refuseCode: "unknown-path",
        baseSha: rec.baseSha,
        headSha: rec.headSha,
        treeHash: rec.treeHash,
        attemptId,
        observedRefuseReason: "coverage-applicability: unknown path",
      });
      expect(admitted.ok).toBe(true);

      fillPhasesExceptCoverage(
        store,
        rec,
        {
          command: `deft coverage:hotspots --attempt-id ${attemptId}`,
          exitCode: 4,
          skipReason: COVERAGE_HEADROOM_WAIVED_SKIP,
        },
        { projectRoot },
      );
      expect(
        runObservablesComplete(store.getById(rec.id) as PrePrExecutionRecord, {
          projectRoot,
        }).ok,
      ).toBe(true);
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it("coverage_headroom rejects exit 4 with N/A token or mismatched admission (#5674)", () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "pre-pr-cov-waive-forge-"));
    try {
      const store = new InProcessPrePrStore();
      const rec = start(store, "ppr_cov_waive_forge");
      fillPhasesExceptCoverage(
        store,
        rec,
        {
          command: "deft coverage:hotspots --attempt-id missing",
          exitCode: 4,
          skipReason: ALLOWED_SKIP_REASONS.coverage_headroom ?? "",
        },
        { projectRoot },
      );
      expect(
        runObservablesComplete(store.getById(rec.id) as PrePrExecutionRecord, { projectRoot }).ok,
      ).toBe(false);

      const store2 = new InProcessPrePrStore();
      const rec2 = start(store2, "ppr_cov_waive_mismatch");
      const minted = mintGateOverrideTemplateGrant({
        projectRoot,
        target: "unknown-path",
        planRef: rec2.id,
        baseSha: "other-base",
        headSha: rec2.headSha,
        treeHash: rec2.treeHash,
      });
      expect(minted.ok).toBe(true);
      const admitted = admitGateOverrideForAttempt(projectRoot, {
        refuseCode: "unknown-path",
        baseSha: "other-base",
        headSha: rec2.headSha,
        treeHash: rec2.treeHash,
        attemptId: rec2.id,
        observedRefuseReason: "coverage-applicability: unknown path",
      });
      expect(admitted.ok).toBe(true);
      fillPhasesExceptCoverage(
        store2,
        rec2,
        {
          command: `deft coverage:hotspots --attempt-id ${rec2.id}`,
          exitCode: 4,
          skipReason: COVERAGE_HEADROOM_WAIVED_SKIP,
        },
        { projectRoot },
      );
      expect(
        runObservablesComplete(store2.getById(rec2.id) as PrePrExecutionRecord, {
          projectRoot,
        }).ok,
      ).toBe(false);
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it("coverage_headroom rejects exit 4 after grant revoke despite saved admission (#5674)", () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "pre-pr-cov-waive-revoked-"));
    try {
      const store = new InProcessPrePrStore();
      const rec = start(store, "ppr_cov_waive_revoked");
      const attemptId = rec.id;
      const minted = mintGateOverrideTemplateGrant({
        projectRoot,
        target: "unknown-path",
        planRef: attemptId,
        baseSha: rec.baseSha,
        headSha: rec.headSha,
        treeHash: rec.treeHash,
      });
      expect(minted.ok).toBe(true);
      if (!minted.ok) return;
      const admitted = admitGateOverrideForAttempt(projectRoot, {
        refuseCode: "unknown-path",
        baseSha: rec.baseSha,
        headSha: rec.headSha,
        treeHash: rec.treeHash,
        attemptId,
        observedRefuseReason: "coverage-applicability: unknown path",
      });
      expect(admitted.ok).toBe(true);
      const revoked = revokeGrant({ projectRoot, grantId: minted.grant.id });
      expect(revoked.ok).toBe(true);

      fillPhasesExceptCoverage(
        store,
        rec,
        {
          command: `deft coverage:hotspots --attempt-id ${attemptId}`,
          exitCode: 4,
          skipReason: COVERAGE_HEADROOM_WAIVED_SKIP,
        },
        { projectRoot },
      );
      expect(
        runObservablesComplete(store.getById(rec.id) as PrePrExecutionRecord, {
          projectRoot,
        }).ok,
      ).toBe(false);
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it("coverage_headroom rejects exit 4 when a failing coverage report appears later (#5674)", () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "pre-pr-cov-waive-report-"));
    try {
      const store = new InProcessPrePrStore();
      const rec = start(store, "ppr_cov_waive_report");
      const attemptId = rec.id;
      const minted = mintGateOverrideTemplateGrant({
        projectRoot,
        target: "unknown-path",
        planRef: attemptId,
        baseSha: rec.baseSha,
        headSha: rec.headSha,
        treeHash: rec.treeHash,
      });
      expect(minted.ok).toBe(true);
      const admitted = admitGateOverrideForAttempt(projectRoot, {
        refuseCode: "unknown-path",
        baseSha: rec.baseSha,
        headSha: rec.headSha,
        treeHash: rec.treeHash,
        attemptId,
        observedRefuseReason: "coverage-applicability: unknown path",
      });
      expect(admitted.ok).toBe(true);

      mkdirSync(join(projectRoot, "coverage"), { recursive: true });
      writeFileSync(
        join(projectRoot, "coverage", "coverage-final.json"),
        JSON.stringify({
          "packages/core/src/a.ts": {
            s: { "0": 1, "1": 1, "2": 1, "3": 1, "4": 1, "5": 1, "6": 1, "7": 1, "8": 1, "9": 1 },
            f: { "0": 1 },
            b: { "0": [1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0] },
          },
        }),
      );

      fillPhasesExceptCoverage(
        store,
        rec,
        {
          command: `deft coverage:hotspots --attempt-id ${attemptId}`,
          exitCode: 4,
          skipReason: COVERAGE_HEADROOM_WAIVED_SKIP,
        },
        { projectRoot },
      );
      expect(
        runObservablesComplete(store.getById(rec.id) as PrePrExecutionRecord, {
          projectRoot,
        }).ok,
      ).toBe(false);
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it("coverage_headroom uses last --attempt-id when duplicates are present (#5674)", () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "pre-pr-cov-waive-last-"));
    try {
      const store = new InProcessPrePrStore();
      const rec = start(store, "ppr_cov_waive_last");
      const attemptId = "retry-attempt";
      const minted = mintGateOverrideTemplateGrant({
        projectRoot,
        target: "unknown-path",
        planRef: attemptId,
        baseSha: rec.baseSha,
        headSha: rec.headSha,
        treeHash: rec.treeHash,
      });
      expect(minted.ok).toBe(true);
      const admitted = admitGateOverrideForAttempt(projectRoot, {
        refuseCode: "unknown-path",
        baseSha: rec.baseSha,
        headSha: rec.headSha,
        treeHash: rec.treeHash,
        attemptId,
        observedRefuseReason: "coverage-applicability: unknown path",
      });
      expect(admitted.ok).toBe(true);

      // Exit-4 waived satisfaction requires coverage-final.json (fp:c76cd7fc).
      mkdirSync(join(projectRoot, "coverage"), { recursive: true });
      writeFileSync(join(projectRoot, "coverage", "coverage-final.json"), "{}");

      fillPhasesExceptCoverage(
        store,
        rec,
        {
          command: `deft coverage:hotspots --attempt-id default --attempt-id ${attemptId}`,
          exitCode: 4,
          skipReason: COVERAGE_HEADROOM_WAIVED_SKIP,
        },
        { projectRoot },
      );
      expect(
        runObservablesComplete(store.getById(rec.id) as PrePrExecutionRecord, {
          projectRoot,
        }).ok,
      ).toBe(true);
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it("coverage_headroom accepts exit 5 mode skip when policy re-read authorizes (#5791)", () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "pre-pr-cov-mode-"));
    try {
      mkdirSync(join(projectRoot, "xbrief"), { recursive: true });
      writeFileSync(
        join(projectRoot, "xbrief/PROJECT-DEFINITION.xbrief.json"),
        JSON.stringify({
          xBRIEFInfo: { version: "0.8", description: "t", updated: "2026-01-01T00:00:00Z" },
          plan: {
            title: "t",
            status: "running",
            "x-directive/policy": { coverageMode: "initial" },
          },
        }),
      );
      const store = new InProcessPrePrStore();
      const rec = start(store, "ppr_cov_mode");
      const observed = observeCommandPhase(
        store,
        rec.id,
        {
          phaseId: "coverage_headroom",
          command: "deft coverage:hotspots",
          exitCode: 5,
          inputHash: rec.inputHash,
          skipReason: COVERAGE_HEADROOM_MODE_SKIP,
        },
        { projectRoot },
      );
      expect(observed.ok).toBe(true);
      expect(store.getById(rec.id)?.state).toBe("running");

      fillPhasesExceptCoverage(
        store,
        rec,
        {
          command: "deft coverage:hotspots",
          exitCode: 5,
          skipReason: COVERAGE_HEADROOM_MODE_SKIP,
        },
        { projectRoot },
      );
      expect(
        runObservablesComplete(store.getById(rec.id) as PrePrExecutionRecord, {
          projectRoot,
          applicabilityDeps: {
            runGit: (args) => {
              const joined = args.join(" ");
              if (joined.includes("rev-parse") && joined.includes("^{tree}")) {
                return { ok: true as const, stdout: "tree" };
              }
              if (joined.includes("rev-parse")) {
                return { ok: true as const, stdout: args.includes("base") ? "base" : "head" };
              }
              if (joined.includes("name-status")) {
                return { ok: true as const, stdout: "A\tdocs/design.md\n" };
              }
              return { ok: true as const, stdout: "" };
            },
            classifyPath: () => "inert",
          },
        }).ok,
      ).toBe(true);
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it("coverage_headroom rejects exit 5 mode skip when applicability refuses", () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "pre-pr-cov-mode-refuse-"));
    try {
      mkdirSync(join(projectRoot, "xbrief"), { recursive: true });
      writeFileSync(
        join(projectRoot, "xbrief/PROJECT-DEFINITION.xbrief.json"),
        JSON.stringify({
          xBRIEFInfo: { version: "0.8", description: "t", updated: "2026-01-01T00:00:00Z" },
          plan: {
            title: "t",
            status: "running",
            "x-directive/policy": { coverageMode: "initial" },
          },
        }),
      );
      const store = new InProcessPrePrStore();
      const rec = start(store, "ppr_cov_mode_refuse");
      fillPhasesExceptCoverage(
        store,
        rec,
        {
          command: "deft coverage:hotspots",
          exitCode: 5,
          skipReason: COVERAGE_HEADROOM_MODE_SKIP,
        },
        { projectRoot },
      );
      expect(
        runObservablesComplete(store.getById(rec.id) as PrePrExecutionRecord, {
          projectRoot,
          applicabilityDeps: {
            runGit: (args) => {
              const joined = args.join(" ");
              if (joined.includes("rev-parse") && joined.includes("^{tree}")) {
                return { ok: true as const, stdout: "tree" };
              }
              if (joined.includes("rev-parse")) {
                return { ok: true as const, stdout: args.includes("base") ? "base" : "head" };
              }
              if (joined.includes("name-status")) {
                return { ok: true as const, stdout: "A\tunknown/outside.md\n" };
              }
              return { ok: true as const, stdout: "" };
            },
            classifyPath: () => "unknown",
          },
        }).ok,
      ).toBe(false);
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it("coverage_headroom rejects exit 5 after graduation to full (#5791)", () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "pre-pr-cov-mode-full-"));
    try {
      mkdirSync(join(projectRoot, "xbrief"), { recursive: true });
      writeFileSync(
        join(projectRoot, "xbrief/PROJECT-DEFINITION.xbrief.json"),
        JSON.stringify({
          xBRIEFInfo: { version: "0.8", description: "t", updated: "2026-01-01T00:00:00Z" },
          plan: {
            title: "t",
            status: "running",
            "x-directive/policy": { coverageMode: "full" },
          },
        }),
      );
      const store = new InProcessPrePrStore();
      const rec = start(store, "ppr_cov_mode_full");
      fillPhasesExceptCoverage(
        store,
        rec,
        {
          command: "deft coverage:hotspots",
          exitCode: 5,
          skipReason: COVERAGE_HEADROOM_MODE_SKIP,
        },
        { projectRoot },
      );
      expect(
        runObservablesComplete(store.getById(rec.id) as PrePrExecutionRecord, {
          projectRoot,
        }).ok,
      ).toBe(false);
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it("coverage_headroom rejects exit 5 when a coverage report is present (#5791)", () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "pre-pr-cov-mode-report-"));
    try {
      mkdirSync(join(projectRoot, "xbrief"), { recursive: true });
      writeFileSync(
        join(projectRoot, "xbrief/PROJECT-DEFINITION.xbrief.json"),
        JSON.stringify({
          xBRIEFInfo: { version: "0.8", description: "t", updated: "2026-01-01T00:00:00Z" },
          plan: {
            title: "t",
            status: "running",
            "x-directive/policy": { coverageMode: "disabled" },
          },
        }),
      );
      mkdirSync(join(projectRoot, "coverage"), { recursive: true });
      writeFileSync(join(projectRoot, "coverage/coverage-final.json"), "{}");
      const store = new InProcessPrePrStore();
      const rec = start(store, "ppr_cov_mode_report");
      fillPhasesExceptCoverage(
        store,
        rec,
        {
          command: "deft coverage:hotspots",
          exitCode: 5,
          skipReason: COVERAGE_HEADROOM_MODE_SKIP,
        },
        { projectRoot },
      );
      expect(
        runObservablesComplete(store.getById(rec.id) as PrePrExecutionRecord, {
          projectRoot,
        }).ok,
      ).toBe(false);
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it("lint_iteration accepts exit 5 mode skip when policy re-read authorizes (#5814)", () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "pre-pr-lint-mode-"));
    try {
      mkdirSync(join(projectRoot, "xbrief"), { recursive: true });
      writeFileSync(
        join(projectRoot, "xbrief/PROJECT-DEFINITION.xbrief.json"),
        JSON.stringify({
          xBRIEFInfo: { version: "0.8", description: "t", updated: "2026-01-01T00:00:00Z" },
          plan: {
            title: "t",
            status: "running",
            "x-directive/policy": { coverageMode: "initial" },
          },
        }),
      );
      const store = new InProcessPrePrStore();
      const rec = start(store, "ppr_lint_mode");
      const observed = observeCommandPhase(
        store,
        rec.id,
        {
          phaseId: "lint_iteration",
          command: "vitest run --coverage <changed-paths>",
          exitCode: 5,
          inputHash: rec.inputHash,
          skipReason: LINT_ITERATION_MODE_SKIP,
        },
        { projectRoot },
      );
      expect(observed.ok).toBe(true);
      expect(store.getById(rec.id)?.state).toBe("running");

      fillPhasesWithLintModeSkip(store, rec, { projectRoot });
      expect(
        runObservablesComplete(store.getById(rec.id) as PrePrExecutionRecord, {
          projectRoot,
          applicabilityDeps: {
            runGit: (args) => {
              const joined = args.join(" ");
              if (joined.includes("rev-parse") && joined.includes("^{tree}")) {
                return { ok: true as const, stdout: "tree" };
              }
              if (joined.includes("rev-parse")) {
                return { ok: true as const, stdout: args.includes("base") ? "base" : "head" };
              }
              if (joined.includes("name-status")) {
                return { ok: true as const, stdout: "A\tdocs/design.md\n" };
              }
              return { ok: true as const, stdout: "" };
            },
            classifyPath: () => "inert",
          },
        }).ok,
      ).toBe(true);
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it("lint_iteration rejects exit 5 after graduation to full (#5814)", () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "pre-pr-lint-mode-full-"));
    try {
      mkdirSync(join(projectRoot, "xbrief"), { recursive: true });
      writeFileSync(
        join(projectRoot, "xbrief/PROJECT-DEFINITION.xbrief.json"),
        JSON.stringify({
          xBRIEFInfo: { version: "0.8", description: "t", updated: "2026-01-01T00:00:00Z" },
          plan: {
            title: "t",
            status: "running",
            "x-directive/policy": { coverageMode: "full" },
          },
        }),
      );
      const store = new InProcessPrePrStore();
      const rec = start(store, "ppr_lint_mode_full");
      fillPhasesWithLintModeSkip(store, rec, { projectRoot });
      expect(
        runObservablesComplete(store.getById(rec.id) as PrePrExecutionRecord, {
          projectRoot,
        }).ok,
      ).toBe(false);
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it("lint_iteration rejects exit 5 when a coverage report is present (#5814)", () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "pre-pr-lint-mode-report-"));
    try {
      mkdirSync(join(projectRoot, "xbrief"), { recursive: true });
      writeFileSync(
        join(projectRoot, "xbrief/PROJECT-DEFINITION.xbrief.json"),
        JSON.stringify({
          xBRIEFInfo: { version: "0.8", description: "t", updated: "2026-01-01T00:00:00Z" },
          plan: {
            title: "t",
            status: "running",
            "x-directive/policy": { coverageMode: "disabled" },
          },
        }),
      );
      mkdirSync(join(projectRoot, "coverage"), { recursive: true });
      writeFileSync(join(projectRoot, "coverage/coverage-final.json"), "{}");
      const store = new InProcessPrePrStore();
      const rec = start(store, "ppr_lint_mode_report");
      fillPhasesWithLintModeSkip(store, rec, { projectRoot });
      expect(
        runObservablesComplete(store.getById(rec.id) as PrePrExecutionRecord, {
          projectRoot,
        }).ok,
      ).toBe(false);
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it("lint_iteration refuses bare non-zero without pinned exit 5 token (#5814)", () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "pre-pr-lint-bare-"));
    try {
      mkdirSync(join(projectRoot, "xbrief"), { recursive: true });
      writeFileSync(
        join(projectRoot, "xbrief/PROJECT-DEFINITION.xbrief.json"),
        JSON.stringify({
          xBRIEFInfo: { version: "0.8", description: "t", updated: "2026-01-01T00:00:00Z" },
          plan: {
            title: "t",
            status: "running",
            "x-directive/policy": { coverageMode: "initial" },
          },
        }),
      );
      const store = new InProcessPrePrStore();
      const rec = start(store, "ppr_lint_bare");
      const observed = observeCommandPhase(
        store,
        rec.id,
        {
          phaseId: "lint_iteration",
          command: "vitest run --coverage <changed-paths>",
          exitCode: 1,
          inputHash: rec.inputHash,
          skipReason: LINT_ITERATION_MODE_SKIP,
        },
        { projectRoot },
      );
      expect(observed.ok).toBe(true);
      expect(store.getById(rec.id)?.state).toBe("failed");
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });
});

// Bound pre-PR coverage N/A rests on applicability alone (#5804 / #5421).
describe("coverage N/A rests on applicability; one report path and observed root", () => {
  const NA = ALLOWED_SKIP_REASONS.coverage_headroom ?? "";
  const roots: string[] = [];
  afterEach(() => {
    for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
  });

  function tmpRoot(prefix: string): string {
    const r = mkdtempSync(join(tmpdir(), prefix));
    roots.push(r);
    return r;
  }

  function writeMode(root: string, mode: string): void {
    mkdirSync(join(root, "xbrief"), { recursive: true });
    writeFileSync(
      join(root, "xbrief/PROJECT-DEFINITION.xbrief.json"),
      JSON.stringify({
        xBRIEFInfo: { version: "0.8", description: "t", updated: "2026-01-01T00:00:00Z" },
        plan: { title: "t", status: "running", "x-directive/policy": { coverageMode: mode } },
      }),
    );
  }

  function writeReport(root: string, body = "{}"): string {
    mkdirSync(join(root, "coverage"), { recursive: true });
    const p = join(root, "coverage", "coverage-final.json");
    writeFileSync(p, body);
    return p;
  }

  interface Shape {
    readonly tree?: string;
    readonly dirty?: string;
    readonly classify?: "inert" | "coverable" | "unknown";
    readonly failOn?: string;
    readonly throwOn?: string;
  }

  /** Mocked applicability. Defaults derive not-applicable for the bound base/head/tree. */
  function deps(shape: Shape = {}) {
    return {
      runGit: (args: readonly string[]) => {
        const joined = args.join(" ");
        if (shape.throwOn !== undefined && joined.includes(shape.throwOn)) {
          throw new Error("git exploded");
        }
        if (shape.failOn !== undefined && joined.includes(shape.failOn)) {
          return { ok: false as const, message: "git failed" };
        }
        if (joined.includes("rev-parse") && joined.includes("^{tree}")) {
          return { ok: true as const, stdout: shape.tree ?? "tree" };
        }
        if (joined.includes("rev-parse")) {
          return { ok: true as const, stdout: args.includes("base") ? "base" : "head" };
        }
        if (joined.includes("name-status")) {
          return { ok: true as const, stdout: "A\tdocs/design.md\n" };
        }
        if (joined.includes("status")) {
          return { ok: true as const, stdout: shape.dirty ?? "" };
        }
        return { ok: true as const, stdout: "" };
      },
      classifyPath: () => shape.classify ?? "inert",
    };
  }

  function naRecord(
    runId: string,
    observeRoot: string,
    command = "deft coverage:hotspots",
  ): { store: InProcessPrePrStore; rec: PrePrExecutionRecord } {
    const store = new InProcessPrePrStore();
    const rec = start(store, runId);
    fillPhasesExceptCoverage(
      store,
      rec,
      { command, exitCode: 3, skipReason: NA },
      { projectRoot: observeRoot },
    );
    return { store, rec: store.getById(rec.id) as PrePrExecutionRecord };
  }

  function withRow(
    rec: PrePrExecutionRecord,
    phaseId: CommandObservation["phaseId"],
    edit: (row: CommandObservation) => CommandObservation,
  ): PrePrExecutionRecord {
    return {
      ...rec,
      phaseEvidence: {
        ...rec.phaseEvidence,
        commands: rec.phaseEvidence.commands.map((c) => (c.phaseId === phaseId ? edit(c) : c)),
      },
    };
  }

  function dropRoot(row: CommandObservation): CommandObservation {
    const { observedProjectRoot: _drop, ...rest } = row;
    return rest;
  }

  describe("not-applicable arm", () => {
    it("not-applicable, report replaced after lint observe: accepted", () => {
      const root = tmpRoot("pre-pr-na-replaced-");
      writeReport(root, '{"a":1}');
      const { rec } = naRecord("ppr_na_replaced", root);
      writeReport(root, '{"b":2}');
      expect(runObservablesComplete(rec, { projectRoot: root, applicabilityDeps: deps() }).ok).toBe(
        true,
      );
    });

    it("not-applicable, report deleted after lint: accepted", () => {
      const root = tmpRoot("pre-pr-na-deleted-");
      const report = writeReport(root);
      const { rec } = naRecord("ppr_na_deleted", root);
      unlinkSync(report);
      expect(runObservablesComplete(rec, { projectRoot: root, applicabilityDeps: deps() }).ok).toBe(
        true,
      );
    });

    it("not-applicable, no report at any point: accepted", () => {
      const root = tmpRoot("pre-pr-na-none-");
      const { rec } = naRecord("ppr_na_none", root);
      expect(runObservablesComplete(rec, { projectRoot: root, applicabilityDeps: deps() }).ok).toBe(
        true,
      );
    });

    it.each([
      ["with a report", true],
      ["without a report", false],
    ])("applicability applicable %s: refused", (_label, report) => {
      const root = tmpRoot("pre-pr-na-applicable-");
      if (report) writeReport(root);
      const { rec } = naRecord("ppr_na_applicable", root);
      expect(
        runObservablesComplete(rec, {
          projectRoot: root,
          applicabilityDeps: deps({ classify: "coverable" }),
        }).ok,
      ).toBe(false);
    });

    it.each([
      ["tree-mismatch", { tree: "other-tree" }],
      ["dirty-tree", { dirty: " M src/a.ts\n" }],
      ["unknown-path", { classify: "unknown" as const }],
      ["git failure", { failOn: "name-status" }],
    ])("applicability refuse (%s): refused", (_label, shape) => {
      const root = tmpRoot("pre-pr-na-refuse-");
      writeReport(root);
      const { rec } = naRecord("ppr_na_refuse", root);
      expect(
        runObservablesComplete(rec, { projectRoot: root, applicabilityDeps: deps(shape) }).ok,
      ).toBe(false);
    });

    it("applicability throws: refused, no exception escapes", () => {
      const root = tmpRoot("pre-pr-na-throw-");
      const { rec } = naRecord("ppr_na_throw", root);
      const opts = { projectRoot: root, applicabilityDeps: deps({ throwOn: "rev-parse" }) };
      expect(() => runObservablesComplete(rec, opts)).not.toThrow();
      expect(runObservablesComplete(rec, opts).ok).toBe(false);
    });

    it("not-applicable binding mismatch: row inputHash differs from the record: refused", () => {
      const root = tmpRoot("pre-pr-na-binding-");
      const { rec } = naRecord("ppr_na_binding", root);
      const opts = { projectRoot: root, applicabilityDeps: deps() };
      expect(runObservablesComplete(rec, opts).ok).toBe(true);
      const forged = withRow(rec, "coverage_headroom", (r) => ({ ...r, inputHash: "other" }));
      expect(runObservablesComplete(forged, opts).ok).toBe(false);
    });

    it.each([
      ["deft coverage:hotspots", true],
      ["deft coverage:hotspots --json", true],
      ["task deft:coverage:hotspots -- --json", true],
      ["deft coverage:hotspots --json;", false],
      ["deft coverage:hotspots --jsonx", false],
      ["deft coverage:hotspots extra", false],
      ["deft coverage:hotspotsx", false],
      ["echo deft coverage:hotspots", false],
      ["deft coverage:hotspots --project-root=/other", false],
      ["deft coverage:hotspots --coverage-dir=elsewhere", false],
      ["deft coverage:hotspots --attempt-id", false],
      ["", false],
    ])("exit-3 command %j accepted=%s", (command, accepted) => {
      const root = tmpRoot("pre-pr-na-cmd-");
      const { rec } = naRecord("ppr_na_cmd", root, command);
      expect(runObservablesComplete(rec, { projectRoot: root, applicabilityDeps: deps() }).ok).toBe(
        accepted,
      );
    });
  });

  // Per-arm root check. Each fixture is satisfiable when observed under the
  // satisfy root, so the root is the only reason a case refuses.
  type Arm = "exit 3" | "exit 4" | "exit 5" | "lint exit 5";
  const ARM_PHASE: Record<Arm, CommandObservation["phaseId"]> = {
    "exit 3": "coverage_headroom",
    "exit 4": "coverage_headroom",
    "exit 5": "coverage_headroom",
    "lint exit 5": "lint_iteration",
  };

  function armFixture(arm: Arm, runId: string) {
    const root = tmpRoot("pre-pr-arm-b-");
    const other = tmpRoot("pre-pr-arm-a-");
    for (const r of [root, other]) writeMode(r, "initial");
    const attemptCmd = `deft coverage:hotspots --attempt-id ${runId}`;
    if (arm === "exit 4") {
      expect(
        mintGateOverrideTemplateGrant({
          projectRoot: root,
          target: "unknown-path",
          planRef: runId,
          baseSha: "base",
          headSha: "head",
          treeHash: "tree",
        }).ok,
      ).toBe(true);
      expect(
        admitGateOverrideForAttempt(root, {
          refuseCode: "unknown-path",
          baseSha: "base",
          headSha: "head",
          treeHash: "tree",
          attemptId: runId,
          observedRefuseReason: "coverage-applicability: unknown path",
        }).ok,
      ).toBe(true);
      writeReport(root);
    }
    const build = (observeRoot: string): PrePrExecutionRecord => {
      const store = new InProcessPrePrStore();
      const rec = start(store, runId);
      if (arm === "lint exit 5") {
        fillPhasesWithLintModeSkip(store, rec, { projectRoot: root });
      } else {
        const cov =
          arm === "exit 3"
            ? { command: "deft coverage:hotspots", exitCode: 3, skipReason: NA }
            : arm === "exit 4"
              ? { command: attemptCmd, exitCode: 4, skipReason: COVERAGE_HEADROOM_WAIVED_SKIP }
              : {
                  command: "deft coverage:hotspots",
                  exitCode: 5,
                  skipReason: COVERAGE_HEADROOM_MODE_SKIP,
                };
        fillPhasesExceptCoverage(store, rec, cov, { projectRoot: root });
      }
      if (observeRoot !== root) {
        // Re-observe only the arm's row under the other root.
        const row = store
          .getById(rec.id)
          ?.phaseEvidence.commands.find((c) => c.phaseId === ARM_PHASE[arm]);
        if (row === undefined) throw new Error("missing row");
        observeCommandPhase(
          store,
          rec.id,
          {
            phaseId: row.phaseId,
            command: row.command,
            exitCode: row.exitCode,
            inputHash: row.inputHash,
            skipReason: row.skipReason,
          },
          { projectRoot: observeRoot },
        );
      }
      const out = store.getById(rec.id) as PrePrExecutionRecord;
      expect(out.state).toBe("running");
      return out;
    };
    const satisfy = { projectRoot: root, applicabilityDeps: deps() };
    return { root, other, build, satisfy };
  }

  const ARMS: readonly Arm[] = ["exit 3", "exit 4", "exit 5", "lint exit 5"];

  it.each(
    ARMS,
  )("%s root mismatch (observed under root A, satisfied under root B): refused", (arm) => {
    const f = armFixture(arm, "ppr_arm_mismatch");
    expect(runObservablesComplete(f.build(f.root), f.satisfy).ok).toBe(true);
    const decided = runObservablesComplete(f.build(f.other), f.satisfy);
    expect(decided.ok).toBe(false);
    expect(decided.message).toContain(ARM_PHASE[arm]);
  });

  it.each(ARMS)("%s missing root (null or absent observedProjectRoot): refused", (arm) => {
    const f = armFixture(arm, "ppr_arm_missing");
    const good = f.build(f.root);
    expect(runObservablesComplete(good, f.satisfy).ok).toBe(true);
    const asNull = withRow(good, ARM_PHASE[arm], (r) => ({ ...r, observedProjectRoot: null }));
    const absent = withRow(good, ARM_PHASE[arm], dropRoot);
    for (const forged of [asNull, absent]) {
      const decided = runObservablesComplete(forged, f.satisfy);
      expect(decided.ok).toBe(false);
      expect(decided.message).toContain(ARM_PHASE[arm]);
    }
  });

  it("root mismatch control: exit 0 measured pass with a mismatched root is still accepted", () => {
    const store = new InProcessPrePrStore();
    const rec = start(store, "ppr_root_exit0");
    const a = tmpRoot("pre-pr-exit0-a-");
    const b = tmpRoot("pre-pr-exit0-b-");
    fillPhasesExceptCoverage(
      store,
      rec,
      { command: "deft coverage:hotspots", exitCode: 0, skipReason: null },
      { projectRoot: a },
    );
    const stored = store.getById(rec.id) as PrePrExecutionRecord;
    expect(runObservablesComplete(stored, { projectRoot: b }).ok).toBe(true);
  });

  it("observedProjectRoot cannot be supplied by the caller; an extra field is ignored", () => {
    const root = tmpRoot("pre-pr-root-forge-");
    const store = new InProcessPrePrStore();
    const rec = start(store, "ppr_root_forge");
    const observation = {
      phaseId: "coverage_headroom" as const,
      command: "deft coverage:hotspots",
      exitCode: 3,
      inputHash: rec.inputHash,
      skipReason: NA,
      observedProjectRoot: "/forged",
    };
    // @ts-expect-error observedProjectRoot is omitted from the observation type
    observeCommandPhase(store, rec.id, { ...observation }, { projectRoot: root });
    const row = store
      .getById(rec.id)
      ?.phaseEvidence.commands.find((c) => c.phaseId === "coverage_headroom");
    expect(row?.observedProjectRoot).toBe(realpathSync(root));
    const other = store
      .getById(rec.id)
      ?.phaseEvidence.commands.find((c) => c.phaseId !== row?.phaseId);
    expect(other).toBeUndefined();
  });

  it("observe stores observedProjectRoot only for coverage_headroom and lint_iteration rows", () => {
    const root = tmpRoot("pre-pr-root-scope-");
    const store = new InProcessPrePrStore();
    const rec = start(store, "ppr_root_scope");
    fillPhasesExceptCoverage(
      store,
      rec,
      { command: "deft coverage:hotspots", exitCode: 3, skipReason: NA },
      { projectRoot: root },
    );
    for (const row of store.getById(rec.id)?.phaseEvidence.commands ?? []) {
      if (row.phaseId === "coverage_headroom") {
        expect(row.observedProjectRoot).toBe(realpathSync(root));
      } else if (row.phaseId !== "lint_iteration") {
        expect("observedProjectRoot" in row).toBe(false);
      }
    }
  });

  describe("presence helper (lstat, never followed)", () => {
    type Kind = "symlink" | "directory" | "EACCES";
    function breakReport(root: string, kind: Kind): void {
      const report = join(root, "coverage", "coverage-final.json");
      rmSync(report, { force: true, recursive: true });
      mkdirSync(join(root, "coverage"), { recursive: true });
      if (kind === "symlink") {
        writeFileSync(join(root, "elsewhere.json"), "{}");
        symlinkSync(join(root, "elsewhere.json"), report);
      } else if (kind === "directory") {
        mkdirSync(report);
      } else {
        writeFileSync(report, "{}");
        vi.mocked(lstatSync).mockImplementation(((
          p: Parameters<typeof lstatSync>[0],
          o?: object,
        ) => {
          if (String(p) === report) {
            const err = new Error("EACCES") as NodeJS.ErrnoException;
            err.code = "EACCES";
            throw err;
          }
          return realFs.lstatSync(p, o as undefined);
        }) as typeof lstatSync);
      }
    }
    const KINDS: readonly Kind[] = ["symlink", "directory", "EACCES"];
    const PRESENCE_ARMS: readonly Arm[] = ["exit 4", "exit 5", "lint exit 5"];
    for (const arm of PRESENCE_ARMS) {
      it.each(KINDS)(`presence: report path is a %s: ${arm} arm refuses`, (kind) => {
        const f = armFixture(arm, "ppr_presence");
        const rec = f.build(f.root);
        breakReport(f.root, kind);
        expect(runObservablesComplete(rec, f.satisfy).ok).toBe(false);
      });
    }

    it.each(KINDS)("presence: report path is a %s: not-applicable arm still accepted", (kind) => {
      const f = armFixture("exit 3", "ppr_presence_na");
      const rec = f.build(f.root);
      breakReport(f.root, kind);
      expect(runObservablesComplete(rec, f.satisfy).ok).toBe(true);
    });
  });

  describe("waived arm reads the report without following a symlink", () => {
    it("symlink swap at the read (mocked lstatSync, no production hook): exit 4 row refused", () => {
      const f = armFixture("exit 4", "ppr_swap");
      const rec = f.build(f.root);
      expect(runObservablesComplete(rec, f.satisfy).ok).toBe(true);
      const report = join(f.root, "coverage", "coverage-final.json");
      const target = join(f.root, "passing.json");
      writeFileSync(target, "{}");
      rmSync(report);
      symlinkSync(target, report);
      vi.mocked(lstatSync).mockImplementation(((p: Parameters<typeof lstatSync>[0], o?: object) =>
        String(p).endsWith(join("coverage", "coverage-final.json"))
          ? realFs.lstatSync(target)
          : realFs.lstatSync(p, o as undefined)) as typeof lstatSync);
      vi.mocked(readFileSync).mockClear();
      expect(runObservablesComplete(rec, f.satisfy).ok).toBe(false);
      const readPaths = vi.mocked(readFileSync).mock.calls.map((c) => String(c[0]));
      expect(readPaths.some((p) => p === target || p === report)).toBe(false);
    });

    it("read error: openSync EACCES on the report: exit 4 row refused", () => {
      const f = armFixture("exit 4", "ppr_read_error");
      const rec = f.build(f.root);
      expect(runObservablesComplete(rec, f.satisfy).ok).toBe(true);
      vi.mocked(openSync).mockImplementation(((p: Parameters<typeof openSync>[0], ...rest: []) => {
        if (String(p).endsWith(join("coverage", "coverage-final.json"))) {
          const err = new Error("EACCES") as NodeJS.ErrnoException;
          err.code = "EACCES";
          throw err;
        }
        return realFs.openSync(p, ...rest);
      }) as typeof openSync);
      expect(runObservablesComplete(rec, f.satisfy).ok).toBe(false);
    });
  });

  describe("unchanged arms", () => {
    it("exit 5 mode skip with a report present is still refused", () => {
      const f = armFixture("exit 5", "ppr_unchanged_mode");
      const rec = f.build(f.root);
      writeReport(f.root);
      expect(runObservablesComplete(rec, f.satisfy).ok).toBe(false);
    });

    it("lint exit 5 with a report present is still refused", () => {
      const f = armFixture("lint exit 5", "ppr_unchanged_lint");
      const rec = f.build(f.root);
      writeReport(f.root);
      expect(runObservablesComplete(rec, f.satisfy).ok).toBe(false);
    });

    it("waived exit 4 with a failing report is still refused", () => {
      const f = armFixture("exit 4", "ppr_unchanged_waived");
      const rec = f.build(f.root);
      writeReport(
        f.root,
        JSON.stringify({ "src/a.ts": { s: { "0": 1 }, f: { "0": 1 }, b: { "0": [1, 0] } } }),
      );
      writeFileSync(
        join(f.root, "vitest.config.ts"),
        "export default { test: { coverage: { thresholds: { branches: 85 } } } };",
      );
      expect(runObservablesComplete(rec, f.satisfy).ok).toBe(false);
    });
  });
});
