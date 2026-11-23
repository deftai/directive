#!/usr/bin/env node
/**
 * Agent-facing pre-PR controller entry (#4912 Limb 3).
 * `deft pre-pr:run` starts the prescribed workflow. Opening the skill file
 * is not completion. Generic mark-complete cannot mint a pass.
 */
import { readFileSync } from "node:fs";
import { writeStoryLineToBodyFile } from "@deftai/directive-core/pr-closing-keywords";
import { defaultRunGh } from "@deftai/directive-core/pr-merge-readiness";
import {
  type ControllerVerifyAcResult,
  completeRun,
  computeControllerObservedHash,
  controllerPublisher,
  describeBoundPrePrPushSetting,
  digestApprovedCriteria,
  evaluateLivePrePrCheck,
  getDefaultPrePrStore,
  hashPrBody,
  listPresentChangedPathsBetween,
  markComplete,
  noteSkillFileOpen,
  observeCommandPhase,
  PRE_PR_PHASE_IDS,
  type PrePrExecutionRecord,
  type PrePrGateCheckResult,
  type PrePrPhaseId,
  phaseSpec,
  prePrNextStep,
  readRequireBoundPrePrPushSetting,
  resolveRecordFromStore,
  runPrePrGateChecks,
  startControllerRun,
  submitReviewerReport,
} from "@deftai/directive-core/pre-pr-controller";
import { evaluatePrePush, parsePrePushStdin } from "@deftai/directive-core/preflight";
import type { VerifyAcDispositionKind } from "@deftai/directive-core/product-first-done-gate";
import { isDirectEntrypoint } from "./entrypoint.js";
import { resolveControllerVerifyAc } from "./verify-ac.js";

const USAGE = `Usage: deft pre-pr:run [options]

Start the repository-controlled pre-PR workflow. Opening the skill file is
not completion. A generic mark-complete cannot mint a pass.

Options:
  --repo <owner/name>
  --base-sha <sha>
  --head-sha <sha>
  --tree-hash <sha>
  --pr-body-hash <hex>
  --pr-node-id <id>
  --approved-revision <sha>
  --scope <path>          (repeatable)
  --acceptance <text>
  --generation <n>
  --skill-version <ver>
  --policy-version <ver>
  --run-id <id>           lookup hint only
  --complete              publisher-backed complete (fails without observables).
                          Runs verify:ac story selection and evaluation itself
                          and records the disposition from that result; a
                          failed verify:ac refuses and publishes nothing (#6888)
  --observe-command       record a command-observable phase before --complete
  --observe-semantic      record semantic / final-no-change evidence; needs only
                          --run-id and --phase (#6893)
  --phase <id>
  --command <text>
  --exit-code <n>         required with --observe-command; omit is a parse error
  --input-hash <hex>
  --skip-reason <text>    skip also requires a non-zero --exit-code
  --supplied-contents-hash <hex>
                          optional; the controller hashes the reviewed files
                          itself, and a given value must match that hash
  --controller-observed-hash <hex>
                          optional; must match independently hashed reviewed files
  --criteria-digest <hex>
  --reviewed-file <path>  (repeatable) optional; replaces the default list, which
                          is the run's present changed files from base..head at
                          the project root. An empty default list (deletion-only
                          change or no change) refuses: name the reviewed files
                          with --reviewed-file
  --reviewer-report-ref <ref>
  --verify-ac-disposition <executed-ac|no-obligation>
                          optional with --complete; a value that differs from
                          the controller's verify:ac result refuses (#6888)
  --mark-complete         always refuses; cannot mint a pass
  --skill-open            always refuses; opening the skill is not completion
  --evaluate              evaluate live binding against the private store
  --push-admit            enrolled push admission (#5804); reads pre-push stdin
  --project-root <path>   project root (default: the cwd) for the private store,
                          the gate checks, relative --reviewed-file paths,
                          --complete and --push-admit (#6902). --body-file
                          paths stay relative to the cwd.
  --body-file <path>      PR body file: before start, append the story line
                          (deft-story: N) for the branch's running story (#6316);
                          alone, runs only that step. With start, the run binds
                          the sha256 of the file after that step (--pr-body-hash
                          may be omitted; a different value is refused).
                          With --evaluate, hashes the stored body saved to
                          the file. Both sides ignore CRLF and trailing
                          newlines (#6336)
  --part                  with --body-file: write deft-story-part: N instead
  --json
  --help

Phases (#6893):
  Required, in this order: branch_policy, plan_sequence, read, write,
  lint_iteration, render_export, diff, loop.
  Optional: coverage_headroom, merge_chokepoint.
  - A recorded failure ends the run. Start a new run and record every
    required phase again.
  - A phase recorded out of order is fixed by recording it and every later
    required phase again.
  - Semantic hashes cover the working-tree files at the project root, so
    record phases on the run's head with no uncommitted changes.
  - Each successful observe names the required phases still missing.
  - merge_chokepoint is optional. Record it only after a \`deft check\` run
    the work needed anyway (conflict resolve or behind-rebase).
  - --complete runs verify:ac itself (#6888) and does not need a PR. When
    master's named Merge gate is red, it refuses and names that gate first.
  - On success, --complete prints plan.policy.requireBoundPrePrPush and what
    the managed pre-push hook does with it. Completing a run is not push
    admission.
`;

