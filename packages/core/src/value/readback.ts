import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { runningInsideDeftRepo } from "../doctor/paths.js";
import { ALL_ATTRIBUTION_EVENT_NAMES } from "../events/attribution-constants.js";
import { ContainedWriteError, containedWrite } from "../fs/contained-write.js";
import { ProjectionContainmentError } from "../fs/projection-containment.js";
import { type BehavioralEventRecord, DEFAULT_EVENT_LOG, readEvents } from "../lifecycle/events.js";
import { policyColonInvocation } from "../policy/policy-invocation.js";
import {
  isValueFeedbackPathAllowed,
  resolveValueFeedback,
  type ValueFeedbackResolved,
} from "../policy/value-feedback.js";
import { resolveProjectRoot } from "../scope/project-context.js";
import {
  type CeremonyCostRollup,
  computeCeremonyCostRollup,
  formatCeremonyCostReport,
  PROCESS_COST_EVENT_NAMES,
} from "../session/process-cost.js";
import { MAX_LINE_CHARS } from "../triage/welcome/constants.js";
import { probeAdoptionAtWorkBoundary } from "./adoption-emit.js";
import { probeFrictionAtWorkBoundary } from "./friction-emit.js";

/** Repeat-suppression window for the budgeted session readback (#1709 / #1279 parity). */
export const VALUE_READBACK_SUPPRESSION_HOURS = 4;

export const VALUE_READBACK_HISTORY_REL = join(".deft-cache", "value-readback-history.jsonl");
export const VALUE_READBACK_HISTORY_SCHEMA = "deft.value.readback.v1";

const ATTRIBUTION_NAME_SET = new Set<string>(ALL_ATTRIBUTION_EVENT_NAMES);

/** Signal-class priority: value/bypass beat adoption (#1709 RFC nudge ordering). */
const SIGNAL_CLASS_PRIORITY: Record<string, number> = {
  value: 0,
  bypass: 1,
  adoption: 2,
  friction: 3,
};

export type SignalClass = "value" | "bypass" | "adoption" | "friction";

export interface ReadAttributionOptions {
  readonly projectRoot: string;
  readonly logPath?: string | null;
  readonly since?: Date | null;
}

export interface ValueShowTrend {
  readonly windowLabel: string;
  readonly windowMs: number;
  readonly total: number;
  readonly byClass: Readonly<Record<SignalClass, number>>;
  readonly byEvent: Readonly<Record<string, number>>;
  readonly recent: readonly BehavioralEventRecord[];
}

export interface ValueShowResult {
  readonly exitCode: 0 | 1 | 2;
  readonly gated: boolean;
  readonly empty: boolean;
  readonly text: string;
  readonly trend: ValueShowTrend | null;
  /** Composed #3508 ceremony-cost rollup (CLI process time, not turn clock). */
  readonly ceremonyCost: CeremonyCostRollup | null;
}

export interface SessionReadbackResult {
  readonly line: string | null;
  readonly suppressed: boolean;
  readonly gated: boolean;
}

function resolveLedgerPath(projectRoot: string, logPath?: string | null): string {
  if (logPath !== undefined && logPath !== null) {
    return resolve(logPath);
  }
  return resolve(projectRoot, DEFAULT_EVENT_LOG);
}

function parseDetectedAt(record: BehavioralEventRecord): Date | null {
  const raw = record.detected_at;
  if (typeof raw !== "string" || raw.trim().length === 0) {
    return null;
  }
  let text = raw.trim();
  if (text.endsWith("Z")) {
    text = `${text.slice(0, -1)}+00:00`;
  }
  const parsed = new Date(text);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/** Read attribution ledger entries in emission order (#1709). */
export function readAttributionEvents(options: ReadAttributionOptions): BehavioralEventRecord[] {
  try {
    const logPath = resolveLedgerPath(options.projectRoot, options.logPath);
    const since = options.since ?? null;
    return readEvents(logPath).filter((record) => {
      if (typeof record?.event !== "string" || !ATTRIBUTION_NAME_SET.has(record.event)) {
        return false;
      }
      if (!isRecordPayload(record.payload)) {
        return false;
      }
      if (since === null) {
        return true;
      }
      const at = parseDetectedAt(record);
      return at !== null && at.getTime() >= since.getTime();
    });
  } catch {
    return [];
  }
}

function signalClassOf(record: BehavioralEventRecord): SignalClass | null {
  const payload = record.payload;
  if (isRecordPayload(payload)) {
    const raw = payload.signal_class;
    if (raw === "value" || raw === "bypass" || raw === "adoption" || raw === "friction") {
      return raw;
    }
  }
  const prefix = record.event.split(":")[0];
  if (prefix === "value" || prefix === "bypass" || prefix === "adoption" || prefix === "friction") {
    return prefix;
  }
  return null;
}

function priorityOf(record: BehavioralEventRecord): number {
  const cls = signalClassOf(record);
  if (cls === null) {
    return 99;
  }
  return SIGNAL_CLASS_PRIORITY[cls] ?? 99;
}

function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) {
    return text;
  }
  if (maxChars <= 3) {
    return text.slice(0, maxChars);
  }
  return `${text.slice(0, maxChars - 3)}...`;
}

