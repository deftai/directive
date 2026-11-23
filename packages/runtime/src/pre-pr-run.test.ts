import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mintAcceptanceDispositionTemplateGrant } from "@deftai/directive-core/policy";
import {
  formatPartLineNote,
  type RunGhFn,
  writeStoryLineToBodyFile,
} from "@deftai/directive-core/pr-closing-keywords";
import {
  completeRun,
  computeControllerObservedHash,
  controllerPublisher,
  deny,
  digestApprovedCriteria,
  evaluatePrePrEvidence,
  FileBackedPrePrStore,
  hashPrBody,
  InProcessPrePrStore,
  LINT_ITERATION_MODE_SKIP,
  MARK_COMPLETE_NOT_AUTHORITY,
  observeCommandPhase,
  PRE_PR_PHASES,
  resetDefaultPrePrStore,
  SKILL_FILE_OPEN_NOT_COMPLETION,
  setDefaultPrePrStore,
  startControllerRun,
  submitReviewerReport,
} from "@deftai/directive-core/pre-pr-controller";
import { evaluatePrePush, parsePrePushStdin } from "@deftai/directive-core/preflight";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseArgs, run } from "./pre-pr-run.js";
import { resolveControllerVerifyAc } from "./verify-ac.js";

const START = [
  "--repo",
  "deftai/directive",
  "--base-sha",
  "aaa",
  "--head-sha",
  "bbb",
  "--tree-hash",
  "ccc",
  "--pr-body-hash",
  "ddd",
  "--approved-revision",
  "aaa",
  "--scope",
  "a.ts",
  "--acceptance",
  "ac",
  "--pr-node-id",
  "PR_1",
] as const;

/** Hermetic controller-owned verify:ac pass (#6888): the real run reads the cwd project. */
const VERIFY_AC_PASS = () => ({ kind: "evaluated-pass" as const, output: "" });

/** Hermetic lint_iteration gate results (#6336): the real gates read the cwd tree. */
const PASS_GATES = () => [
  { gate: "verify:class-checks" as const, exitCode: 0, message: "verify_class_checks: clean" },
  {
    gate: "verify:evaluator-surface" as const,
    exitCode: 0,
    message: "verify:evaluator-surface: skip",
  },
];

function observeAll(runId: string, fixturePath: string, contentsHash: string): void {
  for (const spec of PRE_PR_PHASES) {
    if (spec.kind === "command-observable") {
      expect(
        run(
          [
            "--observe-command",
            "--run-id",
            runId,
            "--phase",
            spec.id,
            "--exit-code",
            "0",
            "--json",
          ],
          { gateChecks: PASS_GATES },
        ),
      ).toBe(0);
    } else {
      expect(
        run([
          "--observe-semantic",
          "--run-id",
          runId,
          "--phase",
          spec.id,
          "--supplied-contents-hash",
          contentsHash,
          "--reviewed-file",
          fixturePath,
          "--json",
        ]),
      ).toBe(0);
    }
  }
}