interface ParsedArgs {
  repo: string;
  baseSha: string;
  headSha: string;
  treeHash: string;
  prBodyHash: string;
  prNodeId: string | null;
  approvedRevision: string;
  scope: string[];
  acceptance: string;
  generation: number;
  skillVersion: string;
  policyVersion: string;
  runId: string | null;
  complete: boolean;
  observeCommand: boolean;
  observeSemantic: boolean;
  phase: string | null;
  command: string;
  exitCode: number | null;
  inputHash: string | null;
  skipReason: string | null;
  suppliedContentsHash: string;
  controllerObservedHash: string;
  criteriaDigest: string | null;
  reviewedFiles: string[];
  reviewerReportRef: string | null;
  markComplete: boolean;
  skillOpen: boolean;
  evaluate: boolean;
  pushAdmit: boolean;
  projectRoot: string | null;
  bodyFile: string | null;
  part: boolean;
  verifyAcDisposition: VerifyAcDispositionKind | null;
  json: boolean;
  help: boolean;
  error?: string;
}

export function parseArgs(argv: string[]): ParsedArgs {
  const parsed: ParsedArgs = {
    repo: "",
    baseSha: "",
    headSha: "",
    treeHash: "",
    prBodyHash: "",
    prNodeId: null,
    approvedRevision: "",
    scope: [],
    acceptance: "",
    generation: 1,
    skillVersion: "0.1",
    policyVersion: "1",
    runId: null,
    complete: false,
    observeCommand: false,
    observeSemantic: false,
    phase: null,
    command: "",
    exitCode: null,
    inputHash: null,
    skipReason: null,
    suppliedContentsHash: "",
    controllerObservedHash: "",
    criteriaDigest: null,
    reviewedFiles: [],
    reviewerReportRef: null,
    markComplete: false,
    skillOpen: false,
    evaluate: false,
    pushAdmit: false,
    projectRoot: null,
    bodyFile: null,
    part: false,
    verifyAcDisposition: null,
    json: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      parsed.help = true;
    } else if (arg === "--json") {
      parsed.json = true;
    } else if (arg === "--complete") {
      parsed.complete = true;
    } else if (arg === "--observe-command") {
      parsed.observeCommand = true;
    } else if (arg === "--observe-semantic") {
      parsed.observeSemantic = true;
    } else if (arg === "--phase" || arg?.startsWith("--phase=")) {
      const value = arg === "--phase" ? argv[i + 1] : arg.slice("--phase=".length);
      if (value === undefined)
        return { ...parsed, error: "argument --phase: expected one argument" };
      parsed.phase = value;
      if (arg === "--phase") i += 1;
    } else if (arg === "--command" || arg?.startsWith("--command=")) {
      const value = arg === "--command" ? argv[i + 1] : arg.slice("--command=".length);
      if (value === undefined)
        return { ...parsed, error: "argument --command: expected one argument" };
      parsed.command = value;
      if (arg === "--command") i += 1;
    } else if (arg === "--exit-code" || arg?.startsWith("--exit-code=")) {
      const value = arg === "--exit-code" ? argv[i + 1] : arg.slice("--exit-code=".length);
      if (value === undefined) {
        return { ...parsed, error: "argument --exit-code: expected one argument" };
      }
      const n = Number.parseInt(value, 10);
      if (!Number.isFinite(n)) {
        return { ...parsed, error: "argument --exit-code: expected an integer" };
      }
      parsed.exitCode = n;
      if (arg === "--exit-code") i += 1;
    } else if (arg === "--input-hash" || arg?.startsWith("--input-hash=")) {
      const value = arg === "--input-hash" ? argv[i + 1] : arg.slice("--input-hash=".length);
      if (value === undefined) {
        return { ...parsed, error: "argument --input-hash: expected one argument" };
      }
      parsed.inputHash = value;
      if (arg === "--input-hash") i += 1;
    } else if (arg === "--skip-reason" || arg?.startsWith("--skip-reason=")) {
      const value = arg === "--skip-reason" ? argv[i + 1] : arg.slice("--skip-reason=".length);
      if (value === undefined) {
        return { ...parsed, error: "argument --skip-reason: expected one argument" };
      }
      parsed.skipReason = value;
      if (arg === "--skip-reason") i += 1;
    } else if (arg === "--supplied-contents-hash" || arg?.startsWith("--supplied-contents-hash=")) {
      const value =
        arg === "--supplied-contents-hash"
          ? argv[i + 1]
          : arg.slice("--supplied-contents-hash=".length);
      if (value === undefined) {
        return { ...parsed, error: "argument --supplied-contents-hash: expected one argument" };
      }
      parsed.suppliedContentsHash = value;
      if (arg === "--supplied-contents-hash") i += 1;
    } else if (
      arg === "--controller-observed-hash" ||
      arg?.startsWith("--controller-observed-hash=")
    ) {
      const value =
        arg === "--controller-observed-hash"
          ? argv[i + 1]
          : arg.slice("--controller-observed-hash=".length);
      if (value === undefined) {
        return {
          ...parsed,
          error: "argument --controller-observed-hash: expected one argument",
        };
      }
      parsed.controllerObservedHash = value;
      if (arg === "--controller-observed-hash") i += 1;
    } else if (arg === "--criteria-digest" || arg?.startsWith("--criteria-digest=")) {
      const value =
        arg === "--criteria-digest" ? argv[i + 1] : arg.slice("--criteria-digest=".length);
      if (value === undefined) {
        return { ...parsed, error: "argument --criteria-digest: expected one argument" };
      }
      parsed.criteriaDigest = value;
      if (arg === "--criteria-digest") i += 1;
    } else if (arg === "--reviewed-file" || arg?.startsWith("--reviewed-file=")) {
      const value = arg === "--reviewed-file" ? argv[i + 1] : arg.slice("--reviewed-file=".length);
      if (value === undefined) {
        return { ...parsed, error: "argument --reviewed-file: expected one argument" };
      }
      parsed.reviewedFiles.push(value);
      if (arg === "--reviewed-file") i += 1;
    } else if (arg === "--reviewer-report-ref" || arg?.startsWith("--reviewer-report-ref=")) {
      const value =
        arg === "--reviewer-report-ref" ? argv[i + 1] : arg.slice("--reviewer-report-ref=".length);
      if (value === undefined) {
        return { ...parsed, error: "argument --reviewer-report-ref: expected one argument" };
      }
      parsed.reviewerReportRef = value;
      if (arg === "--reviewer-report-ref") i += 1;
    } else if (arg === "--mark-complete") {
      parsed.markComplete = true;
    } else if (arg === "--skill-open") {
      parsed.skillOpen = true;
    } else if (arg === "--evaluate") {
      parsed.evaluate = true;
    } else if (arg === "--push-admit") {
      parsed.pushAdmit = true;
    } else if (arg === "--part") {
      parsed.part = true;
    } else if (arg === "--body-file" || arg?.startsWith("--body-file=")) {
      const value = arg === "--body-file" ? argv[i + 1] : arg.slice("--body-file=".length);
      if (value === undefined || value.length === 0) {
        return { ...parsed, error: "argument --body-file: expected one argument" };
      }
      parsed.bodyFile = value;
      if (arg === "--body-file") i += 1;
    } else if (arg === "--project-root" || arg?.startsWith("--project-root=")) {
      const value = arg === "--project-root" ? argv[i + 1] : arg.slice("--project-root=".length);
      if (value === undefined) {
        return { ...parsed, error: "argument --project-root: expected one argument" };
      }
      parsed.projectRoot = value;
      if (arg === "--project-root") i += 1;
    } else if (arg === "--repo" || arg?.startsWith("--repo=")) {
      const value = arg === "--repo" ? argv[i + 1] : arg.slice("--repo=".length);
      if (value === undefined)
        return { ...parsed, error: "argument --repo: expected one argument" };
      parsed.repo = value;
      if (arg === "--repo") i += 1;
    } else if (arg === "--base-sha" || arg?.startsWith("--base-sha=")) {
      const value = arg === "--base-sha" ? argv[i + 1] : arg.slice("--base-sha=".length);
      if (value === undefined)
        return { ...parsed, error: "argument --base-sha: expected one argument" };
      parsed.baseSha = value;
      if (arg === "--base-sha") i += 1;
    } else if (arg === "--head-sha" || arg?.startsWith("--head-sha=")) {
      const value = arg === "--head-sha" ? argv[i + 1] : arg.slice("--head-sha=".length);
      if (value === undefined)
        return { ...parsed, error: "argument --head-sha: expected one argument" };
      parsed.headSha = value;
      if (arg === "--head-sha") i += 1;
    } else if (arg === "--tree-hash" || arg?.startsWith("--tree-hash=")) {
      const value = arg === "--tree-hash" ? argv[i + 1] : arg.slice("--tree-hash=".length);
      if (value === undefined)
        return { ...parsed, error: "argument --tree-hash: expected one argument" };
      parsed.treeHash = value;
      if (arg === "--tree-hash") i += 1;
    } else if (arg === "--pr-body-hash" || arg?.startsWith("--pr-body-hash=")) {
      const value = arg === "--pr-body-hash" ? argv[i + 1] : arg.slice("--pr-body-hash=".length);
      if (value === undefined) {
        return { ...parsed, error: "argument --pr-body-hash: expected one argument" };
      }
      parsed.prBodyHash = value;
      if (arg === "--pr-body-hash") i += 1;
    } else if (arg === "--pr-node-id" || arg?.startsWith("--pr-node-id=")) {
      const value = arg === "--pr-node-id" ? argv[i + 1] : arg.slice("--pr-node-id=".length);
      if (value === undefined) {
        return { ...parsed, error: "argument --pr-node-id: expected one argument" };
      }
      parsed.prNodeId = value;
      if (arg === "--pr-node-id") i += 1;
    } else if (arg === "--approved-revision" || arg?.startsWith("--approved-revision=")) {
      const value =
        arg === "--approved-revision" ? argv[i + 1] : arg.slice("--approved-revision=".length);
      if (value === undefined) {
        return { ...parsed, error: "argument --approved-revision: expected one argument" };
      }
      parsed.approvedRevision = value;
      if (arg === "--approved-revision") i += 1;
    } else if (arg === "--scope" || arg?.startsWith("--scope=")) {
      const value = arg === "--scope" ? argv[i + 1] : arg.slice("--scope=".length);
      if (value === undefined)
        return { ...parsed, error: "argument --scope: expected one argument" };
      parsed.scope.push(value);
      if (arg === "--scope") i += 1;
    } else if (arg === "--acceptance" || arg?.startsWith("--acceptance=")) {
      const value = arg === "--acceptance" ? argv[i + 1] : arg.slice("--acceptance=".length);
      if (value === undefined) {
        return { ...parsed, error: "argument --acceptance: expected one argument" };
      }
      parsed.acceptance = value;
      if (arg === "--acceptance") i += 1;
    } else if (arg === "--generation" || arg?.startsWith("--generation=")) {
      const value = arg === "--generation" ? argv[i + 1] : arg.slice("--generation=".length);
      if (value === undefined) {
        return { ...parsed, error: "argument --generation: expected one argument" };
      }
      const n = Number.parseInt(value, 10);
      if (!Number.isFinite(n) || n < 1) {
        return { ...parsed, error: "argument --generation: expected a positive integer" };
      }
      parsed.generation = n;
      if (arg === "--generation") i += 1;
    } else if (arg === "--skill-version" || arg?.startsWith("--skill-version=")) {
      const value = arg === "--skill-version" ? argv[i + 1] : arg.slice("--skill-version=".length);
      if (value === undefined) {
        return { ...parsed, error: "argument --skill-version: expected one argument" };
      }
      parsed.skillVersion = value;
      if (arg === "--skill-version") i += 1;
    } else if (arg === "--policy-version" || arg?.startsWith("--policy-version=")) {
      const value =
        arg === "--policy-version" ? argv[i + 1] : arg.slice("--policy-version=".length);
      if (value === undefined) {
        return { ...parsed, error: "argument --policy-version: expected one argument" };
      }
      parsed.policyVersion = value;
      if (arg === "--policy-version") i += 1;
    } else if (arg === "--run-id" || arg?.startsWith("--run-id=")) {
      const value = arg === "--run-id" ? argv[i + 1] : arg.slice("--run-id=".length);
      if (value === undefined)
        return { ...parsed, error: "argument --run-id: expected one argument" };
      parsed.runId = value;
      if (arg === "--run-id") i += 1;
    } else if (arg === "--verify-ac-disposition" || arg?.startsWith("--verify-ac-disposition=")) {
      const value =
        arg === "--verify-ac-disposition"
          ? argv[i + 1]
          : arg.slice("--verify-ac-disposition=".length);
      if (value === undefined) {
        return { ...parsed, error: "argument --verify-ac-disposition: expected one argument" };
      }
      if (value !== "executed-ac" && value !== "no-obligation") {
        return {
          ...parsed,
          error: "argument --verify-ac-disposition: expected executed-ac|no-obligation",
        };
      }
      parsed.verifyAcDisposition = value;
      if (arg === "--verify-ac-disposition") i += 1;
    } else {
      return { ...parsed, error: `unrecognized argument: ${arg}` };
    }
  }
  return parsed;
}