function payloadString(payload: Record<string, unknown>, key: string): string {
  const raw = payload[key];
  if (typeof raw === "string" && raw.trim().length > 0) {
    return raw.trim();
  }
  if (typeof raw === "number" && Number.isFinite(raw)) {
    return String(raw);
  }
  return "";
}

/** Format one attributed session line from a concrete ledger event (#1709 attributed-only). */
export function formatAttributedSessionLine(record: BehavioralEventRecord): string {
  const cls = signalClassOf(record) ?? "value";
  const payload = isRecordPayload(record.payload) ? record.payload : {};
  const source = payloadString(payload, "source");
  const detail = payloadString(payload, "detail");
  const capability = payloadString(payload, "capability");

  switch (record.event) {
    case "value:gate-catch": {
      const tail = detail.length > 0 ? `: ${detail}` : "";
      return `[value] Gate catch (${source || "gate"})${tail}`;
    }
    case "value:wip-cap-protect": {
      const count = payloadString(payload, "count");
      const cap = payloadString(payload, "cap");
      const pair = count && cap ? ` ${count}/${cap}` : "";
      return `[value] WIP cap protected in-flight scope${pair}.`;
    }
    case "bypass:off-flow": {
      const tail = detail.length > 0 ? `: ${detail}` : "";
      return `[boundary] Off-flow signal (${source || "bypass"})${tail}`;
    }
    case "adoption:unused-capability": {
      const tail = detail.length > 0 ? `: ${detail}` : capability;
      return `[adoption] Unused capability${tail ? ` (${tail})` : ""}.`;
    }
    case "friction:directive-gap": {
      const tail = detail.length > 0 ? `: ${detail}` : "";
      return `[friction] Directive gap (${source || "friction"})${tail}`;
    }
    default:
      return `[${cls}] ${record.event}`;
  }
}

/** Pick the single highest-priority recent attribution for the session one-liner. */
export function selectSessionAttribution(
  events: readonly BehavioralEventRecord[],
): BehavioralEventRecord | null {
  if (events.length === 0) {
    return null;
  }
  const sorted = [...events].sort((a, b) => {
    const pri = priorityOf(a) - priorityOf(b);
    if (pri !== 0) {
      return pri;
    }
    const aAt = parseDetectedAt(a)?.getTime() ?? 0;
    const bAt = parseDetectedAt(b)?.getTime() ?? 0;
    return bAt - aAt;
  });
  return sorted[0] ?? null;
}

function parseJsonObjectOrNull(text: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // malformed history line
  }
  return null;
}

function isRecordPayload(payload: unknown): payload is Record<string, unknown> {
  return payload !== null && typeof payload === "object" && !Array.isArray(payload);
}

function historyPath(projectRoot: string): string {
  return resolve(projectRoot, VALUE_READBACK_HISTORY_REL);
}

function readLastHistoryRecord(path: string): Record<string, unknown> | null {
  if (!existsSync(path)) {
    return null;
  }
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return null;
  }
  const lines = text.split("\n").filter((line) => line.trim().length > 0);
  if (lines.length === 0) {
    return null;
  }
  const last = lines[lines.length - 1];
  if (last === undefined) {
    return null;
  }
  return parseJsonObjectOrNull(last);
}

