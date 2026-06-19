/**
 * Risk-tiered judgment-gate engine (#1419 Slice 3). Port of scripts/verify_judgment_gates.py.
 */

import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { type JudgmentGatesPolicy, resolveJudgmentGates } from "./judgment-policy.js";
import { matchAny } from "./pathspec.js";

export const AUDIT_DIR_REL = "vbrief/.audit";
export const CLEARANCE_LOG_NAME = "judgment-gate-clearances.jsonl";
export const UNIVERSAL_SOURCE = "universal";
export const CONSUMER_SOURCE = "consumer";

export const UNIVERSAL_GATES: readonly Record<string, unknown>[] = [
  {
    id: "secrets-and-credentials",
    class: "mechanical",
    tier: "block",
    requiredHumanReviewers: 1,
    reason: "Touches secrets / credential material; requires human sign-off.",
    source: UNIVERSAL_SOURCE,
    match: {
      paths: {
        "any-of": [
          "secrets/**",
          "**/secrets/**",
          ".env",
          "**/.env",
          "**/*.env",
          "**/*.pem",
          "**/*.key",
          "**/*.p12",
          "**/*.pfx",
          "**/id_rsa",
          "**/id_rsa.*",
          "**/*.keystore",
          "**/credentials",
          "**/credentials.*",
          "**/.npmrc",
          "**/.pypirc",
        ],
      },
    },
  },
  {
    id: "production-infrastructure",
    class: "mechanical",
    tier: "block",
    requiredHumanReviewers: 1,
    reason: "Touches production infrastructure / deploy config; requires sign-off.",
    source: UNIVERSAL_SOURCE,
    match: {
      paths: {
        "any-of": [
          "**/*.tf",
          "**/*.tfvars",
          "**/*.tfstate",
          "terraform/**",
          "infra/**",
          "**/Dockerfile",
          "**/Dockerfile.*",
          "**/docker-compose*.yml",
          "**/docker-compose*.yaml",
          "**/k8s/**",
          "**/kubernetes/**",
          "**/helm/**",
          "**/.github/workflows/**",
        ],
      },
    },
  },
  {
    id: "agents-md-and-skills",
    class: "mechanical",
    tier: "block",
    requiredHumanReviewers: 1,
    reason: "Touches agent directives (AGENTS.md / skills); requires sign-off.",
    source: UNIVERSAL_SOURCE,
    match: {
      paths: {
        "any-of": [
          "AGENTS.md",
          "**/AGENTS.md",
          "skills/**",
          "**/skills/**",
          "templates/agents-entry.md",
        ],
      },
    },
  },
  {
    id: "installer-and-bootstrap",
    class: "mechanical",
    tier: "block",
    requiredHumanReviewers: 1,
    reason: "Touches installer / bootstrap surface; requires sign-off.",
    source: UNIVERSAL_SOURCE,
    match: {
      paths: {
        "any-of": [
          "install.ps1",
          "install.sh",
          "**/install.ps1",
          "**/install.sh",
          "installer/**",
          "**/installer/**",
          "scripts/setup*.py",
          "**/deft-install*",
          "bootstrap",
          "**/bootstrap",
          "**/bootstrap.*",
        ],
      },
    },
  },
];

const TRIAGE_PREDICATES = new Set(["labels", "body-text", "state", "age-days"]);

export interface Candidate {
  readonly paths: readonly string[];
  readonly labels: readonly string[];
  readonly body: string;
  readonly state: string;
  readonly updated_at: string | null;
}

export interface GateOutcome {
  readonly gate_id: string;
  readonly gate_class: string;
  readonly tier: string;
  readonly reason: string;
  readonly required_human_reviewers: number;
  readonly source: string;
  readonly matched_paths: readonly string[];
  readonly matched_labels: readonly string[];
  readonly cleared_scope: string;
  readonly clearance: Record<string, unknown> | null;
  readonly stale_clearance: Record<string, unknown> | null;
}

export function outcomeCleared(o: GateOutcome): boolean {
  return o.clearance !== null;
}

export function outcomeFired(o: GateOutcome): boolean {
  return o.clearance === null;
}

export function outcomeBlocking(o: GateOutcome): boolean {
  return outcomeFired(o) && o.gate_class === "mechanical" && o.tier === "block";
}

