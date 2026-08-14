/**
 * Shared fake-trial harness for field-shaped run-summary fixtures (#3362).
 *
 * One harness: temp consumer-shaped root, DEFT_RUN_SUMMARY_PATH set, production
 * emitter write path, multi-invocation identity. Enroll kinds via trial steps
 * rather than rebuilding a per-kind fixture.
 */

import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { containedWrite } from "../fs/contained-write.js";
import { RunSummaryEmitter } from "../run-summary/emit.js";
import {
  ENV_RUN_SUMMARY_PATH,
  ENV_TOTAL_TOOL_TURNS,
  parseRunSummaryJsonl,
  type RunSummaryEventKind,
  type RunSummaryLine,
} from "../run-summary/index.js";
import { ENROLLED_FIELD_FIXTURE_KINDS } from "./kinds.js";

export interface FakeTrialStep {
  readonly kind: RunSummaryEventKind;
  readonly invoke: (emitter: RunSummaryEmitter) => void;
}

export const DEFAULT_TRIAL_STEPS: readonly FakeTrialStep[] = [
  {
    kind: "session_start",
    invoke: (emitter) => {
      emitter.emitSessionStart({ ready: true, exit_code: 0 });
    },
  },
  {
    kind: "dial_escalation_evaluation",
    invoke: (emitter) => {
      emitter.emitDialEscalationEvaluation({
        tier: "standard",
        outcome: "declined",
        reason: "fake-trial",
      });
    },
  },
  {
    kind: "dial_transition",
    invoke: (emitter) => {
      emitter.emitDialTransition({
        from: "rapid",
        to: "standard",
        reason: "fake-trial",
      });
    },
  },
  {
    kind: "check_invocation",
    invoke: (emitter) => {
      emitter.emitCheckInvocation({
        target: "check:framework-source",
        exit_code: 0,
        gates: [],
      });
    },
  },
  {
    kind: "verification",
    invoke: (emitter) => {
      emitter.emitVerification({
        check_id: "fake-trial",
        method_fingerprint: "fake-trial",
        outcome: "pass",
      });
    },
  },
  {
    kind: "acceptance",
    invoke: (emitter) => {
      emitter.emitAcceptance({
        resolved_command_count: 1,
        outcome: "verified-pass",
      });
    },
  },
  {
    kind: "acceptance_stamp",
    invoke: (emitter) => {
      emitter.emitAcceptanceStamp({
        rung: "stated",
        none_stated: false,
        command_count: 1,
        clause_count: 0,
      });
    },
  },
  {
    kind: "tool_turn_denominator",
    invoke: (emitter) => {
      emitter.emitKnownToolTurnDenominator();
    },
  },
];

export interface FakeTrialOptions {
  /** Existing root. When omitted, a temp consumer-shaped deposit is created. */
  readonly projectRoot?: string;
  readonly sessionId?: string;
  readonly destPath?: string;
  readonly steps?: readonly FakeTrialStep[];
  readonly env?: NodeJS.ProcessEnv;
}

export interface FakeTrialResult {
  readonly projectRoot: string;
  readonly destPath: string;
  readonly sessionId: string;
  readonly lines: readonly RunSummaryLine[];
  readonly presentKinds: readonly RunSummaryEventKind[];
  readonly seqMonotonic: boolean;
  readonly sessionIdStable: boolean;
}

function createConsumerShapedRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "deft-telemetry-trial-"));
  mkdirSync(join(root, "xbrief"), { recursive: true });
  containedWrite({
    root,
    target: ".gitignore",
    data: ".deft-run-summary.json\n",
    mode: "create",
  });
  containedWrite({
    root,
    target: "package.json",
    data: '{"name":"fake-trial-consumer"}\n',
    mode: "create",
  });
  return root;
}

function seqIsMonotonic(lines: readonly RunSummaryLine[]): boolean {
  if (lines.length === 0) {
    return true;
  }
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i]?.seq !== i + 1) {
      return false;
    }
  }
  return true;
}

function sessionIdIsStable(lines: readonly RunSummaryLine[], sessionId: string): boolean {
  return lines.every((line) => line.session_id === sessionId);
}

/**
 * Run one fake trial: write JSONL via the production emitter, then read it back.
 * A second emitter instance appends so seq/session_id identity is asserted
 * across invocations (#3350 class).
 */
export function runFakeTrial(options: FakeTrialOptions = {}): FakeTrialResult {
  const projectRoot = options.projectRoot ?? createConsumerShapedRoot();
  const destPath = options.destPath ?? join(projectRoot, "trial-run-summary.jsonl");
  const sessionId = options.sessionId ?? "fake-trial-session";
  const steps = options.steps ?? DEFAULT_TRIAL_STEPS;
  const env: NodeJS.ProcessEnv = {
    ...(options.env ?? process.env),
    [ENV_RUN_SUMMARY_PATH]: destPath,
    [ENV_TOTAL_TOOL_TURNS]: "8",
  };

  const first = new RunSummaryEmitter({ projectRoot, sessionId, env });
  for (const step of steps) {
    step.invoke(first);
  }
  const second = new RunSummaryEmitter({ projectRoot, sessionId, env });
  second.emitCheckInvocation({
    target: "check:framework-source",
    exit_code: 0,
    gates: [],
  });

  const text = readFileSync(destPath, "utf8");
  const lines = parseRunSummaryJsonl(text);
  const present = new Set<RunSummaryEventKind>();
  for (const line of lines) {
    present.add(line.event);
  }
  return {
    projectRoot,
    destPath,
    sessionId,
    lines,
    presentKinds: [...present],
    seqMonotonic: seqIsMonotonic(lines),
    sessionIdStable: sessionIdIsStable(lines, sessionId),
  };
}

/** Assert every enrolled kind appears in a trial result. */
export function missingEnrolledKinds(
  result: FakeTrialResult,
  enrolled: readonly RunSummaryEventKind[] = ENROLLED_FIELD_FIXTURE_KINDS,
): readonly RunSummaryEventKind[] {
  const present = new Set(result.presentKinds);
  return enrolled.filter((kind) => !present.has(kind));
}