function parseHistoryEmittedAt(record: Record<string, unknown>): Date | null {
  const raw = record.emitted_at;
  if (typeof raw !== "string" || raw.trim().length === 0) {
    return null;
  }
  let candidate = raw.trim();
  if (candidate.endsWith("Z")) {
    candidate = `${candidate.slice(0, -1)}+00:00`;
  }
  const parsed = new Date(candidate);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/** True when the same attribution event id was read back within the suppression window. */
export function shouldSuppressSessionReadback(
  eventId: string,
  historyFile: string,
  options: { now?: Date } = {},
): boolean {
  const prior = readLastHistoryRecord(historyFile);
  if (prior === null) {
    return false;
  }
  const emittedAt = parseHistoryEmittedAt(prior);
  if (emittedAt === null) {
    return false;
  }
  const now = options.now ?? new Date();
  const ageMs = now.getTime() - emittedAt.getTime();
  if (ageMs < 0 || ageMs >= VALUE_READBACK_SUPPRESSION_HOURS * 3_600_000) {
    return false;
  }
  return prior.event_id === eventId;
}

function appendReadbackHistory(
  projectRoot: string,
  eventId: string,
  line: string,
  options: { now?: Date } = {},
): void {
  const path = historyPath(projectRoot);
  const record = {
    schema: VALUE_READBACK_HISTORY_SCHEMA,
    emitted_at: (options.now ?? new Date()).toISOString().replace(/\.\d{3}Z$/, "Z"),
    event_id: eventId,
    line,
  };
  try {
    // #2980 wave D: product write sink routes through containedWrite.
    containedWrite({
      root: resolve(projectRoot),
      target: path,
      data: `${JSON.stringify(record)}\n`,
      mode: "append",
    });
  } catch (err) {
    if (err instanceof ProjectionContainmentError || err instanceof ContainedWriteError) {
      throw err;
    }
    // observability only
  }
}

function maintainerReadbackDisabled(projectRoot: string): boolean {
  if (!runningInsideDeftRepo(projectRoot)) {
    return false;
  }
  return process.env.DEFT_VALUE_SELF_DOGFOOD !== "1";
}

/** Budgeted session one-liner — silent when gated, empty, or debounced (#1709). */
export function renderSessionReadback(
  projectRoot: string,
  options: {
    policyOverride?: ValueFeedbackResolved;
    logPath?: string | null;
    now?: Date;
    maxChars?: number;
    writeHistory?: boolean;
  } = {},
): SessionReadbackResult {
  try {
    const root = resolve(projectRoot);
    if (maintainerReadbackDisabled(root)) {
      return { line: null, suppressed: false, gated: true };
    }

    const policy = options.policyOverride ?? resolveValueFeedback(root);
    if (isValueFeedbackPathAllowed("emitEvents", policy)) {
      probeAdoptionAtWorkBoundary(root, {
        logPath: options.logPath,
        policyOverride: policy,
      });
      probeFrictionAtWorkBoundary(root, {
        logPath: options.logPath,
        policyOverride: policy,
      });
    }
    if (!isValueFeedbackPathAllowed("sessionLine", policy)) {
      return { line: null, suppressed: false, gated: true };
    }

    const events = readAttributionEvents({ projectRoot: root, logPath: options.logPath });
    if (events.length === 0) {
      return { line: null, suppressed: false, gated: false };
    }

    const selected = selectSessionAttribution(events);
    if (selected === null) {
      return { line: null, suppressed: false, gated: false };
    }

    const hist = historyPath(root);
    if (shouldSuppressSessionReadback(selected.id, hist, { now: options.now })) {
      return { line: null, suppressed: true, gated: false };
    }

    const maxChars = options.maxChars ?? MAX_LINE_CHARS;
    const line = truncate(formatAttributedSessionLine(selected), maxChars);
    if (options.writeHistory !== false) {
      appendReadbackHistory(root, selected.id, line, { now: options.now });
    }
    return { line, suppressed: false, gated: false };
  } catch {
    return { line: null, suppressed: false, gated: false };
  }
}

/** Emit the session readback line to stdout when present. Returns the line or null. */
export function emitSessionValueReadback(
  projectRoot: string,
  options: {
    output?: (line: string) => void;
    policyOverride?: ValueFeedbackResolved;
    logPath?: string | null;
    now?: Date;
    writeHistory?: boolean;
  } = {},
): string | null {
  const result = renderSessionReadback(projectRoot, options);
  if (result.line === null) {
    return null;
  }
  const out = options.output ?? ((line: string) => process.stdout.write(`${line}\n`));
  out(result.line);
  return result.line;
}

export function parseWindowMs(raw: string | undefined, defaultDays = 7): number {
  if (raw === undefined || raw.trim().length === 0) {
    return defaultDays * 86_400_000;
  }
  const match = /^(\d+)([dhm])$/i.exec(raw.trim());
  if (match === null) {
    return defaultDays * 86_400_000;
  }
  const amount = Number.parseInt(match[1] ?? "", 10);
  if (!Number.isFinite(amount) || amount <= 0) {
    return defaultDays * 86_400_000;
  }
  const unit = (match[2] ?? "d").toLowerCase();
  if (unit === "h") {
    return amount * 3_600_000;
  }
  if (unit === "m") {
    return amount * 60_000;
  }
  return amount * 86_400_000;
}

function formatWindowLabel(windowMs: number): string {
  const days = Math.round(windowMs / 86_400_000);
  if (days >= 1 && days * 86_400_000 === windowMs) {
    return `${days}d`;
  }
  const hours = Math.round(windowMs / 3_600_000);
  if (hours >= 1 && hours * 3_600_000 === windowMs) {
    return `${hours}h`;
  }
  return `${windowMs}ms`;
}

/** Build attributed-value trend counts for pull-based value:show (#1709). */
export function computeValueShowTrend(
  projectRoot: string,
  options: { windowMs?: number; logPath?: string | null; now?: Date } = {},
): ValueShowTrend {
  const windowMs = options.windowMs ?? 7 * 86_400_000;
  const now = options.now ?? new Date();
  const since = new Date(now.getTime() - windowMs);
  const events = readAttributionEvents({
    projectRoot,
    logPath: options.logPath,
    since,
  });

  const byClass: Record<SignalClass, number> = {
    value: 0,
    bypass: 0,
    adoption: 0,
    friction: 0,
  };
  const byEvent: Record<string, number> = {};

  for (const record of events) {
    const cls = signalClassOf(record);
    if (cls !== null) {
      byClass[cls] += 1;
    }
    byEvent[record.event] = (byEvent[record.event] ?? 0) + 1;
  }

  return {
    windowLabel: formatWindowLabel(windowMs),
    windowMs,
    total: events.length,
    byClass,
    byEvent,
    recent: events.slice(-5),
  };
}

export function formatValueShowReport(trend: ValueShowTrend): string {
  if (trend.total === 0) {
    return (
      `[value] No attributed signals in the last ${trend.windowLabel} ` +
      "(ledger empty for this window).\n" +
      `Inspect policy: \`${policyColonInvocation("show", " --field=valueFeedback")}\`.\n`
    );
  }

  const classParts = (["value", "bypass", "adoption", "friction"] as const)
    .filter((key) => trend.byClass[key] > 0)
    .map((key) => `${key}=${trend.byClass[key]}`);

  const eventParts = Object.entries(trend.byEvent)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, count]) => `${name}: ${count}`);

  const lines = [
    `[value] Attributed signals (${trend.windowLabel}): ${trend.total} total`,
    `  classes: ${classParts.join(", ")}`,
    `  events: ${eventParts.join("; ")}`,
    "Pull detail any time with `task value:show -- --window=30d --format=json`.",
  ];
  return `${lines.join("\n")}\n`;
}