export interface JudgmentGateReport {
  readonly posture: string;
  readonly outcomes: readonly GateOutcome[];
  readonly policy_error: string | null;
}

export function reportFired(report: JudgmentGateReport): GateOutcome[] {
  return report.outcomes.filter(outcomeFired);
}

export function reportBlocking(report: JudgmentGateReport): GateOutcome[] {
  return report.outcomes.filter(outcomeBlocking);
}

export function clearanceLogPath(projectRoot: string): string {
  return join(projectRoot, AUDIT_DIR_REL, CLEARANCE_LOG_NAME);
}

function utcNowIso(now?: Date): string {
  return (now ?? new Date()).toISOString().replace(/\.\d{3}Z$/, "Z");
}

export function readClearances(projectRoot: string, logPath?: string): Record<string, unknown>[] {
  const path = logPath ?? clearanceLogPath(projectRoot);
  if (!existsSync(path)) {
    return [];
  }
  const out: Record<string, unknown>[] = [];
  for (const raw of readFileSync(path, "utf8").split("\n")) {
    const stripped = raw.trim();
    if (!stripped) {
      continue;
    }
    try {
      const obj = JSON.parse(stripped) as unknown;
      if (typeof obj === "object" && obj !== null && !Array.isArray(obj)) {
        out.push(obj as Record<string, unknown>);
      }
    } catch {
      // skip malformed
    }
  }
  return out;
}

export function recordClearance(
  projectRoot: string,
  options: {
    gate_id: string;
    cleared_scope: string;
    reviewers?: string[];
    actor?: string;
    reason?: string;
    now?: Date;
    log_path?: string;
  },
): Record<string, unknown> {
  const path = options.log_path ?? clearanceLogPath(projectRoot);
  mkdirSync(join(projectRoot, AUDIT_DIR_REL), { recursive: true });
  const entry: Record<string, unknown> = {
    clearance_id: randomUUID(),
    timestamp: utcNowIso(options.now),
    gate_id: options.gate_id,
    cleared_scope: options.cleared_scope,
    reviewers: [...(options.reviewers ?? [])],
    actor: options.actor ?? "operator",
    reason: options.reason ?? "",
  };
  const sorted = Object.fromEntries(
    Object.keys(entry)
      .sort()
      .map((k) => [k, entry[k]]),
  );
  appendFileSync(path, `${JSON.stringify(sorted)}\n`, "utf8");
  return entry;
}

export function fingerprintScope(evidence: Record<string, unknown>): string {
  const sorted = Object.fromEntries(
    Object.keys(evidence)
      .sort()
      .map((k) => [k, evidence[k]]),
  );
  const payload = JSON.stringify(sorted);
  return createHash("sha256").update(payload, "utf8").digest("hex");
}

function lookupClearance(
  clearances: Record<string, unknown>[],
  gateId: string,
  scope: string,
): [Record<string, unknown> | null, Record<string, unknown> | null] {
  let valid: Record<string, unknown> | null = null;
  let stale: Record<string, unknown> | null = null;
  for (const entry of clearances) {
    if (entry.gate_id !== gateId) {
      continue;
    }
    if (entry.cleared_scope === scope) {
      valid = entry;
    } else {
      stale = entry;
    }
  }
  return [valid, stale];
}

function consumerGateToDict(gate: {
  gate_id: string;
  gate_class: string;
  tier: string;
  reason: string;
  required_human_reviewers: number;
  match: Record<string, unknown>;
}): Record<string, unknown> {
  return {
    id: gate.gate_id,
    class: gate.gate_class,
    tier: gate.tier,
    reason: gate.reason,
    requiredHumanReviewers: gate.required_human_reviewers,
    match: gate.match,
    source: CONSUMER_SOURCE,
  };
}

export function effectiveGates(
  projectRoot: string,
  policy?: JudgmentGatesPolicy,
): Record<string, unknown>[] {
  const resolved = policy ?? resolveJudgmentGates(projectRoot);
  const disabled = new Set(resolved.disabled);
  const gates = UNIVERSAL_GATES.filter((g) => !disabled.has(String(g.id))).map((g) => ({ ...g }));
  for (const g of resolved.gates) {
    if (!disabled.has(g.gate_id)) {
      gates.push(consumerGateToDict(g));
    }
  }
  return gates;
}