describe("deft pre-pr:run", () => {
  let tmpRoot: string;
  let fixturePath: string;
  let contentsHash: string;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), "pre-pr-cli-"));
    setDefaultPrePrStore(new FileBackedPrePrStore(tmpRoot));
    fixturePath = join(tmpRoot, "reviewed.ts");
    writeFileSync(fixturePath, "reviewed-contents\n");
    contentsHash = computeControllerObservedHash({ reviewedFiles: [fixturePath] }) ?? "";
  });

  afterEach(() => {
    resetDefaultPrePrStore();
    rmSync(tmpRoot, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("starts a run and treats the id as a lookup hint", () => {
    const code = run([...START, "--run-id", "ppr_cli", "--json"]);
    expect(code).toBe(0);
  });

  it("does not print started when store.put denies", () => {
    setDefaultPrePrStore({
      put: () =>
        deny("deny-missing-record", "pre-PR private store HMAC secret could not be created"),
      getById: () => null,
      getByPrNodeId: () => null,
      list: () => [],
    });
    const out: string[] = [];
    const err: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      out.push(String(chunk));
      return true;
    });
    vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
      err.push(String(chunk));
      return true;
    });
    expect(run([...START, "--run-id", "ppr_deny"])).toBe(1);
    expect(out.join("")).not.toMatch(/started/);
    expect(err.join("")).toMatch(/HMAC secret could not be created|deny-missing-record/);
  });

  it("refuses skill-open and mark-complete", () => {
    const err: string[] = [];
    vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
      err.push(String(chunk));
      return true;
    });
    expect(run(["--skill-open"])).toBe(1);
    expect(err.join("")).toContain(SKILL_FILE_OPEN_NOT_COMPLETION);
    err.length = 0;
    expect(run(["--mark-complete", "--run-id", "ppr_x"])).toBe(1);
    expect(err.join("")).toContain(MARK_COMPLETE_NOT_AUTHORITY);
  });

  it("complete without observables does not mint a pass", () => {
    run([...START, "--run-id", "ppr_cli_incomplete"]);
    const err: string[] = [];
    vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
      err.push(String(chunk));
      return true;
    });
    expect(
      run(["--complete", "--run-id", "ppr_cli_incomplete"], {
        skipNamedMergeGate: true,
        verifyAc: VERIFY_AC_PASS,
      }),
    ).toBe(1);
    expect(err.join("")).toMatch(/required phase|omitted|incomplete/i);
  });

  it("observes required phases then completes, including across a new store instance", () => {
    expect(run([...START, "--run-id", "ppr_happy", "--json"])).toBe(0);
    observeAll("ppr_happy", fixturePath, contentsHash);
    expect(
      run(["--complete", "--run-id", "ppr_happy", "--json"], {
        skipNamedMergeGate: true,
        verifyAc: VERIFY_AC_PASS,
      }),
    ).toBe(0);
    setDefaultPrePrStore(new FileBackedPrePrStore(tmpRoot));
    const out: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      out.push(String(chunk));
      return true;
    });
    expect(
      run([
        "--evaluate",
        "--repo",
        "deftai/directive",
        "--base-sha",
        "aaa",
        "--head-sha",
        "bbb",
        "--pr-body-hash",
        "ddd",
        "--pr-node-id",
        "PR_1",
        "--approved-revision",
        "aaa",
        "--scope",
        "a.ts",
        "--acceptance",
        "ac",
        "--run-id",
        "ppr_happy",
        "--json",
      ]),
    ).toBe(0);
    expect(out.join("")).toMatch(/allow-pass/);
  });

  it("evaluate uses live approved criteria so a different digest denies the old pass", () => {
    expect(run([...START, "--run-id", "ppr_weak", "--json"])).toBe(0);
    observeAll("ppr_weak", fixturePath, contentsHash);
    expect(
      run(["--complete", "--run-id", "ppr_weak"], {
        skipNamedMergeGate: true,
        verifyAc: VERIFY_AC_PASS,
      }),
    ).toBe(0);
    const err: string[] = [];
    vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
      err.push(String(chunk));
      return true;
    });
    expect(
      run([
        "--evaluate",
        "--repo",
        "deftai/directive",
        "--base-sha",
        "aaa",
        "--head-sha",
        "bbb",
        "--pr-body-hash",
        "ddd",
        "--pr-node-id",
        "PR_1",
        "--scope",
        "a.ts",
        "--acceptance",
        "weakened",
        "--run-id",
        "ppr_weak",
        "--json",
      ]),
    ).toBe(1);
    expect(err.join("")).toMatch(/criteria digest|invalidat/i);
  });

  it("parseArgs accepts lint_iteration exit-5 mode-skip pair (#5814)", () => {
    const parsed = parseArgs([
      "--observe-command",
      "--run-id",
      "ppr_lint_mode",
      "--phase",
      "lint_iteration",
      "--exit-code",
      "5",
      "--skip-reason",
      LINT_ITERATION_MODE_SKIP,
      "--command",
      "vitest run --coverage <changed-paths>",
    ]);
    expect(parsed.error).toBeFalsy();
    expect(parsed.observeCommand).toBe(true);
    expect(parsed.exitCode).toBe(5);
    expect(parsed.skipReason).toBe(LINT_ITERATION_MODE_SKIP);
    expect(parsed.phase).toBe("lint_iteration");
  });

  it("admits lint_iteration exit-5 mode skip when cwd coverageMode authorizes (#5814)", () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "pre-pr-lint-cli-"));
    const prevCwd = process.cwd();
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
      process.chdir(projectRoot);
      expect(run([...START, "--run-id", "ppr_lint_mode_cli", "--json"])).toBe(0);
      const lintArgv = [
        "--observe-command",
        "--run-id",
        "ppr_lint_mode_cli",
        "--phase",
        "lint_iteration",
        "--exit-code",
        "5",
        "--skip-reason",
        LINT_ITERATION_MODE_SKIP,
        "--command",
        "vitest run --coverage <changed-paths>",
        "--json",
      ];
      expect(run(lintArgv, { gateChecks: PASS_GATES })).toBe(0);
      const row = new FileBackedPrePrStore(tmpRoot)
        .getById("ppr_lint_mode_cli")
        ?.phaseEvidence.commands.find((c) => c.phaseId === "lint_iteration");
      expect(row?.gateChecks?.map((g) => g.gate)).toEqual([
        "verify:class-checks",
        "verify:evaluator-surface",
      ]);
    } finally {
      process.chdir(prevCwd);
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it("lint_iteration fails locally with the CI gate message and records it (#6336)", () => {
    expect(run([...START, "--run-id", "ppr_gate_red", "--json"])).toBe(0);
    const out: string[] = [];
    vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
      out.push(String(chunk));
      return true;
    });
    const ciMessage =
      "verify_class_checks: 1 finding(s): protected/gate.txt protected-glob -- Move or remove the path.";
    const red = () => [
      { gate: "verify:class-checks" as const, exitCode: 1, message: ciMessage },
      { gate: "verify:evaluator-surface" as const, exitCode: 0, message: "skip" },
    ];
    const argv = [
      "--observe-command",
      "--run-id",
      "ppr_gate_red",
      "--phase",
      "lint_iteration",
      "--exit-code",
      "0",
      "--json",
    ];
    expect(run(argv, { gateChecks: red })).toBe(1);
    expect(out.join("")).toContain(ciMessage);
    expect(out.join("")).toContain("deny-command-failure");
    const row = new FileBackedPrePrStore(tmpRoot)
      .getById("ppr_gate_red")
      ?.phaseEvidence.commands.find((c) => c.phaseId === "lint_iteration");
    expect(row?.gateChecks?.[0]?.exitCode).toBe(1);
    // Fixed and observed again: admitted, and the run was never marked failed.
    expect(run(argv, { gateChecks: PASS_GATES })).toBe(0);
    expect(new FileBackedPrePrStore(tmpRoot).getById("ppr_gate_red")?.state).toBe("running");
  });

  it("other phases do not run the lint gates (#6336)", () => {
    expect(run([...START, "--run-id", "ppr_gate_other", "--json"])).toBe(0);
    let called = false;
    const spy = () => {
      called = true;
      return PASS_GATES();
    };
    expect(
      run(
        [
          "--observe-command",
          "--run-id",
          "ppr_gate_other",
          "--phase",
          "branch_policy",
          "--exit-code",
          "0",
          "--json",
        ],
        { gateChecks: spy },
      ),
    ).toBe(0);
    expect(called).toBe(false);
  });

  it("hashes a CRLF body file and an LF stored body the same (#6336)", () => {
    const local = join(tmpRoot, "body-crlf.md");
    const stored = join(tmpRoot, "body-stored.md");
    writeFileSync(local, "Refs #6336\r\n\r\ndeft-story: 6336\r\n", "utf8");
    writeFileSync(stored, "Refs #6336\n\ndeft-story: 6336", "utf8");
    expect(hashPrBody(readFileSync(local, "utf8"))).toBe(hashPrBody(readFileSync(stored, "utf8")));
    const startNoHash = START.filter(
      (_, i) => START[i] !== "--pr-body-hash" && START[i - 1] !== "--pr-body-hash",
    );
    const writer = () => ({ code: 0 as const, message: "OK", issues: [], written: [] });
    expect(
      run([...startNoHash, "--run-id", "ppr_crlf", "--body-file", local], {
        writeStoryLine: writer,
      }),
    ).toBe(0);
    expect(new FileBackedPrePrStore(tmpRoot).getById("ppr_crlf")?.prBodyHash).toBe(
      hashPrBody(readFileSync(stored, "utf8")),
    );
    // --evaluate hashes the stored body file with the same rule: the binding matches,
    // and the refusal (if any) is not the body-hash binding.
    const err: string[] = [];
    vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
      err.push(String(chunk));
      return true;
    });
    const out: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      out.push(String(chunk));
      return true;
    });
    run([
      "--evaluate",
      "--repo",
      "deftai/directive",
      "--base-sha",
      "aaa",
      "--head-sha",
      "bbb",
      "--pr-node-id",
      "PR_1",
      "--run-id",
      "ppr_crlf",
      "--body-file",
      stored,
      "--json",
    ]);
    expect(`${out.join("")}${err.join("")}`).not.toContain("does not match live PR body hash");
    expect(
      run([
        "--evaluate",
        "--repo",
        "deftai/directive",
        "--base-sha",
        "aaa",
        "--head-sha",
        "bbb",
        "--body-file",
        join(tmpRoot, "missing.md"),
      ]),
    ).toBe(2);
    expect(err.join("")).toContain("cannot hash --body-file");
    expect(
      run(["--evaluate", "--repo", "deftai/directive", "--base-sha", "aaa", "--head-sha", "bbb"]),
    ).toBe(2);
    expect(err.join("")).toContain("--pr-body-hash or --body-file");
  });

  it("--observe-command --project-root stores observedProjectRoot as the realpath of that root", () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "pre-pr-root-flag-"));
    try {
      expect(run([...START, "--run-id", "ppr_root_flag", "--json"])).toBe(0);
      expect(
        run([
          "--observe-command",
          "--run-id",
          "ppr_root_flag",
          "--phase",
          "coverage_headroom",
          "--exit-code",
          "0",
          "--project-root",
          projectRoot,
          "--json",
        ]),
      ).toBe(0);
      const row = new FileBackedPrePrStore(tmpRoot)
        .getById("ppr_root_flag")
        ?.phaseEvidence.commands.find((c) => c.phaseId === "coverage_headroom");
      expect(row?.observedProjectRoot).toBe(realpathSync(projectRoot));
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it("--observe-command without --project-root stores observedProjectRoot as the realpath of the cwd", () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "pre-pr-root-cwd-"));
    const prevCwd = process.cwd();
    try {
      process.chdir(projectRoot);
      expect(run([...START, "--run-id", "ppr_root_cwd", "--json"])).toBe(0);
      expect(
        run([
          "--observe-command",
          "--run-id",
          "ppr_root_cwd",
          "--phase",
          "coverage_headroom",
          "--exit-code",
          "0",
          "--json",
        ]),
      ).toBe(0);
      const row = new FileBackedPrePrStore(tmpRoot)
        .getById("ppr_root_cwd")
        ?.phaseEvidence.commands.find((c) => c.phaseId === "coverage_headroom");
      expect(row?.observedProjectRoot).toBe(realpathSync(projectRoot));
    } finally {
      process.chdir(prevCwd);
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it("omitting --exit-code on --observe-command fails closed", () => {
    const err: string[] = [];
    vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
      err.push(String(chunk));
      return true;
    });
    expect(
      run(["--observe-command", "--run-id", "ppr_x", "--phase", "branch_policy", "--json"]),
    ).toBe(2);
    expect(err.join("")).toMatch(/requires --exit-code/);
  });

  it("mismatched semantic hashes deny for write, diff, and loop", () => {
    expect(run([...START, "--run-id", "ppr_hash", "--json"])).toBe(0);
    const err: string[] = [];
    vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
      err.push(String(chunk));
      return true;
    });
    for (const phase of ["write", "diff", "loop"] as const) {
      err.length = 0;
      expect(
        run([
          "--observe-semantic",
          "--run-id",
          "ppr_hash",
          "--phase",
          phase,
          "--supplied-contents-hash",
          "forged-supplied",
          "--reviewed-file",
          fixturePath,
          "--json",
        ]),
      ).toBe(1);
      expect(err.join("")).toMatch(/does not match independently hashed/);
      err.length = 0;
      expect(
        run([
          "--observe-semantic",
          "--run-id",
          "ppr_hash",
          "--phase",
          phase,
          "--supplied-contents-hash",
          contentsHash,
          "--controller-observed-hash",
          "forged-observed",
          "--reviewed-file",
          fixturePath,
          "--json",
        ]),
      ).toBe(1);
      expect(err.join("")).toMatch(/does not match independently hashed/);
    }
  });

  it("parseArgs rejects unknown flags", () => {
    expect(parseArgs(["--nope"]).error).toMatch(/unrecognized/);
  });

  it("covers help, equals-form flags, evaluate, and missing required args", () => {
    const out: string[] = [];
    const err: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      out.push(String(chunk));
      return true;
    });
    vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
      err.push(String(chunk));
      return true;
    });
    expect(run(["--help"])).toBe(0);
    expect(out.join("")).toContain("deft pre-pr:run");
    expect(run(["--complete"])).toBe(2);
    expect(run(["--evaluate", "--json"])).toBe(2);
    expect(
      run([
        "--evaluate",
        "--repo=deftai/directive",
        "--base-sha=aaa",
        "--head-sha=bbb",
        "--run-id=missing",
        "--json",
      ]),
    ).toBe(2);
    expect(
      run([
        "--evaluate",
        "--repo=deftai/directive",
        "--base-sha=aaa",
        "--head-sha=bbb",
        "--pr-body-hash=ddd",
        "--run-id=missing",
        "--json",
      ]),
    ).toBe(1);
    expect(run(["--observe-command", "--run-id=ppr_x"])).toBe(2);
    // #6893: no hash or file list needed; an unknown run refuses.
    expect(run(["--observe-semantic", "--run-id=ppr_x", "--phase=read"])).toBe(1);
    expect(run([])).toBe(2);
    const parsed = parseArgs([
      "--repo=deftai/directive",
      "--base-sha=aaa",
      "--head-sha=bbb",
      "--tree-hash=ccc",
      "--pr-body-hash=ddd",
      "--pr-node-id=PR_1",
      "--approved-revision=aaa",
      "--scope=a.ts",
      "--acceptance=ac",
      "--generation=2",
      "--skill-version=0.2",
      "--policy-version=2",
      "--run-id=ppr_eq",
      "--observe-command",
      "--phase=branch_policy",
      "--exit-code=0",
      "--command=deft verify:branch",
    ]);
    expect(parsed.error).toBeUndefined();
    expect(parsed.generation).toBe(2);
    expect(parsed.prNodeId).toBe("PR_1");
    expect(parsed.observeCommand).toBe(true);
    expect(parseArgs(["--repo"]).error).toMatch(/expected one argument/);
    expect(parseArgs(["--generation", "0"]).error).toMatch(/positive integer/);
    expect(parseArgs(["-h"]).help).toBe(true);
    expect(parseArgs(["--policy-version", "2"]).policyVersion).toBe("2");
    expect(run(["--nope"])).toBe(2);
    expect(err.join("")).toMatch(/unrecognized/);
  });
  it("writes the story line into the PR body file before start (#6316)", () => {
    const root = join(tmpRoot, "proj");
    mkdirSync(join(root, "xbrief", "active"), { recursive: true });
    const bodyFile = join(tmpRoot, "body.md");
    writeFileSync(bodyFile, "Refs #6316\n", "utf8");
    const calls: Array<{ bodyFile: string; part: boolean; repo: string | null }> = [];
    const writer = (args: {
      bodyFile: string;
      projectRoot: string;
      repo: string | null;
      part: boolean;
    }) => {
      calls.push({ bodyFile: args.bodyFile, part: args.part, repo: args.repo });
      return {
        code: 0 as const,
        message: "OK: wrote deft-story: 6316",
        issues: [6316],
        written: [],
      };
    };
    const err: string[] = [];
    const out: string[] = [];
    vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
      err.push(String(chunk));
      return true;
    });
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      out.push(String(chunk));
      return true;
    });
    const BODY_AFTER = "Refs #6316\n\ndeft-story: 6316\n";
    // Start without --pr-body-hash: the run binds the body file after the write step.
    const startNoHash = START.filter(
      (_, i) => START[i] !== "--pr-body-hash" && START[i - 1] !== "--pr-body-hash",
    );
    expect(
      run(
        [...startNoHash, "--run-id", "ppr_story", "--body-file", bodyFile, "--project-root", root],
        {
          writeStoryLine: (a) => {
            writeFileSync(a.bodyFile, BODY_AFTER, "utf8");
            return writer(a);
          },
        },
      ),
    ).toBe(0);
    expect(calls).toEqual([{ bodyFile, part: false, repo: "deftai/directive" }]);
    expect(err.join("")).toContain("wrote deft-story: 6316");
    expect(out.join("")).toContain("started ppr_story");
    const bound = new FileBackedPrePrStore(tmpRoot).getById("ppr_story");
    expect(bound?.prBodyHash).toBe(hashPrBody(BODY_AFTER));

    // A supplied hash taken before the write step no longer matches: refused.
    expect(
      run([...START, "--run-id", "ppr_stale", "--body-file", bodyFile, "--project-root", root], {
        writeStoryLine: writer,
      }),
    ).toBe(2);
    expect(err.join("")).toContain("--pr-body-hash does not match --body-file");
    const fresh = hashPrBody(readFileSync(bodyFile, "utf8"));
    const startFresh = START.map((v, i) => (START[i - 1] === "--pr-body-hash" ? fresh : v));
    expect(
      run([...startFresh, "--run-id", "ppr_fresh", "--body-file", bodyFile], {
        writeStoryLine: writer,
      }),
    ).toBe(0);
    expect(
      run([...startNoHash, "--body-file", join(tmpRoot, "gone.md")], { writeStoryLine: writer }),
    ).toBe(2);
    expect(err.join("")).toContain("cannot hash --body-file");

    calls.length = 0;
    expect(run(["--body-file", bodyFile, "--part"], { writeStoryLine: writer })).toBe(0);
    expect(calls).toEqual([{ bodyFile, part: true, repo: null }]);

    const failing = () => ({
      code: 1 as const,
      message: "FAIL: both lines",
      issues: [],
      written: [],
    });
    expect(run([...startNoHash, "--body-file", bodyFile], { writeStoryLine: failing })).toBe(1);
    expect(err.join("")).toContain("FAIL: both lines");
  });

  it("runs the real writer on a body file and validates --part / --body-file (#6316)", () => {
    const root = join(tmpRoot, "proj2");
    mkdirSync(join(root, "xbrief", "active"), { recursive: true });
    writeFileSync(
      join(root, "xbrief", "active", "s.xbrief.json"),
      JSON.stringify({
        plan: {
          status: "running",
          references: [
            {
              uri: "https://github.com/deftai/directive/issues/6316",
              type: "x-xbrief/github-issue",
            },
          ],
        },
      }),
      "utf8",
    );
    const bodyFile = join(tmpRoot, "body2.md");
    writeFileSync(bodyFile, "Refs #6316\n", "utf8");
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const err: string[] = [];
    vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
      err.push(String(chunk));
      return true;
    });
    expect(
      run([
        "--body-file",
        bodyFile,
        "--project-root",
        root,
        "--repo",
        "deftai/directive",
        "--json",
      ]),
    ).toBe(0);
    expect(readFileSync(bodyFile, "utf8")).toBe("Refs #6316\n\ndeft-story: 6316\n");
    expect(run(["--part"])).toBe(2);
    expect(err.join("")).toContain("--part requires --body-file");
    expect(parseArgs(["--body-file"]).error).toMatch(/expected one argument/);
    expect(parseArgs(["--body-file=b.md", "--part"])).toMatchObject({
      bodyFile: "b.md",
      part: true,
    });
  });

  it("prints the part-line note on stderr when --json starts a controller run (#6934)", () => {
    const root = join(tmpRoot, "proj6934");
    const brief = "xbrief/active/s-6934.xbrief.json";
    mkdirSync(join(root, "xbrief", "active"), { recursive: true });
    writeFileSync(
      join(root, brief),
      JSON.stringify({
        plan: {
          status: "running",
          references: [
            {
              uri: "https://github.com/deftai/directive/issues/6934",
              type: "x-xbrief/github-issue",
            },
          ],
        },
      }),
      "utf8",
    );
    const bodyFile = join(tmpRoot, "body6934.md");
    const BODY = "Refs #6934\n\ndeft-story-part: 6934\n";
    writeFileSync(bodyFile, BODY, "utf8");
    // A product branch: the brief plus a source file differ from the merge base.
    const runGit: RunGhFn = (cmd) => {
      if (cmd[0] === "merge-base") return { returncode: 0, stdout: "abc123\n", stderr: "" };
      if (cmd[0] === "diff") {
        return { returncode: 0, stdout: `M\0${brief}\0M\0packages/core/src/x.ts\0`, stderr: "" };
      }
      if (cmd.includes("rev-parse")) return { returncode: 0, stdout: "feat/x\n", stderr: "" };
      return { returncode: 1, stdout: "", stderr: "unexpected" };
    };
    const out: string[] = [];
    const err: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      out.push(String(chunk));
      return true;
    });
    vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
      err.push(String(chunk));
      return true;
    });
    const startNoHash = START.filter(
      (_, i) => START[i] !== "--pr-body-hash" && START[i - 1] !== "--pr-body-hash",
    );
    const code = run(
      [
        ...startNoHash,
        "--run-id",
        "ppr_6934",
        "--body-file",
        bodyFile,
        "--project-root",
        root,
        "--json",
      ],
      { writeStoryLine: (a) => writeStoryLineToBodyFile({ ...a, runGit }) },
    );
    expect(code).toBe(0);
    expect(readFileSync(bodyFile, "utf8")).toBe(BODY);
    expect(err.join("")).toContain(formatPartLineNote(6934));
    const payload = JSON.parse(out.join("").trim()) as Record<string, unknown>;
    expect(payload).toMatchObject({ ok: true, runId: "ppr_6934" });

    // Writer-only --json: stdout carries the writer JSON and stderr the note.
    out.length = 0;
    err.length = 0;
    expect(
      run(
        ["--body-file", bodyFile, "--project-root", root, "--repo", "deftai/directive", "--json"],
        {
          writeStoryLine: (a) => writeStoryLineToBodyFile({ ...a, runGit }),
        },
      ),
    ).toBe(0);
    expect(err.join("")).toContain(formatPartLineNote(6934));
    expect(JSON.parse(out.join("").trim())).toMatchObject({ code: 0 });

    // Writer-only text mode: the message and note go to stderr, nothing to stdout.
    out.length = 0;
    err.length = 0;
    expect(
      run(["--body-file", bodyFile, "--project-root", root, "--repo", "deftai/directive"], {
        writeStoryLine: (a) => writeStoryLineToBodyFile({ ...a, runGit }),
      }),
    ).toBe(0);
    expect(err.join("")).toContain(formatPartLineNote(6934));
    expect(out.join("")).toBe("");
  });

  describe("--complete runs verify:ac itself (#6888)", () => {
    function capture(): { out: string[]; err: string[] } {
      const out: string[] = [];
      const err: string[] = [];
      vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
        out.push(String(chunk));
        return true;
      });
      vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
        err.push(String(chunk));
        return true;
      });
      return { out, err };
    }

    function readyRun(runId: string): void {
      expect(run([...START, "--run-id", runId, "--json"])).toBe(0);
      observeAll(runId, fixturePath, contentsHash);
    }

    function evaluates(runId: string): number {
      return run([
        "--evaluate",
        "--repo",
        "deftai/directive",
        "--base-sha",
        "aaa",
        "--head-sha",
        "bbb",
        "--pr-body-hash",
        "ddd",
        "--pr-node-id",
        "PR_1",
        "--approved-revision",
        "aaa",
        "--scope",
        "a.ts",
        "--acceptance",
        "ac",
        "--run-id",
        runId,
      ]);
    }

    it("runs verify:ac on every call, with and without --verify-ac-disposition", () => {
      readyRun("ppr_6888_calls");
      const verifyAc = vi.fn(VERIFY_AC_PASS);
      expect(
        run(["--complete", "--run-id", "ppr_6888_calls"], { skipNamedMergeGate: true, verifyAc }),
      ).toBe(0);
      readyRun("ppr_6888_calls_flag");
      expect(
        run(
          [
            "--complete",
            "--run-id",
            "ppr_6888_calls_flag",
            "--verify-ac-disposition",
            "executed-ac",
          ],
          { skipNamedMergeGate: true, verifyAc },
        ),
      ).toBe(0);
      expect(verifyAc).toHaveBeenCalledTimes(2);
    });

    it("a failed verify:ac with no flag exits non-zero, prints the output and stores no pass", () => {
      readyRun("ppr_6888_fail");
      const { err } = capture();
      const verifyAc = () => ({ kind: "fail" as const, output: "verify:ac FAIL: clause 8 failed" });
      expect(
        run(["--complete", "--run-id", "ppr_6888_fail"], { skipNamedMergeGate: true, verifyAc }),
      ).toBe(1);
      expect(err.join("")).toContain("verify:ac FAIL: clause 8 failed");
      expect(err.join("")).toContain("verify:ac failed");
      expect(evaluates("ppr_6888_fail")).toBe(1);
    });

    it("a failed verify:ac with --verify-ac-disposition executed-ac still refuses", () => {
      readyRun("ppr_6888_fail_claim");
      capture();
      const verifyAc = () => ({ kind: "fail" as const, output: "verify:ac FAIL" });
      expect(
        run(
          [
            "--complete",
            "--run-id",
            "ppr_6888_fail_claim",
            "--verify-ac-disposition",
            "executed-ac",
          ],
          { skipNamedMergeGate: true, verifyAc },
        ),
      ).toBe(1);
      expect(evaluates("ppr_6888_fail_claim")).toBe(1);
    });

    it("a --verify-ac-disposition that differs from the result refuses", () => {
      readyRun("ppr_6888_conflict");
      const { err } = capture();
      expect(
        run(
          ["--complete", "--run-id", "ppr_6888_conflict", "--verify-ac-disposition", "executed-ac"],
          {
            skipNamedMergeGate: true,
            verifyAc: () => ({ kind: "no-target" as const, output: "" }),
          },
        ),
      ).toBe(1);
      expect(err.join("")).toContain("differs from the controller's verify:ac result");
    });

    it("no selected brief completes and says verify:ac had no brief to run", () => {
      readyRun("ppr_6888_none");
      const { out } = capture();
      expect(
        run(["--complete", "--run-id", "ppr_6888_none"], {
          skipNamedMergeGate: true,
          verifyAc: () => ({ kind: "no-target" as const, output: "" }),
        }),
      ).toBe(0);
      expect(out.join("")).toContain("verify:ac had no brief to run");
    });
  });
});