function attachCeremonyCost(
  result: Omit<ValueShowResult, "ceremonyCost">,
  ceremonyCost: CeremonyCostRollup,
  format: "text" | "json" | undefined,
): ValueShowResult {
  if (format === "json") {
    const payload =
      result.trend !== null
        ? {
            ...result.trend,
            ceremonyCost,
            process_cost_events: PROCESS_COST_EVENT_NAMES,
            gated: result.gated,
            attribution_gated: result.gated,
          }
        : {
            ceremonyCost,
            process_cost_events: PROCESS_COST_EVENT_NAMES,
            gated: result.gated,
            attribution_gated: result.gated,
            empty: result.empty,
          };
    return {
      ...result,
      ceremonyCost,
      text: `${JSON.stringify(payload, null, 2)}\n`,
    };
  }
  return {
    ...result,
    ceremonyCost,
    text: `${result.text}${formatCeremonyCostReport(ceremonyCost)}`,
  };
}

/** Pull-based value:show CLI core (#1709) with composed ceremony-cost reader (#3508). */
export function runValueShow(options: {
  projectRoot?: string | null;
  window?: string;
  format?: "text" | "json";
  logPath?: string | null;
  policyOverride?: ValueFeedbackResolved;
  now?: Date;
}): ValueShowResult {
  const rootRaw = resolveProjectRoot(options.projectRoot ?? undefined);
  if (rootRaw === null) {
    return {
      exitCode: 2,
      gated: false,
      empty: true,
      text: "Error: could not resolve project root.\n",
      trend: null,
      ceremonyCost: null,
    };
  }
  const root = resolve(rootRaw);
  const windowMs = parseWindowMs(options.window);
  const ceremonyCost = computeCeremonyCostRollup({
    projectRoot: root,
    logPath: options.logPath,
    windowMs,
    now: options.now,
    windowLabel: formatWindowLabel(windowMs),
  });

  if (maintainerReadbackDisabled(root)) {
    return attachCeremonyCost(
      {
        exitCode: 0,
        gated: false,
        empty: true,
        text:
          "[value] Attribution skipped: maintainer framework repo " +
          "(set DEFT_VALUE_SELF_DOGFOOD=1 to dogfood).\n",
        trend: null,
      },
      ceremonyCost,
      options.format,
    );
  }

  const policy = options.policyOverride ?? resolveValueFeedback(root);
  if (!policy.enabled) {
    return attachCeremonyCost(
      {
        exitCode: 1,
        gated: true,
        empty: true,
        text:
          "[value] Blocked: plan.policy.valueFeedback is OFF. " +
          `Enable with \`${policyColonInvocation("enable-value-feedback", " -- --confirm")}\`.\n`,
        trend: null,
      },
      ceremonyCost,
      options.format,
    );
  }

  const trend = computeValueShowTrend(root, {
    windowMs,
    logPath: options.logPath,
    now: options.now,
  });
  const empty = trend.total === 0;

  if (options.format === "json") {
    return attachCeremonyCost(
      {
        exitCode: 0,
        gated: false,
        empty,
        text: `${JSON.stringify(trend, null, 2)}\n`,
        trend,
      },
      ceremonyCost,
      "json",
    );
  }

  return attachCeremonyCost(
    {
      exitCode: 0,
      gated: false,
      empty,
      text: formatValueShowReport(trend),
      trend,
    },
    ceremonyCost,
    "text",
  );
}