function emit(json: boolean, payload: unknown, text: string, err: boolean): void {
  const line = json ? `${JSON.stringify(payload)}\n` : `${text}\n`;
  if (err) process.stderr.write(line);
  else process.stdout.write(line);
}

/** Observe result plus the next step (#6893): missing phases, a new run, or --complete. */
function emitObserved(
  json: boolean,
  d: { readonly ok: boolean; readonly message: string },
  record: PrePrExecutionRecord | null,
): void {
  if (!d.ok || record === null) {
    emit(json, d, d.message, !d.ok);
    return;
  }
  const next = prePrNextStep(record);
  emit(json, { ...d, next }, `${d.message}\n${next}`, false);
}

function asPhaseId(value: string): PrePrPhaseId | null {
  return (PRE_PR_PHASE_IDS as readonly string[]).includes(value) ? (value as PrePrPhaseId) : null;
}

export interface PrePrRunOptions {
  /** Hermetic tests inject this; production CLI never sets it (#6071 Greptile). */
  readonly skipNamedMergeGate?: boolean;
  /** Story-line writer seam for hermetic tests (#6316). */
  readonly writeStoryLine?: typeof writeStoryLineToBodyFile;
  /** lint_iteration CI gate runner seam for hermetic tests (#6336); defaults to in-process gates. */
  readonly gateChecks?: (
    projectRoot: string,
    baseRef: string | null,
  ) => readonly PrePrGateCheckResult[];
  /** Controller-owned verify:ac seam for hermetic tests (#6888); defaults to resolveControllerVerifyAc. */
  readonly verifyAc?: (projectRoot: string) => ControllerVerifyAcResult;
}