describe("a failed --complete retry revokes the earlier pass (#6888)", () => {
  const ZERO = "0000000000000000000000000000000000000000";
  const NOW = new Date("2026-11-20T10:00:00Z");
  /** Past the 24h expiry of an unused acceptance-disposition grant. */
  const AFTER_EXPIRY = new Date("2026-11-22T10:00:00Z");
  const PLAN_ID = "github.issue.6888";
  const bases: string[] = [];

  afterEach(() => {
    resetDefaultPrePrStore();
    vi.restoreAllMocks();
    for (const base of bases.splice(0)) rmSync(base, { recursive: true, force: true });
  });

  function git(cwd: string, args: readonly string[]): string {
    return execFileSync("git", [...args], { cwd, encoding: "utf8" }).trim();
  }

  function write(root: string, rel: string, body: string): void {
    const path = join(root, rel);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, body);
  }

  /** Clone with a bare origin and a story branch whose clause 2 only passes under a grant. */
  function storyClone(): string {
    const base = mkdtempSync(join(tmpdir(), "pre-pr-6888-retry-"));
    bases.push(base);
    const bare = join(base, "origin.git");
    const root = join(base, "clone");
    mkdirSync(bare);
    mkdirSync(root);
    git(bare, ["init", "-q", "--bare", "-b", "master"]);
    git(root, ["init", "-q", "-b", "master"]);
    git(root, ["config", "user.email", "t@example.com"]);
    git(root, ["config", "user.name", "t"]);
    git(root, ["remote", "add", "origin", bare]);
    write(root, ".gitignore", ".deft/\n");
    write(root, "README.md", "x\n");
    git(root, ["add", "-A"]);
    git(root, ["commit", "-q", "-m", "base"]);
    git(root, ["push", "-q", "-u", "origin", "master"]);
    git(root, ["checkout", "-q", "-b", `story/${PLAN_ID}`]);
    write(root, "src/a.ts", "export const PRESENT_TOKEN = 1;\n");
    const plan = {
      id: PLAN_ID,
      title: "retry fixture",
      status: "running",
      acceptance: {
        commands: [],
        none_stated: true,
        source_rung: "derived",
        ambiguity_attestation: "none_found",
        clauses: [
          {
            id: 1,
            text: 'The file contains "PRESENT_TOKEN" after the change.',
            artifact_path: "src/a.ts",
            ambiguous: false,
          },
          {
            id: 2,
            text: 'The file contains "ABSENT_NEEDLE_TOKEN" after the change.',
            artifact_path: "src/a.ts",
            ambiguous: false,
          },
        ],
      },
      metadata: { swarm: { file_scope: ["src/a.ts"] } },
      items: [],
    };
    write(
      root,
      "xbrief/active/story.xbrief.json",
      `${JSON.stringify({ xBRIEFInfo: { version: "0.8" }, plan }, null, 2)}\n`,
    );
    git(root, ["add", "-A"]);
    git(root, ["commit", "-q", "-m", "story"]);
    return root;
  }

  it("pass under a grant, grant expires, retry fails: evidence and the push gate refuse", () => {
    const root = storyClone();
    const minted = mintAcceptanceDispositionTemplateGrant({
      projectRoot: root,
      planRef: PLAN_ID,
      storyIds: ["clause.2"],
      disposition: "not_applicable",
      reason: "operator dropped clause 2",
      now: NOW,
    });
    if (!minted.ok) throw new Error(minted.reason);

    const store = new FileBackedPrePrStore(root);
    setDefaultPrePrStore(store);
    const head = git(root, ["rev-parse", "HEAD"]);
    const base = git(root, ["merge-base", head, "origin/master"]);
    const reviewed = ["src/a.ts", "xbrief/active/story.xbrief.json"];
    const criteria = digestApprovedCriteria({
      sourceRevisionSha: base,
      scopePaths: reviewed,
      acceptanceText: "fixture",
      generation: 1,
    });
    const runId = "ppr_6888_retry";
    const started = startControllerRun(store, {
      repo: "acme/app",
      baseSha: base,
      headSha: head,
      treeHash: git(root, ["rev-parse", "HEAD^{tree}"]),
      prBodyHash: "body",
      prNodeId: "PR_1",
      criteria,
      skillVersion: "0.1",
      policyVersion: "1",
      approvedRevisionSha: base,
      runId,
    });
    expect(started.ok).toBe(true);
    const record = store.getById(runId);
    if (record === null) throw new Error("run not stored");
    const observed = computeControllerObservedHash({ reviewedFiles: reviewed, cwd: root }) ?? "";
    for (const spec of PRE_PR_PHASES) {
      if (!spec.required) continue;
      if (spec.kind === "command-observable") {
        observeCommandPhase(
          store,
          runId,
          {
            phaseId: spec.id,
            command: spec.command ?? "",
            exitCode: 0,
            inputHash: record.inputHash,
            skipReason: null,
            ...(spec.id === "lint_iteration" ? { gateChecks: PASS_GATES() } : {}),
          },
          { projectRoot: root },
        );
      } else {
        submitReviewerReport(store, runId, {
          phaseId: spec.id,
          reviewedFileManifest: reviewed,
          suppliedContentsHash: observed,
          criteriaDigest: criteria.digest,
          reviewerReportRef: "fixture",
          controllerObservedHash: observed,
        });
      }
    }

    const live = {
      repo: "acme/app",
      baseSha: base,
      headSha: head,
      prNodeId: "PR_1",
      prBodyHash: "body",
    };
    const evidence = () =>
      evaluatePrePrEvidence({
        record: store.getById(runId),
        liveBinding: live,
        presentedRunId: runId,
        approvedCriteria: criteria,
        currentGeneration: 1,
      });
    const stdin = `refs/heads/story/${PLAN_ID} ${head} refs/heads/story/${PLAN_ID} ${ZERO}\n`;
    const push = () =>
      evaluatePrePush(parsePrePushStdin(stdin), {
        projectRoot: root,
        enrolledBoundPrePr: true,
        rawStdin: stdin,
      });

    // First complete: the unused grant covers clause 2, so verify:ac passes.
    const passed = resolveControllerVerifyAc({ projectRoot: root, now: NOW });
    expect(passed.kind).toBe("evaluated-pass");
    expect(
      completeRun(store, controllerPublisher(), runId, NOW, {
        projectRoot: root,
        skipNamedMergeGate: true,
        verifyAcResult: passed,
      }).ok,
    ).toBe(true);
    expect(evidence().ok).toBe(true);
    expect(push()[0]).toBe(0);

    // Retry after the unused grant expired, with no file or HEAD change: verify:ac fails.
    const failed = resolveControllerVerifyAc({ projectRoot: root, now: AFTER_EXPIRY });
    expect(failed.kind).toBe("fail");
    const retry = completeRun(store, controllerPublisher(), runId, AFTER_EXPIRY, {
      projectRoot: root,
      skipNamedMergeGate: true,
      verifyAcResult: failed,
    });
    expect(retry.ok).toBe(false);
    const after = store.getById(runId);
    expect(after?.outcome).not.toBe("pass");
    expect(after?.pushBinding).toBeNull();
    expect(evidence().ok).toBe(false);
    const [code, message] = push();
    expect(code).toBe(1);
    expect(message).toContain("no completed pre-PR pass bound to this HEAD");
  });

  it("a failed retry also revokes another stored pass for the same HEAD", () => {
    const store = new InProcessPrePrStore();
    const startAt = (runId: string) => {
      startControllerRun(store, {
        repo: "acme/app",
        baseSha: "base",
        headSha: "head",
        treeHash: "tree",
        prBodyHash: "body",
        prNodeId: null,
        criteria: digestApprovedCriteria({
          sourceRevisionSha: "base",
          scopePaths: ["a.ts"],
          acceptanceText: "ac",
          generation: 1,
        }),
        skillVersion: "0.1",
        policyVersion: "1",
        approvedRevisionSha: "base",
        runId,
      });
    };
    startAt("ppr_6888_sibling");
    startAt("ppr_6888_retry_b");
    const sibling = store.getById("ppr_6888_sibling");
    if (sibling === null) throw new Error("sibling not stored");
    // A sibling pass for the same repo and HEAD, as an earlier complete left it.
    store.put({
      ...sibling,
      state: "complete",
      outcome: "pass",
      completedAt: "2026-11-20T10:00:00Z",
      publishedAt: "2026-11-20T10:00:00Z",
    });
    const d = completeRun(store, controllerPublisher(), "ppr_6888_retry_b", undefined, {
      skipNamedMergeGate: true,
      verifyAcResult: { kind: "fail", output: "verify:ac FAIL" },
    });
    expect(d.ok).toBe(false);
    expect(store.getById("ppr_6888_sibling")?.outcome).toBe("none");
    expect(store.getById("ppr_6888_sibling")?.publishedAt).toBeNull();
  });
});