function matchedLabels(match: Record<string, unknown>, candidate: Candidate): string[] {
  const labelsPred = match.labels;
  if (typeof labelsPred !== "object" || labelsPred === null || Array.isArray(labelsPred)) {
    return [];
  }
  const lp = labelsPred as Record<string, unknown>;
  const names = new Set(candidate.labels);
  const selected = lp["any-of"] ?? lp["all-of"];
  if (!Array.isArray(selected)) {
    return [];
  }
  return [
    ...selected.filter((label): label is string => typeof label === "string" && names.has(label)),
  ].sort();
}

function msPerDay(): number {
  return 86_400_000;
}

function consumerRuleMatches(
  gate: Record<string, unknown>,
  candidate: Candidate,
  now: Date,
): boolean {
  const match = gate.match;
  if (typeof match !== "object" || match === null || Array.isArray(match)) {
    return false;
  }
  const mobj = match as Record<string, unknown>;

  if ("state" in mobj) {
    if (candidate.state !== mobj.state) {
      return false;
    }
  }

  if ("labels" in mobj) {
    const labelsPred = mobj.labels;
    const names = new Set(candidate.labels);
    if (typeof labelsPred !== "object" || labelsPred === null || Array.isArray(labelsPred)) {
      return false;
    }
    const lp = labelsPred as Record<string, unknown>;
    const anyOf = lp["any-of"];
    const allOf = lp["all-of"];
    if (anyOf !== undefined) {
      if (!Array.isArray(anyOf) || !anyOf.some((l) => typeof l === "string" && names.has(l))) {
        return false;
      }
    } else if (allOf !== undefined) {
      if (!Array.isArray(allOf) || !allOf.every((l) => typeof l === "string" && names.has(l))) {
        return false;
      }
    } else {
      return false;
    }
  }

  if ("body-text" in mobj) {
    const bodyPred = mobj["body-text"];
    const anyOf =
      typeof bodyPred === "object" && bodyPred !== null && !Array.isArray(bodyPred)
        ? (bodyPred as Record<string, unknown>)["any-of"]
        : undefined;
    if (!Array.isArray(anyOf) || anyOf.length === 0) {
      return false;
    }
    const body = candidate.body.toLowerCase();
    if (
      !anyOf.some((n) => typeof n === "string" && n.length > 0 && body.includes(n.toLowerCase()))
    ) {
      return false;
    }
  }

  if ("age-days" in mobj) {
    const pred = mobj["age-days"];
    const gt =
      typeof pred === "object" && pred !== null && !Array.isArray(pred)
        ? (pred as Record<string, unknown>).gt
        : undefined;
    if (typeof gt !== "number" || !Number.isInteger(gt)) {
      return false;
    }
    const updatedAt = candidate.updated_at;
    if (updatedAt === null || updatedAt.length === 0) {
      return false;
    }
    const updated = new Date(updatedAt.endsWith("Z") ? updatedAt : updatedAt);
    if (Number.isNaN(updated.getTime())) {
      return false;
    }
    if (now.getTime() - updated.getTime() <= gt * msPerDay()) {
      return false;
    }
  }

  return true;
}

export function matchEvidence(
  match: Record<string, unknown>,
  candidate: Candidate,
  matchedPaths: readonly string[],
): Record<string, unknown> {
  const evidence: Record<string, unknown> = {};
  if ("paths" in match) {
    evidence.paths = [...matchedPaths].sort();
  }
  if ("labels" in match) {
    evidence.labels = matchedLabels(match, candidate);
  }
  if ("body-text" in match) {
    evidence["body-text"] = candidate.body;
  }
  if ("state" in match) {
    evidence.state = candidate.state;
  }
  if ("age-days" in match) {
    evidence["age-days"] = candidate.updated_at ?? "";
  }
  return evidence;
}