/** No start binding beyond --repo (which the story-line step also reads). */
function startArgsAbsent(args: ParsedArgs): boolean {
  return (
    args.baseSha.length === 0 &&
    args.headSha.length === 0 &&
    args.treeHash.length === 0 &&
    args.prBodyHash.length === 0 &&
    args.approvedRevision.length === 0
  );
}

export function run(argv: string[], options: PrePrRunOptions = {}): number {
  const args = parseArgs(argv);
  if (args.help) {
    process.stdout.write(USAGE);
    return 0;
  }
  if (args.error !== undefined) {
    process.stderr.write(`pre_pr_run: ${args.error}\n`);
    return 2;
  }
  if (args.part && args.bodyFile === null) {
    process.stderr.write("pre_pr_run: --part requires --body-file\n");
    return 2;
  }
  // #6902: one project root for every path (store, gate checks, reviewed files,
  // complete, push-admit, story line). --body-file stays cwd-relative.
  const projectRoot = args.projectRoot?.trim() || process.cwd();
  if (args.pushAdmit) {
    let rawStdin = "";
    try {
      rawStdin = readFileSync(0, "utf8");
    } catch {
      rawStdin = "";
    }
    const refs = parsePrePushStdin(rawStdin);
    const [code, msg] = evaluatePrePush(refs, {
      projectRoot,
      enrolledBoundPrePr: true,
      rawStdin,
    });
    if (code === 0) process.stdout.write(`${msg}\n`);
    else process.stderr.write(`${msg}\n`);
    return code;
  }
  if (args.skillOpen) {
    const d = noteSkillFileOpen();
    emit(args.json, d, d.message, true);
    return 1;
  }
  const store = getDefaultPrePrStore(projectRoot);
  if (args.markComplete) {
    const d = markComplete(store, args.runId ?? "");
    emit(args.json, d, d.message, true);
    return 1;
  }
  if (args.observeCommand || args.observeSemantic) {
    if (args.runId === null || args.runId.length === 0) {
      process.stderr.write("pre_pr_run: observe requires --run-id\n");
      return 2;
    }
    if (args.phase === null || args.phase.length === 0) {
      process.stderr.write("pre_pr_run: observe requires --phase\n");
      return 2;
    }
    const phase = asPhaseId(args.phase);
    if (phase === null) {
      process.stderr.write(`pre_pr_run: unknown phase ${args.phase}\n`);
      return 2;
    }
    const rec = store.getById(args.runId);
    if (args.observeCommand) {
      if (args.exitCode === null) {
        process.stderr.write("pre_pr_run: --observe-command requires --exit-code\n");
        return 2;
      }
      // #5814 / #5791: mode-skip pairs use non-zero exit (lint_iteration exit 5 + LINT_ITERATION_MODE_SKIP).
      if (args.skipReason !== null && args.skipReason.length > 0 && args.exitCode === 0) {
        process.stderr.write(
          "pre_pr_run: skip requires a non-zero --exit-code plus --skip-reason\n",
        );
        return 2;
      }
      const spec = phaseSpec(phase);
      // Same root as push-admit: one report path for observe and satisfy.
      // #6336 item 4: lint_iteration also runs verify:class-checks and
      // verify:evaluator-surface on the candidate tree and records both results.
      const gateChecks =
        phase === "lint_iteration"
          ? (options.gateChecks ?? runPrePrGateChecks)(projectRoot, rec?.baseSha ?? null)
          : undefined;
      const d = observeCommandPhase(
        store,
        args.runId,
        {
          phaseId: phase,
          command: args.command.length > 0 ? args.command : (spec.command ?? ""),
          exitCode: args.exitCode,
          inputHash: args.inputHash ?? rec?.inputHash ?? "",
          skipReason: args.skipReason,
          ...(gateChecks === undefined ? {} : { gateChecks }),
        },
        { projectRoot },
      );
      emitObserved(args.json, d, store.getById(args.runId));
      return d.ok ? 0 : 1;
    }
    // #6893: --reviewed-file is optional; the default is the run's present
    // changed files from base..head at the project root.
    let reviewedFiles = args.reviewedFiles;
    if (reviewedFiles.length === 0) {
      if (rec === null) {
        process.stderr.write(`pre_pr_run: pre-PR run ${args.runId} is not in the private store\n`);
        return 1;
      }
      const listed = listPresentChangedPathsBetween(projectRoot, rec.baseSha, rec.headSha);
      if (listed === null) {
        process.stderr.write(
          `pre_pr_run: --observe-semantic could not list the run's changed files (git diff ${rec.baseSha}..${rec.headSha} at ${projectRoot}). Name the reviewed files with --reviewed-file.\n`,
        );
        return 2;
      }
      if (listed.length === 0) {
        process.stderr.write(
          "pre_pr_run: --observe-semantic found no present changed files between the run's base and head (a deletion-only change or no change). Name the reviewed files with --reviewed-file.\n",
        );
        return 2;
      }
      reviewedFiles = listed;
    }
    // #6902: relative reviewed files resolve against the root, as completeRun re-hashes them.
    const observed = computeControllerObservedHash({
      reviewedFiles,
      cwd: projectRoot,
    });
    if (observed === null) {
      process.stderr.write(
        "pre_pr_run: --observe-semantic could not hash reviewed-file contents\n",
      );
      return 2;
    }
    if (args.controllerObservedHash.length > 0 && args.controllerObservedHash !== observed) {
      process.stderr.write(
        "pre_pr_run: --controller-observed-hash does not match independently hashed reviewed-file contents\n",
      );
      return 1;
    }
    // #6893: the supplied hash is optional; a given value must still match.
    if (args.suppliedContentsHash.length > 0 && args.suppliedContentsHash !== observed) {
      process.stderr.write(
        "pre_pr_run: --supplied-contents-hash does not match independently hashed reviewed-file contents\n",
      );
      return 1;
    }
    const d = submitReviewerReport(store, args.runId, {
      phaseId: phase,
      reviewedFileManifest: reviewedFiles,
      suppliedContentsHash: observed,
      criteriaDigest: args.criteriaDigest ?? rec?.criteria.digest ?? "",
      reviewerReportRef: args.reviewerReportRef,
      controllerObservedHash: observed,
    });
    emitObserved(args.json, d, store.getById(args.runId));
    return d.ok ? 0 : 1;
  }
  if (args.evaluate) {
    if (args.repo.length === 0 || args.baseSha.length === 0 || args.headSha.length === 0) {
      process.stderr.write("pre_pr_run: --evaluate requires --repo --base-sha --head-sha\n");
      return 2;
    }
    // #6336 item 8: --body-file (the stored PR body saved to a file) hashes with
    // the same normalisation as the start-side body file.
    if (args.prBodyHash.length === 0 && args.bodyFile !== null) {
      try {
        args.prBodyHash = hashPrBody(readFileSync(args.bodyFile, "utf8"));
      } catch (err: unknown) {
        process.stderr.write(
          `pre_pr_run: cannot hash --body-file: ${err instanceof Error ? err.message : String(err)}\n`,
        );
        return 2;
      }
    }
    if (args.prBodyHash.length === 0) {
      process.stderr.write("pre_pr_run: --evaluate requires --pr-body-hash or --body-file\n");
      return 2;
    }
    const record = resolveRecordFromStore(store, {
      id: args.runId,
      prNodeId: args.prNodeId,
    });
    const headSource =
      args.approvedRevision.length > 0
        ? args.approvedRevision
        : (record?.criteria.sourceRevisionSha ?? args.headSha);
    const liveApproved = digestApprovedCriteria({
      sourceRevisionSha: headSource,
      scopePaths: args.scope,
      acceptanceText: args.acceptance,
      generation: args.generation,
    });
    const d = evaluateLivePrePrCheck({
      store,
      liveBinding: {
        repo: args.repo,
        baseSha: args.baseSha,
        headSha: args.headSha,
        prNodeId: args.prNodeId,
        prBodyHash: args.prBodyHash,
      },
      presentedRunId: args.runId,
      approvedCriteria: liveApproved,
      currentGeneration: args.generation,
      headCriteria: liveApproved,
    });
    emit(args.json, d, d.message, !d.ok);
    return d.ok ? 0 : 1;
  }
  if (args.complete) {
    if (args.runId === null || args.runId.length === 0) {
      process.stderr.write("pre_pr_run: --complete requires --run-id\n");
      return 2;
    }
    // #5804 / #5994: projectRoot is required so completeRun can stamp
    // pushBinding.reviewedDeletedPaths from base..head.
    // #6888: --complete runs verify:ac itself on every call; the caller's
    // --verify-ac-disposition is only a claim that must match the result.
    const verifyAcResult = (
      options.verifyAc ?? ((root: string) => resolveControllerVerifyAc({ projectRoot: root }))
    )(projectRoot);
    if (verifyAcResult.kind === "fail" && verifyAcResult.output.length > 0) {
      process.stderr.write(`${verifyAcResult.output}\n`);
    }
    const d = completeRun(store, controllerPublisher(), args.runId, undefined, {
      projectRoot,
      verifyAcResult,
      // #6336 item 7: let the controller look up the head's PR before it says there is none.
      runGh: defaultRunGh,
      ...(options.skipNamedMergeGate === true ? { skipNamedMergeGate: true as const } : {}),
      ...(args.verifyAcDisposition !== null
        ? { verifyAcDisposition: args.verifyAcDisposition }
        : {}),
    });
    if (!d.ok) {
      emit(args.json, d, d.message, true);
      return 1;
    }
    // #6893: say whether this project's managed pre-push hook looks for the pass.
    const setting = readRequireBoundPrePrPushSetting(projectRoot);
    const pushGate = describeBoundPrePrPushSetting(setting);
    emit(
      args.json,
      { ...d, requireBoundPrePrPush: setting, pushGate },
      `${d.message}\n${pushGate}`,
      false,
    );
    return 0;
  }
  // #6316: the story line goes into the PR body file before the PR is opened.
  if (args.bodyFile !== null) {
    const writer = options.writeStoryLine ?? writeStoryLineToBodyFile;
    const written = writer({
      bodyFile: args.bodyFile,
      projectRoot,
      repo: args.repo.length > 0 ? args.repo : null,
      part: args.part,
    });
    if (written.code !== 0) {
      emit(args.json, written, written.message, true);
      return written.code;
    }
    if (startArgsAbsent(args)) {
      // #6934: the writer's message (and any part-line note) is on stderr in every
      // mode; with --json, stdout carries the writer JSON.
      if (args.json) emit(true, written, written.message, false);
      process.stderr.write(`${written.message}\n`);
      return 0;
    }
    // #6934: stderr in every mode; with --json, stdout stays the controller JSON.
    process.stderr.write(`${written.message}\n`);
    // Bind the body as it stands after the write step, so a later live check of
    // the PR body matches this record (#6316 Greptile P1).
    let bodyHash: string;
    try {
      // #6336 item 8: CRLF and trailing newlines do not change the hash.
      bodyHash = hashPrBody(readFileSync(args.bodyFile, "utf8"));
    } catch (err: unknown) {
      process.stderr.write(
        `pre_pr_run: cannot hash --body-file after the story-line step: ${err instanceof Error ? err.message : String(err)}\n`,
      );
      return 2;
    }
    if (args.prBodyHash.length > 0 && args.prBodyHash !== bodyHash) {
      process.stderr.write(
        `pre_pr_run: --pr-body-hash does not match --body-file after the story-line step; omit it or pass ${bodyHash}\n`,
      );
      return 2;
    }
    args.prBodyHash = bodyHash;
  }
  if (
    args.repo.length === 0 ||
    args.baseSha.length === 0 ||
    args.headSha.length === 0 ||
    args.treeHash.length === 0 ||
    args.prBodyHash.length === 0 ||
    args.approvedRevision.length === 0
  ) {
    process.stderr.write(
      "pre_pr_run: start requires --repo --base-sha --head-sha --tree-hash --pr-body-hash --approved-revision\n",
    );
    return 2;
  }
  const criteria = digestApprovedCriteria({
    sourceRevisionSha: args.approvedRevision,
    scopePaths: args.scope,
    acceptanceText: args.acceptance,
    generation: args.generation,
  });
  const started = startControllerRun(store, {
    repo: args.repo,
    baseSha: args.baseSha,
    headSha: args.headSha,
    treeHash: args.treeHash,
    prBodyHash: args.prBodyHash,
    prNodeId: args.prNodeId,
    criteria,
    skillVersion: args.skillVersion,
    policyVersion: args.policyVersion,
    approvedRevisionSha: args.approvedRevision,
    runId: args.runId ?? undefined,
  });
  if (!started.ok) {
    emit(args.json, started.decision, started.decision.message, true);
    return 1;
  }
  const payload = { ok: started.ok, runId: started.runId, hint: "run id is a lookup hint only" };
  emit(
    args.json,
    payload,
    `started ${started.runId} (lookup hint only; private store is authoritative)`,
    false,
  );
  return 0;
}

if (isDirectEntrypoint(import.meta.url)) {
  process.exit(run(process.argv.slice(2)));
}