describe("leaf ergonomics for finishing a controller run (#6893)", () => {
  let base: string;
  let root: string;
  let store: InProcessPrePrStore;

  function git(cwd: string, args: readonly string[]): string {
    return execFileSync("git", [...args], { cwd, encoding: "utf8" }).trim();
  }

  function capture(): { out: string[]; err: string[] } {
    const out: string[] = [];
    const err: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      out.push(String(chunk));
      return true;
    });
    vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
      err.push(String(chunk));
      return true;
    });
    return { out, err };
  }

  /** A repo with a base commit and a head commit made by `change`. */
  function repo(change: (dir: string) => void): { baseSha: string; headSha: string } {
    git(root, ["init", "-q", "-b", "master"]);
    git(root, ["config", "user.email", "t@example.com"]);
    git(root, ["config", "user.name", "t"]);
    writeFileSync(join(root, "kept.ts"), "kept\n");
    writeFileSync(join(root, "gone.ts"), "gone\n");
    git(root, ["add", "-A"]);
    git(root, ["commit", "-q", "-m", "base"]);
    const baseSha = git(root, ["rev-parse", "HEAD"]);
    change(root);
    git(root, ["add", "-A"]);
    git(root, ["commit", "-q", "--allow-empty", "-m", "head"]);
    return { baseSha, headSha: git(root, ["rev-parse", "HEAD"]) };
  }

  function startRun(runId: string, shas: { baseSha: string; headSha: string }): void {
    expect(
      run([
        "--repo",
        "acme/app",
        "--base-sha",
        shas.baseSha,
        "--head-sha",
        shas.headSha,
        "--tree-hash",
        "tree",
        "--pr-body-hash",
        "body",
        "--approved-revision",
        shas.baseSha,
        "--run-id",
        runId,
        "--project-root",
        root,
        "--json",
      ]),
    ).toBe(0);
  }

  function observeSemantic(runId: string, phase: string, extra: readonly string[] = []): number {
    return run([
      "--observe-semantic",
      "--run-id",
      runId,
      "--phase",
      phase,
      "--project-root",
      root,
      ...extra,
    ]);
  }

  function observeCommand(runId: string, phase: string, exitCode = 0): number {
    return run(
      [
        "--observe-command",
        "--run-id",
        runId,
        "--phase",
        phase,
        "--exit-code",
        String(exitCode),
        "--project-root",
        root,
      ],
      { gateChecks: PASS_GATES },
    );
  }

  /** Every required phase in order, semantic phases with only --run-id and --phase. */
  function recordAll(runId: string): void {
    for (const spec of PRE_PR_PHASES.filter((p) => p.required)) {
      const code =
        spec.kind === "command-observable"
          ? observeCommand(runId, spec.id)
          : observeSemantic(runId, spec.id);
      expect(code).toBe(0);
    }
  }

  function changeTwoFiles(dir: string): void {
    writeFileSync(join(dir, "kept.ts"), "kept v2\n");
    writeFileSync(join(dir, "added.ts"), "added\n");
    rmSync(join(dir, "gone.ts"));
  }

  function semanticRow(runId: string, phase: string) {
    return store.getById(runId)?.phaseEvidence.semantic.find((s) => s.phaseId === phase);
  }

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), "pre-pr-6893-"));
    root = join(base, "repo");
    mkdirSync(root);
    store = new InProcessPrePrStore();
    setDefaultPrePrStore(store);
  });

  afterEach(() => {
    resetDefaultPrePrStore();
    rmSync(base, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("records a semantic phase with no hash and no file list, from base..head and the controller's hash", () => {
    const shas = repo(changeTwoFiles);
    startRun("ppr_6893_default", shas);
    capture();
    expect(observeSemantic("ppr_6893_default", "read")).toBe(0);
    const row = semanticRow("ppr_6893_default", "read");
    // The present changed files only: gone.ts was deleted.
    expect(row?.reviewedFileManifest).toEqual(["added.ts", "kept.ts"]);
    expect(row?.reviewedFileManifest).toEqual(
      git(root, ["diff", "--name-only", "--diff-filter=d", `${shas.baseSha}..${shas.headSha}`])
        .split("\n")
        .filter((p) => p.length > 0),
    );
    const expected = computeControllerObservedHash({
      reviewedFiles: ["added.ts", "kept.ts"],
      cwd: root,
    });
    expect(expected).not.toBeNull();
    expect(row?.controllerObservedHash).toBe(expected);
    expect(row?.suppliedContentsHash).toBe(expected);
  });

  it("a wrong explicit hash still refuses, and explicit --reviewed-file paths replace the default", () => {
    const shas = repo(changeTwoFiles);
    startRun("ppr_6893_explicit", shas);
    const { err } = capture();
    expect(
      observeSemantic("ppr_6893_explicit", "read", ["--supplied-contents-hash", "forged"]),
    ).toBe(1);
    expect(err.join("")).toMatch(/does not match independently hashed/);
    expect(semanticRow("ppr_6893_explicit", "read")).toBeUndefined();
    expect(observeSemantic("ppr_6893_explicit", "read", ["--reviewed-file", "kept.ts"])).toBe(0);
    expect(semanticRow("ppr_6893_explicit", "read")?.reviewedFileManifest).toEqual(["kept.ts"]);
    // A matching explicit hash is accepted.
    const right = computeControllerObservedHash({ reviewedFiles: ["kept.ts"], cwd: root }) ?? "";
    expect(
      observeSemantic("ppr_6893_explicit", "write", [
        "--reviewed-file",
        "kept.ts",
        "--supplied-contents-hash",
        right,
      ]),
    ).toBe(0);
  });

  it("a deletion-only change refuses and names --reviewed-file", () => {
    const shas = repo((dir) => rmSync(join(dir, "gone.ts")));
    startRun("ppr_6893_deleted", shas);
    const { err } = capture();
    expect(observeSemantic("ppr_6893_deleted", "read")).toBe(2);
    expect(err.join("")).toMatch(/deletion-only change or no change/);
    expect(err.join("")).toContain("--reviewed-file");
    expect(observeSemantic("ppr_6893_deleted", "read", ["--reviewed-file", "kept.ts"])).toBe(0);
  });

  it("an empty diff refuses and names --reviewed-file", () => {
    const shas = repo(() => {});
    startRun("ppr_6893_empty", shas);
    const { err } = capture();
    expect(observeSemantic("ppr_6893_empty", "read")).toBe(2);
    expect(err.join("")).toContain("Name the reviewed files with --reviewed-file");
    expect(semanticRow("ppr_6893_empty", "read")).toBeUndefined();
  });

  it("names the missing required phases, a new run when failed, and --complete when none are missing", () => {
    const shas = repo(changeTwoFiles);
    startRun("ppr_6893_next", shas);
    const { out } = capture();
    expect(observeCommand("ppr_6893_next", "branch_policy")).toBe(0);
    expect(out.join("")).toContain(
      "Required phases not yet recorded, in order: plan_sequence, read, write, lint_iteration, render_export, diff, loop.",
    );
    out.length = 0;
    recordAll("ppr_6893_next");
    const last = out.join("").trim().split("\n").at(-1) ?? "";
    expect(last).toContain("Every required phase is recorded");
    expect(last).toContain("--complete --run-id ppr_6893_next");
    expect(last).not.toMatch(/\bpass(ed)?\b/);

    startRun("ppr_6893_failed", shas);
    out.length = 0;
    expect(observeCommand("ppr_6893_failed", "branch_policy", 1)).toBe(0);
    expect(out.join("")).toContain("recorded failure");
    expect(out.join("")).toContain("start a new run");
    expect(out.join("")).not.toContain("Required phases not yet recorded");
  });

  it("--json observe output carries the next step", () => {
    const shas = repo(changeTwoFiles);
    startRun("ppr_6893_json", shas);
    const { out } = capture();
    expect(observeSemantic("ppr_6893_json", "read", ["--json"])).toBe(0);
    const payload = JSON.parse(out.join("").trim()) as { ok: boolean; next: string };
    expect(payload.ok).toBe(true);
    expect(payload.next).toMatch(/^Required phases not yet recorded, in order: branch_policy/);
  });

  for (const [label, setting, expected] of [
    ["true", true, "requireBoundPrePrPush is true, so"],
    ["false", false, "requireBoundPrePrPush is false, so"],
    ["not set", undefined, "requireBoundPrePrPush is not set, so"],
  ] as const) {
    it(`--complete reports the push-gate setting when it is ${label}`, () => {
      const shas = repo(changeTwoFiles);
      mkdirSync(join(root, "xbrief"), { recursive: true });
      const policy = setting === undefined ? {} : { requireBoundPrePrPush: setting };
      writeFileSync(
        join(root, "xbrief", "PROJECT-DEFINITION.xbrief.json"),
        JSON.stringify({ plan: { policy } }),
      );
      startRun("ppr_6893_push", shas);
      recordAll("ppr_6893_push");
      const { out } = capture();
      expect(
        run(["--complete", "--run-id", "ppr_6893_push", "--project-root", root], {
          skipNamedMergeGate: true,
          verifyAc: VERIFY_AC_PASS,
        }),
      ).toBe(0);
      const text = out.join("");
      expect(text).toContain("published ppr_6893_push");
      expect(text).toContain(expected);
      expect(text).toContain("Completing a run is not push admission.");
      if (setting === undefined) expect(text).toContain("--push-admit` treats not set as on");
    });
  }

  it("--complete --json carries the push-gate setting", () => {
    const shas = repo(changeTwoFiles);
    startRun("ppr_6893_push_json", shas);
    recordAll("ppr_6893_push_json");
    const { out } = capture();
    expect(
      run(["--complete", "--run-id", "ppr_6893_push_json", "--project-root", root, "--json"], {
        skipNamedMergeGate: true,
        verifyAc: VERIFY_AC_PASS,
      }),
    ).toBe(0);
    const payload = JSON.parse(out.join("").trim()) as {
      ok: boolean;
      requireBoundPrePrPush: boolean | null;
      pushGate: string;
    };
    expect(payload.ok).toBe(true);
    expect(payload.requireBoundPrePrPush).toBeNull();
    expect(payload.pushGate).toContain("not set");
  });

  it("the usage text lists the phase order, the optional phases and the run rules", () => {
    const { out } = capture();
    expect(run(["--help"])).toBe(0);
    const text = out.join("");
    expect(text).toContain(
      "Required, in this order: branch_policy, plan_sequence, read, write,\n  lint_iteration, render_export, diff, loop.",
    );
    expect(text).toContain("Optional: coverage_headroom, merge_chokepoint.");
    expect(text).toContain("A recorded failure ends the run.");
    expect(text).toContain(
      "A phase recorded out of order is fixed by recording it and every later",
    );
    expect(text).toContain("merge_chokepoint is optional.");
    expect(text).toContain("does not need a PR");
    expect(text).toContain("Completing a run is not push");
    // The usage order is the controller's order.
    expect(PRE_PR_PHASES.filter((p) => p.required).map((p) => p.id)).toEqual([
      "branch_policy",
      "plan_sequence",
      "read",
      "write",
      "lint_iteration",
      "render_export",
      "diff",
      "loop",
    ]);
  });
});