function gateMatch(
  gate: Record<string, unknown>,
  candidate: Candidate,
  now: Date,
): [boolean, Record<string, unknown>, string[], string[]] {
  const match = gate.match;
  if (typeof match !== "object" || match === null || Array.isArray(match)) {
    return [false, {}, [], []];
  }
  const mobj = match as Record<string, unknown>;
  let matchedPaths: string[] = [];
  if ("paths" in mobj) {
    const pathsPred = mobj.paths;
    const globs =
      typeof pathsPred === "object" && pathsPred !== null && !Array.isArray(pathsPred)
        ? (pathsPred as Record<string, unknown>)["any-of"]
        : null;
    const hits = candidate.paths.filter((p) => matchAny(globs, p));
    if (hits.length === 0) {
      return [false, {}, [], []];
    }
    matchedPaths = hits;
  }
  const matchKeys = new Set(Object.keys(mobj));
  const hasTriage = [...TRIAGE_PREDICATES].some((k) => matchKeys.has(k));
  if (hasTriage && !consumerRuleMatches(gate, candidate, now)) {
    return [false, {}, [], []];
  }
  const evidence = matchEvidence(mobj, candidate, matchedPaths);
  return [true, evidence, matchedPaths, matchedLabels(mobj, candidate)];
}

export function buildReport(
  projectRoot: string,
  candidate: Candidate,
  options: {
    posture?: string;
    clearances?: Record<string, unknown>[] | null;
    now?: Date;
  } = {},
): JudgmentGateReport {
  const nowDt = options.now ?? new Date();
  const policy = resolveJudgmentGates(projectRoot);
  const records = options.clearances ?? readClearances(projectRoot);
  const outcomes: GateOutcome[] = [];
  for (const gate of effectiveGates(projectRoot, policy)) {
    const [matched, evidence, matchedPaths, matchedLabelsList] = gateMatch(gate, candidate, nowDt);
    if (!matched) {
      continue;
    }
    const scope = fingerprintScope(evidence);
    const [valid, stale] = lookupClearance(records, String(gate.id), scope);
    outcomes.push({
      gate_id: String(gate.id),
      gate_class: String(gate.class),
      tier: String(gate.tier),
      reason: String(gate.reason ?? ""),
      required_human_reviewers: Number(gate.requiredHumanReviewers ?? 0),
      source: String(gate.source ?? CONSUMER_SOURCE),
      matched_paths: matchedPaths,
      matched_labels: matchedLabelsList,
      cleared_scope: scope,
      clearance: valid,
      stale_clearance: stale,
    });
  }
  return {
    posture: options.posture ?? "advise",
    outcomes,
    policy_error: policy.error,
  };
}

function pythonListRepr(items: readonly string[]): string {
  return `[${items.map((i) => `'${i}'`).join(", ")}]`;
}

export function renderReport(report: JudgmentGateReport): string {
  const lines = [`judgment-gates (${report.outcomes.length} matched; posture=${report.posture}):`];
  if (report.policy_error) {
    lines.push(`  ! policy self-healed to defaults: ${report.policy_error}`);
  }
  if (report.outcomes.length === 0) {
    lines.push("  (no gates matched the candidate)");
    return lines.join("\n");
  }
  for (const outcome of report.outcomes) {
    let status: string;
    if (outcomeCleared(outcome)) {
      status = "cleared";
    } else if (outcome.stale_clearance !== null) {
      status = "STALE-CLEARANCE re-triggered";
    } else {
      status = "fired";
    }
    const evidence: string[] = [];
    if (outcome.matched_paths.length > 0) {
      evidence.push(`paths=${pythonListRepr(outcome.matched_paths)}`);
    }
    if (outcome.matched_labels.length > 0) {
      evidence.push(`labels=${pythonListRepr(outcome.matched_labels)}`);
    }
    const suffix = evidence.length > 0 ? ` :: ${evidence.join(", ")}` : "";
    lines.push(
      `  - [${outcome.tier}/${outcome.gate_class}/${outcome.source}] ${outcome.gate_id}: ${status} (${outcome.reason})${suffix}`,
    );
  }
  return lines.join("\n");
}