export interface ValueShowCliArgs {
  window?: string;
  format?: "text" | "json";
  projectRoot?: string;
  error?: string;
}

export function parseValueShowArgs(argv: readonly string[]): ValueShowCliArgs {
  const out: ValueShowCliArgs = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] as string;
    if (arg === "--format") {
      const raw = argv[++i];
      if (raw === "json" || raw === "text") {
        out.format = raw;
      } else {
        return { ...out, error: `--format expects text|json, got ${JSON.stringify(raw)}` };
      }
    } else if (arg?.startsWith("--format=")) {
      const raw = arg.slice("--format=".length);
      if (raw === "json" || raw === "text") {
        out.format = raw;
      } else {
        return { ...out, error: `--format expects text|json, got ${JSON.stringify(raw)}` };
      }
    } else if (arg === "--window") {
      const raw = argv[++i];
      if (raw === undefined) {
        return { ...out, error: "--window requires a value (e.g. --window=7d)" };
      }
      out.window = raw;
    } else if (arg?.startsWith("--window=")) {
      out.window = arg.slice("--window=".length);
    } else if (arg === "--project-root") {
      const raw = argv[++i];
      if (raw === undefined) {
        return { ...out, error: "--project-root requires a path" };
      }
      out.projectRoot = raw;
    } else if (arg?.startsWith("--project-root=")) {
      out.projectRoot = arg.slice("--project-root=".length);
    } else if (arg.startsWith("-")) {
      return { ...out, error: `unrecognized argument: ${arg}` };
    }
  }
  return out;
}

/** CLI entry for value:show (#1709). */
export function valueShowMain(argv: readonly string[] = process.argv.slice(2)): number {
  const args = parseValueShowArgs(argv);
  if (args.error !== undefined) {
    process.stderr.write(`value:show: ${args.error}\n`);
    return 2;
  }
  const result = runValueShow({
    projectRoot: args.projectRoot,
    window: args.window,
    format: args.format ?? "text",
  });
  process.stdout.write(result.text);
  return result.exitCode;
}

/** CLI module entrypoint for dispatch (#1709). */
export function mainEntry(argv: string[] = process.argv.slice(2)): number {
  return valueShowMain(argv);
}
