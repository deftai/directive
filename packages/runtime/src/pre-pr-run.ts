#!/usr/bin/env node
/**
 * Agent-facing pre-PR controller entry (#4912 Limb 3).
 * `deft pre-pr:run` starts the prescribed workflow. Opening the skill file
 * is not completion. Generic mark-complete cannot mint a pass.
 */
import {
  completeRun,
  computeControllerObservedHash,
  controllerPublisher,
  digestApprovedCriteria,
  evaluateLivePrePrCheck,
  getDefaultPrePrStore,
  markComplete,
  noteSkillFileOpen,
  observeCommandPhase,
  PRE_PR_PHASE_IDS,
  type PrePrPhaseId,
  phaseSpec,
  resolveRecordFromStore,
  startControllerRun,
  submitReviewerReport,
} from "@deftai/directive-core/pre-pr-controller";
import { isDirectEntrypoint } from "./entrypoint.js";

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
  --complete              publisher-backed complete (fails without observables)
  --observe-command       record a command-observable phase before --complete
  --observe-semantic      record semantic / final-no-change evidence
  --phase <id>
  --command <text>
  --exit-code <n>         required with --observe-command; omit is a parse error
  --input-hash <hex>
  --skip-reason <text>    skip also requires a non-zero --exit-code
  --supplied-contents-hash <hex>
  --controller-observed-hash <hex>
                          optional; must match independently hashed reviewed files
  --criteria-digest <hex>
  --reviewed-file <path>  (repeatable)
  --reviewer-report-ref <ref>
  --mark-complete         always refuses; cannot mint a pass
  --skill-open            always refuses; opening the skill is not completion
  --evaluate              evaluate live binding against the private store
  --json
  --help
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

function asPhaseId(value: string): PrePrPhaseId | null {
  return (PRE_PR_PHASE_IDS as readonly string[]).includes(value) ? (value as PrePrPhaseId) : null;
}

export function run(argv: string[]): number {
  const args = parseArgs(argv);
  if (args.help) {
    process.stdout.write(USAGE);
    return 0;
  }
  if (args.error !== undefined) {
    process.stderr.write(`pre_pr_run: ${args.error}\n`);
    return 2;
  }
  if (args.skillOpen) {
    const d = noteSkillFileOpen();
    emit(args.json, d, d.message, true);
    return 1;
  }
  const store = getDefaultPrePrStore();
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
      if (args.skipReason !== null && args.skipReason.length > 0 && args.exitCode === 0) {
        process.stderr.write(
          "pre_pr_run: skip requires a non-zero --exit-code plus --skip-reason\n",
        );
        return 2;
      }
      const spec = phaseSpec(phase);
      const d = observeCommandPhase(store, args.runId, {
        phaseId: phase,
        command: args.command.length > 0 ? args.command : (spec.command ?? ""),
        exitCode: args.exitCode,
        inputHash: args.inputHash ?? rec?.inputHash ?? "",
        skipReason: args.skipReason,
      });
      emit(args.json, d, d.message, !d.ok);
      return d.ok ? 0 : 1;
    }
    if (args.suppliedContentsHash.length === 0) {
      process.stderr.write("pre_pr_run: --observe-semantic requires --supplied-contents-hash\n");
      return 2;
    }
    if (args.reviewedFiles.length === 0) {
      process.stderr.write("pre_pr_run: --observe-semantic requires --reviewed-file\n");
      return 2;
    }
    const observed = computeControllerObservedHash({ reviewedFiles: args.reviewedFiles });
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
    if (args.suppliedContentsHash !== observed) {
      process.stderr.write(
        "pre_pr_run: --supplied-contents-hash does not match independently hashed reviewed-file contents\n",
      );
      return 1;
    }
    const d = submitReviewerReport(store, args.runId, {
      phaseId: phase,
      reviewedFileManifest: args.reviewedFiles,
      suppliedContentsHash: args.suppliedContentsHash,
      criteriaDigest: args.criteriaDigest ?? rec?.criteria.digest ?? "",
      reviewerReportRef: args.reviewerReportRef,
      controllerObservedHash: observed,
    });
    emit(args.json, d, d.message, !d.ok);
    return d.ok ? 0 : 1;
  }
  if (args.evaluate) {
    if (args.repo.length === 0 || args.baseSha.length === 0 || args.headSha.length === 0) {
      process.stderr.write("pre_pr_run: --evaluate requires --repo --base-sha --head-sha\n");
      return 2;
    }
    if (args.prBodyHash.length === 0) {
      process.stderr.write("pre_pr_run: --evaluate requires --pr-body-hash\n");
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
    const d = completeRun(store, controllerPublisher(), args.runId);
    emit(args.json, d, d.message, !d.ok);
    return d.ok ? 0 : 1;
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