export function evaluate(
  projectRoot: string,
  candidate: Candidate | null = null,
  options: {
    posture?: string;
    clearances?: Record<string, unknown>[] | null;
    now?: Date;
  } = {},
): [number, string] {
  if (!existsSync(projectRoot)) {
    return [
      2,
      `verify_judgment_gates: --project-root is not a directory: ${projectRoot}\n  Recovery: pass an existing project root.`,
    ];
  }
  try {
    if (!statSync(projectRoot).isDirectory()) {
      return [
        2,
        `verify_judgment_gates: --project-root is not a directory: ${projectRoot}\n  Recovery: pass an existing project root.`,
      ];
    }
  } catch {
    return [
      2,
      `verify_judgment_gates: --project-root is not a directory: ${projectRoot}\n  Recovery: pass an existing project root.`,
    ];
  }
  const cand: Candidate = candidate ?? {
    paths: [],
    labels: [],
    body: "",
    state: "open",
    updated_at: null,
  };
  const posture = options.posture ?? "advise";
  const report = buildReport(projectRoot, cand, { ...options, posture });
  const rendered = renderReport(report);

  const blocking = reportBlocking(report);
  if (posture === "enforce" && blocking.length > 0) {
    const ids = blocking.map((o) => o.gate_id).join(", ");
    return [
      1,
      `${rendered}\nverify_judgment_gates: BLOCKED -- ${blocking.length} mechanical block-tier gate(s) fired without clearance: ${ids}. Record a clearance (\`verify_judgment_gates.py clear --gate-id <id> ...\`) or drop the change.`,
    ];
  }

  const note =
    posture !== "enforce"
      ? "advisory posture; deferring to ordering"
      : "enforce posture; no blocking gates fired";
  return [0, `${rendered}\nverify_judgment_gates: OK -- ${note}.`];
}

function diffPaths(projectRoot: string, baseRef: string): string[] {
  try {
    const stdout = execFileSync("git", ["-C", projectRoot, "diff", "--name-only", baseRef], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return String(stdout)
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0);
  } catch {
    return [];
  }
}

function buildCandidateFromEvalArgs(args: Record<string, unknown>): Candidate {
  const paths: string[] = [...((args.paths as string[]) ?? [])];
  const baseRef = args.baseRef as string | undefined;
  const projectRoot = args.projectRoot as string;
  if (baseRef) {
    paths.push(...diffPaths(projectRoot, baseRef));
  }
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const p of paths) {
    if (p && !seen.has(p)) {
      seen.add(p);
      unique.push(p);
    }
  }
  return {
    paths: unique,
    labels: (args.labels as string[]) ?? [],
    body: (args.body as string) ?? "",
    state: (args.state as string) ?? "open",
    updated_at: null,
  };
}

function outcomeToJson(outcome: GateOutcome): Record<string, unknown> {
  return {
    gate_id: outcome.gate_id,
    class: outcome.gate_class,
    tier: outcome.tier,
    source: outcome.source,
    reason: outcome.reason,
    matched_paths: [...outcome.matched_paths],
    matched_labels: [...outcome.matched_labels],
    cleared_scope: outcome.cleared_scope,
    cleared: outcomeCleared(outcome),
    fired: outcomeFired(outcome),
    blocking: outcomeBlocking(outcome),
    stale_clearance: outcome.stale_clearance !== null,
    required_human_reviewers: outcome.required_human_reviewers,
  };
}

export function cmdVerifyJudgmentGates(argv: string[]): number {
  if (argv.length > 0 && argv[0] === "clear") {
    return clearMain(argv.slice(1));
  }
  return evalMain(argv);
}

function evalMain(argv: string[]): number {
  const args = parseEvalArgs(argv);
  if (args.error) {
    process.stderr.write(`${args.error}\n`);
    return 2;
  }
  const projectRoot = resolve(args.projectRoot);
  const posture = args.enforce ? "enforce" : "advise";
  const candidate = buildCandidateFromEvalArgs({
    paths: args.paths,
    labels: args.labels,
    body: args.body,
    state: args.state,
    baseRef: args.baseRef,
    projectRoot,
  });

  if (args.json) {
    if (!existsSync(projectRoot)) {
      process.stderr.write(
        `${JSON.stringify({ exit: 2, error: "project-root is not a directory" })}\n`,
      );
      return 2;
    }
    const report = buildReport(projectRoot, candidate, { posture });
    const code = posture === "enforce" && reportBlocking(report).length > 0 ? 1 : 0;
    process.stdout.write(
      `${JSON.stringify(
        {
          exit: code,
          posture: report.posture,
          outcomes: report.outcomes.map(outcomeToJson),
          policy_error: report.policy_error,
        },
        null,
        2,
      )}\n`,
    );
    return code;
  }

  const [code, message] = evaluate(projectRoot, candidate, { posture });
  if (code === 0) {
    if (!args.quiet) {
      process.stdout.write(`${message}\n`);
    }
  } else {
    process.stderr.write(`${message}\n`);
  }
  return code;
}

function clearMain(argv: string[]): number {
  const args = parseClearArgs(argv);
  const projectRoot = resolve(args.projectRoot);
  if (!existsSync(projectRoot)) {
    process.stderr.write(
      `verify_judgment_gates: --project-root is not a directory: ${projectRoot}\n`,
    );
    return 2;
  }
  const evidence: Record<string, unknown> = {};
  if (args.paths.length > 0) evidence.paths = [...args.paths].sort();
  if (args.labels.length > 0) evidence.labels = [...args.labels].sort();
  if (args.body) evidence["body-text"] = args.body;
  if (args.state !== null) evidence.state = args.state;
  if (args.updatedAt !== null) evidence["age-days"] = args.updatedAt;
  const scope = fingerprintScope(evidence);
  const entry = recordClearance(projectRoot, {
    gate_id: args.gateId,
    cleared_scope: scope,
    reviewers: args.reviewers,
    actor: args.actor,
    reason: args.reason,
  });
  process.stdout.write(
    `recorded clearance ${String(entry.clearance_id)} for gate ${JSON.stringify(args.gateId)} (cleared_scope=${scope.slice(0, 12)}...)\n`,
  );
  return 0;
}

interface EvalArgs {
  projectRoot: string;
  enforce: boolean;
  baseRef: string | null;
  paths: string[];
  labels: string[];
  body: string;
  state: string;
  quiet: boolean;
  json: boolean;
  error?: string;
}

function parseEvalArgs(argv: string[]): EvalArgs {
  const parsed: EvalArgs = {
    projectRoot: ".",
    enforce: false,
    baseRef: null,
    paths: [],
    labels: [],
    body: "",
    state: "open",
    quiet: false,
    json: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--enforce") parsed.enforce = true;
    else if (arg === "--quiet") parsed.quiet = true;
    else if (arg === "--json") parsed.json = true;
    else if (arg === "--project-root") {
      parsed.projectRoot = argv[i + 1] ?? ".";
      i += 1;
    } else if (arg?.startsWith("--project-root=")) parsed.projectRoot = arg.slice(15);
    else if (arg === "--base-ref") {
      parsed.baseRef = argv[i + 1] ?? null;
      i += 1;
    } else if (arg === "--path") {
      parsed.paths.push(argv[i + 1] ?? "");
      i += 1;
    } else if (arg === "--label") {
      parsed.labels.push(argv[i + 1] ?? "");
      i += 1;
    } else if (arg === "--body") {
      parsed.body = argv[i + 1] ?? "";
      i += 1;
    } else if (arg === "--state") {
      parsed.state = argv[i + 1] ?? "open";
      i += 1;
    } else {
      return { ...parsed, error: `unrecognized argument: ${arg}` };
    }
  }
  return parsed;
}

interface ClearArgs {
  projectRoot: string;
  gateId: string;
  paths: string[];
  labels: string[];
  body: string;
  state: string | null;
  updatedAt: string | null;
  reviewers: string[];
  actor: string;
  reason: string;
}

function parseClearArgs(argv: string[]): ClearArgs {
  const parsed: ClearArgs = {
    projectRoot: ".",
    gateId: "",
    paths: [],
    labels: [],
    body: "",
    state: null,
    updatedAt: null,
    reviewers: [],
    actor: "operator",
    reason: "",
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--project-root") {
      parsed.projectRoot = argv[i + 1] ?? ".";
      i += 1;
    } else if (arg === "--gate-id") {
      parsed.gateId = argv[i + 1] ?? "";
      i += 1;
    } else if (arg === "--path") {
      parsed.paths.push(argv[i + 1] ?? "");
      i += 1;
    } else if (arg === "--label") {
      parsed.labels.push(argv[i + 1] ?? "");
      i += 1;
    } else if (arg === "--body") {
      parsed.body = argv[i + 1] ?? "";
      i += 1;
    } else if (arg === "--state") {
      parsed.state = argv[i + 1] ?? null;
      i += 1;
    } else if (arg === "--updated-at") {
      parsed.updatedAt = argv[i + 1] ?? null;
      i += 1;
    } else if (arg === "--reviewer") {
      parsed.reviewers.push(argv[i + 1] ?? "");
      i += 1;
    } else if (arg === "--actor") {
      parsed.actor = argv[i + 1] ?? "operator";
      i += 1;
    } else if (arg === "--reason") {
      parsed.reason = argv[i + 1] ?? "";
      i += 1;
    }
  }
  return parsed;
}
