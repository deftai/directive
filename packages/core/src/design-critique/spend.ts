import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { containedRemove, containedRename, containedWrite } from "../fs/contained-write.js";

/**
 * Design-critique spend front door (#4705 / #5111 / #5466).
 *
 * Session-local critic count chosen before Stop 1. Closed tokens only on
 * the operator chat utterance. Yolo is not a spend token. Bare panel does
 * not resolve. Missing or colliding classes ask unless a closed
 * `spend-recommend:` value is supplied. On bare arc, missing recommend is a
 * parent defect (record then resolve via spend-resolve) — not an ask trigger
 * (#5466 Prefer-A). Not a blast-radius selector and not a host default.
 */

export const ARC_SPENDS = ["N=1", "N≥3"] as const;

export type ArcSpend = (typeof ARC_SPENDS)[number];

export type SpendAskReason = "missing-token" | "ambiguous";

export type SpendParse =
  | { kind: "resolved"; spend: ArcSpend }
  | { kind: "ask"; reason: SpendAskReason };

export type SpendAskKind = "resolved" | "asked";

export const SPEND_FIELD = "spend:";

export const SPEND_ASK_FIELD = "spend-ask:";

export const SPEND_RECOMMEND_FIELD = "spend-recommend:";

export const N1_SPEND: ArcSpend = "N=1";

export const N3_SPEND: ArcSpend = "N≥3";

export const SPEND_ASK_REMEDIATION = "ask before Stop 1";

const N1_TOKEN_RE = /\bn=1(?!\.\d)\b/i;
const N3_TOKEN_RE = /\bn(?:=3|>=3|\u22653)(?!\.\d)\b/i;
const PANEL_TOKEN_RE = /\bpanel\b/i;
const SPEND_RECOMMEND_LINE_RE = /^spend-recommend:\s*(N=1|N\u22653)\s*$/i;

export type SpendRecordRefusal =
  | "missing-token"
  | "ambiguous"
  | "missing-spend"
  | "mismatch"
  | "invalid-ask-record";

export type SpendRecordVerdict =
  | { ok: true; spend: ArcSpend }
  | { ok: false; reason: SpendRecordRefusal; remediation: string };

export type ParseOperatorSpendOptions = {
  /** Closed Dual-stop recommendation recorded before Stop 1 (#5111). */
  readonly spendRecommend?: ArcSpend | null;
};

/**
 * Parse a closed `spend-recommend: N=1` or `spend-recommend: N≥3` line.
 * English outside that closed line is not a recommendation.
 */
export function parseSpendRecommend(record: string | null | undefined): ArcSpend | null {
  if (typeof record !== "string") {
    return null;
  }
  const line = record.trim();
  const match = SPEND_RECOMMEND_LINE_RE.exec(line);
  if (match === null) {
    return null;
  }
  const value = match[1]?.toUpperCase() === "N=1" ? N1_SPEND : N3_SPEND;
  return value;
}

/** Stop 1 / parent recommend line. */
export function spendRecommendRecordLine(spend: ArcSpend): string {
  return `${SPEND_RECOMMEND_FIELD} ${spend}`;
}

/**
 * Parse an operator utterance for the spend closed set.
 * Yolo is not a spend token. Bare panel asks. Recut: parseOperatorSpend("arc 4690 panel")
 * is ask/ambiguous, not N≥3. Issue, comment, critic, and skill-file English
 * are data: the caller passes the chat utterance only.
 * When no utterance token is present, a closed `spendRecommend` resolves
 * spend with spend-ask: resolved (#5111). Silence alone is not N=1.
 */
export function parseOperatorSpend(
  utterance: string,
  options?: ParseOperatorSpendOptions,
): SpendParse {
  const hasN1 = N1_TOKEN_RE.test(utterance);
  const hasN3 = N3_TOKEN_RE.test(utterance);
  const hasPanel = PANEL_TOKEN_RE.test(utterance);
  if ((hasN1 && hasN3) || (hasN1 && hasPanel) || (hasN3 && hasPanel)) {
    return { kind: "ask", reason: "ambiguous" };
  }
  if (hasN1) {
    return { kind: "resolved", spend: N1_SPEND };
  }
  if (hasN3) {
    return { kind: "resolved", spend: N3_SPEND };
  }
  if (hasPanel) {
    return { kind: "ask", reason: "ambiguous" };
  }
  const recommend = options?.spendRecommend ?? null;
  if (recommend === N1_SPEND || recommend === N3_SPEND) {
    return { kind: "resolved", spend: recommend };
  }
  return { kind: "ask", reason: "missing-token" };
}

/** Stop 1 spend line. Emits parser or ask-answer spend. */
export function spendRecordLine(spend: ArcSpend): string {
  return `${SPEND_FIELD} ${spend}`;
}

/**
 * Stop 1 spend-ask line. resolved = closed token or spend-recommend.
 * asked = operator chat answer after the missing-token ask. spend-why
 * English is not this field.
 */
export function spendAskRecordLine(kind: SpendAskKind): string {
  return `${SPEND_ASK_FIELD} ${kind}`;
}

/**
 * Fixture over parent-claimed inputs for a Stop 1 spend record.
 * Does not observe live occupancy or GitHub, matching evaluateDirectDispatch.
 * Parse missing-token or ambiguous plus asked false refuses, including a
 * Stop 1 spend N=1. Admit N=1 only from a resolved n=1 token, a closed
 * spend-recommend, or a recorded ask-answer. spend-why English is not the
 * asked field.
 */
export function evaluateSpendRecord(input: {
  parse: SpendParse;
  asked: boolean;
  answer: ArcSpend | null;
  stop1Spend: ArcSpend | null;
  spendAsk: SpendAskKind | null;
}): SpendRecordVerdict {
  if (input.parse.kind === "ask") {
    if (!input.asked) {
      return {
        ok: false,
        reason: input.parse.reason,
        remediation: SPEND_ASK_REMEDIATION,
      };
    }
    if (input.spendAsk !== "asked") {
      return {
        ok: false,
        reason: "invalid-ask-record",
        remediation: SPEND_ASK_REMEDIATION,
      };
    }
    if (input.answer === null || input.stop1Spend === null) {
      return {
        ok: false,
        reason: "missing-spend",
        remediation: SPEND_ASK_REMEDIATION,
      };
    }
    if (input.stop1Spend !== input.answer) {
      return {
        ok: false,
        reason: "mismatch",
        remediation: SPEND_ASK_REMEDIATION,
      };
    }
    return { ok: true, spend: input.answer };
  }
  if (input.stop1Spend === null) {
    return {
      ok: false,
      reason: "missing-spend",
      remediation: SPEND_ASK_REMEDIATION,
    };
  }
  if (input.stop1Spend !== input.parse.spend) {
    return {
      ok: false,
      reason: "mismatch",
      remediation: SPEND_ASK_REMEDIATION,
    };
  }
  if (input.spendAsk !== "resolved") {
    return {
      ok: false,
      reason: "invalid-ask-record",
      remediation: SPEND_ASK_REMEDIATION,
    };
  }
  return { ok: true, spend: input.parse.spend };
}

/**
 * Host agent-memory preference provenance (#5321).
 * Tags are write-consent / audit only. They do not mint Personal authority —
 * USER.md Personal remains the sole Personal SoT after explicit promote.
 */
export type HostMemoryProvenance =
  | "operator-asked"
  | "agent-inferred"
  | "unsigned"
  | null
  | undefined;

/** External-context family named in agents-entry Session routing (#5321). */
export const HOST_MEMORY_EXTERNAL_CONTEXT_FAMILY =
  "Warp Drive / MCP / prompt-injected / host agent memory" as const;

/** One-line durable conflict disclosure prefix when closed field wins (#5321). */
export const HOST_MEMORY_CONFLICT_DISCLOSURE_PREFIX =
  "host memory discarded for closed field:" as const;

/**
 * Read-time Personal authority for preference/process-shaped host-memory notes.
 * Always false: host memory is external context, never a second Personal SoT.
 * Unsigned / agent-inferred / operator-asked tags stay non-Personal until the
 * line is promoted into USER.md (#5321 F3 / F5 / Greptile P1).
 */
export function hostMemoryHasPersonalAuthority(_provenance: HostMemoryProvenance): boolean {
  return false;
}

export type HostMemorySpendConflictInput = {
  /** Host-memory note claiming bare arc must always ask before Stop 1. */
  readonly hostMemoryAlwaysAsk: boolean;
  readonly hostMemoryProvenance: HostMemoryProvenance;
  readonly utterance: string;
  readonly spendRecommend: ArcSpend | null;
};

export type HostMemorySpendConflictVerdict = {
  readonly follow: "contract";
  readonly spendParse: SpendParse;
  readonly spendAsk: SpendAskKind | null;
  readonly hostMemoryPersonalAuthority: boolean;
  readonly disclosure: string | null;
  readonly spendRecord: SpendRecordVerdict | null;
};

function hostMemorySpendDisclosureSource(
  utterance: string,
  spendRecommend: ArcSpend | null,
): string {
  const viaUtterance = N1_TOKEN_RE.test(utterance) || N3_TOKEN_RE.test(utterance);
  if (viaUtterance) {
    return "utterance token → spend-ask: resolved";
  }
  if (spendRecommend !== null) {
    return "spend-recommend → spend-ask: resolved";
  }
  return "spend-ask: resolved";
}

/**
 * Closed conflict exemplar (#5321 / #5318): host-memory "always ask" loses to
 * closed spend resolution (utterance token or spend-recommend → spend-ask:
 * resolved). Contract wins; emit one-line disclosure whenever non-Personal
 * host memory is discarded for that closed field. Consented USER.md Personal
 * overrides are outside this host-memory fixture.
 */
export function evaluateHostMemorySpendConflict(
  input: HostMemorySpendConflictInput,
): HostMemorySpendConflictVerdict {
  const personal = hostMemoryHasPersonalAuthority(input.hostMemoryProvenance);
  const spendParse = parseOperatorSpend(input.utterance, {
    spendRecommend: input.spendRecommend,
  });
  const spendAsk: SpendAskKind | null = spendParse.kind === "resolved" ? "resolved" : null;
  const spendRecord =
    spendParse.kind === "resolved"
      ? evaluateSpendRecord({
          parse: spendParse,
          asked: false,
          answer: null,
          stop1Spend: spendParse.spend,
          spendAsk: "resolved",
        })
      : null;
  const discarded = input.hostMemoryAlwaysAsk && !personal && spendParse.kind === "resolved";
  return {
    follow: "contract",
    spendParse,
    spendAsk,
    hostMemoryPersonalAuthority: personal,
    disclosure: discarded
      ? `${HOST_MEMORY_CONFLICT_DISCLOSURE_PREFIX} spend (${hostMemorySpendDisclosureSource(
          input.utterance,
          input.spendRecommend,
        )})`
      : null,
    spendRecord,
  };
}

/** Parent-written arc spend scratch (#5466 Prefer-A limb 3). */
export const ARC_SPEND_STATE_SCHEMA = "deft.design-critique.arc-spend-state.v1" as const;

/** @deprecated Project-wide path; session-scoped path is authoritative. */
export const ARC_SPEND_STATE_REL_PARTS = [
  ".deft-scratch",
  "design-critique",
  "arc-spend-state.json",
] as const;

export type ArcSpendState = {
  readonly schema: typeof ARC_SPEND_STATE_SCHEMA;
  readonly status: "in-flight";
  readonly spendRecommend: ArcSpend | null;
  readonly spend: ArcSpend | null;
  readonly spendAsk: SpendAskKind | null;
  /** True after a resolve attempt that left ask lawful (ambiguous / unclosable). */
  readonly askPermitted: boolean;
  readonly updatedAt: string;
  readonly utterance: string | null;
  /** Session that owns this in-flight gate (parallel arcs must not share). */
  readonly sessionId: string;
};

export type ArcSpendSessionOpts = {
  readonly sessionId?: string | null;
  readonly env?: NodeJS.ProcessEnv;
};

/**
 * Sanitize session id for scratch path segments. Separators / traversal fall
 * back to no-session (returned-failure shape; no throw).
 */
export function sanitizeArcSpendSessionId(sessionId: string | undefined): string {
  const raw = (sessionId ?? "no-session").trim();
  if (raw.includes("..") || /[\\/]/.test(raw)) {
    return "no-session";
  }
  const safe = raw.replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 80);
  return safe.length > 0 ? safe : "no-session";
}

/**
 * Resolve the session that owns arc-spend-state. Explicit flag wins, then
 * DEFT_SESSION_ID / DEFT_MONITOR_AGENT_ID / GROK_SESSION_ID, else no-session.
 */
export function resolveArcSpendSessionId(opts: ArcSpendSessionOpts = {}): string {
  const explicit = opts.sessionId?.trim();
  if (explicit !== undefined && explicit.length > 0) {
    return sanitizeArcSpendSessionId(explicit);
  }
  const env = opts.env ?? process.env;
  for (const key of ["DEFT_SESSION_ID", "DEFT_MONITOR_AGENT_ID", "GROK_SESSION_ID"] as const) {
    const value = typeof env[key] === "string" ? env[key].trim() : "";
    if (value.length > 0) return sanitizeArcSpendSessionId(value);
  }
  return sanitizeArcSpendSessionId("no-session");
}

export function arcSpendStateRelParts(sessionId: string): readonly string[] {
  return [
    ".deft-scratch",
    "design-critique",
    "sessions",
    sanitizeArcSpendSessionId(sessionId),
    "arc-spend-state.json",
  ];
}

export function arcSpendStatePath(projectRoot: string, opts: ArcSpendSessionOpts = {}): string {
  const sessionId = resolveArcSpendSessionId(opts);
  return join(projectRoot, ...arcSpendStateRelParts(sessionId));
}

export function legacyArcSpendStatePath(projectRoot: string): string {
  return join(projectRoot, ...ARC_SPEND_STATE_REL_PARTS);
}

export function readArcSpendState(
  projectRoot: string,
  opts: ArcSpendSessionOpts = {},
): ArcSpendState | null {
  try {
    const raw = readFileSync(arcSpendStatePath(projectRoot, opts), "utf8");
    const parsed = JSON.parse(raw) as ArcSpendState;
    if (parsed.schema !== ARC_SPEND_STATE_SCHEMA) return null;
    if (parsed.status !== "in-flight") return null;
    return parsed;
  } catch {
    return null;
  }
}

export function writeArcSpendState(
  projectRoot: string,
  state: ArcSpendState,
  opts: ArcSpendSessionOpts = {},
): void {
  const sessionId = state.sessionId || resolveArcSpendSessionId(opts);
  const target = arcSpendStatePath(projectRoot, { ...opts, sessionId });
  const dir = join(target, "..");
  mkdirSync(dir, { recursive: true });
  const tmp = `${target}.${process.pid}.tmp`;
  const toWrite: ArcSpendState = { ...state, sessionId };
  containedWrite({
    root: projectRoot,
    target: tmp,
    data: `${JSON.stringify(toWrite, null, 2)}\n`,
    mode: "replace",
    mutation: false,
  });
  containedRename({ root: projectRoot, from: tmp, to: target, mutation: false });
}

/**
 * Open the Prefer-A deny gate at arc start before any structured ask (#5466).
 * Session-scoped so abandoned arcs cannot poison other sessions. Independent
 * of a successful --recommend resolve so the first ask cannot slip through a
 * missing state file once the gate is open.
 */
export function openArcSpendGate(
  projectRoot: string,
  input: {
    readonly utterance?: string | null;
    readonly nowMs?: number;
    readonly sessionId?: string | null;
    readonly env?: NodeJS.ProcessEnv;
  } = {},
): ArcSpendState {
  const sessionId = resolveArcSpendSessionId(input);
  const state: ArcSpendState = {
    schema: ARC_SPEND_STATE_SCHEMA,
    status: "in-flight",
    spendRecommend: null,
    spend: null,
    spendAsk: null,
    askPermitted: false,
    updatedAt: new Date(input.nowMs ?? Date.now()).toISOString(),
    utterance: input.utterance ?? null,
    sessionId,
  };
  writeArcSpendState(projectRoot, state, input);
  return state;
}

/**
 * Clear session-scoped arc spend scratch when the arc ends or is abandoned.
 * Also removes the legacy project-wide file so abandoned pre-session state
 * cannot keep denying unrelated questions.
 */
export function clearArcSpendState(projectRoot: string, opts: ArcSpendSessionOpts = {}): boolean {
  const sessionRemoved = containedRemove({
    root: projectRoot,
    target: arcSpendStatePath(projectRoot, opts),
    mutation: false,
  }).removed;
  const legacyRemoved = containedRemove({
    root: projectRoot,
    target: legacyArcSpendStatePath(projectRoot),
    mutation: false,
  }).removed;
  return sessionRemoved || legacyRemoved;
}

export type SpendAskDenyOpts = {
  /**
   * True when the structured-question option labels are Dual-stop spend choices
   * (N=1 / N≥3). Missing session state denies only spend-shaped asks so a fresh
   * arc cannot slip the first spend question past an unopened gate; unrelated
   * questions stay allowed (#5466).
   */
  readonly spendShaped?: boolean;
};

/**
 * Deny spend-shaped structured asks while the session arc gate is open and no
 * closed spend-recommend / resolved spend exists yet, unless a prior resolve
 * attempt marked ask lawful (#5466). Missing state denies only when
 * `spendShaped` is true — never blanket-deny unrelated questions, and never
 * read the deprecated project-wide path.
 */
export function isSpendAskDeniedByArcState(
  state: ArcSpendState | null,
  opts: SpendAskDenyOpts = {},
): boolean {
  const spendShaped = opts.spendShaped === true;
  if (state === null) return spendShaped;
  if (state.status !== "in-flight") return false;
  if (state.spendRecommend !== null) return false;
  if (state.spendAsk === "resolved" && state.spend !== null) return false;
  if (state.askPermitted) return false;
  return spendShaped;
}

/**
 * True when structured-question option labels look like Dual-stop spend choices.
 * Strips the canonical leading ``N. `` number prefix used by host widgets so
 * ``1. N=1`` / ``2. N≥3`` still count as spend-shaped (#5466).
 */
export function optionLabelsLookLikeSpend(labels: readonly string[]): boolean {
  for (const label of labels) {
    const trimmed = label
      .trim()
      .replace(/^\d+\.\s*/, "")
      .trim();
    if (/^N=1$/i.test(trimmed)) return true;
    if (/^N(?:>=|\u2265)3$/i.test(trimmed)) return true;
  }
  return false;
}

/** Parse `--recommend N=1|N≥3|N>=3` for spend-resolve (#5466). */
export function parseRecommendFlag(raw: string | null | undefined): ArcSpend | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (/^N=1$/i.test(trimmed)) return N1_SPEND;
  if (/^N(?:>=|\u2265)3$/i.test(trimmed)) return N3_SPEND;
  return null;
}

export type ResolveDesignCritiqueSpendInput = {
  readonly utterance: string;
  readonly recommendRaw?: string | null;
  /** Parent-declared unclosable recommend: permit a lawful ask without inventing N. */
  readonly unclosableRecommend?: boolean;
  readonly projectRoot: string;
  readonly nowMs?: number;
  readonly sessionId?: string | null;
  readonly env?: NodeJS.ProcessEnv;
};

export type ResolveDesignCritiqueSpendResult =
  | {
      readonly ok: true;
      readonly spend: ArcSpend;
      /** Present only when --recommend supplied; operator n= does not invent it. */
      readonly spendRecommend: ArcSpend | null;
      readonly lines: readonly string[];
      readonly state: ArcSpendState;
    }
  | {
      readonly ok: false;
      readonly code: "missing-recommend" | "ambiguous" | "invalid-recommend" | "unclosable";
      readonly message: string;
      readonly state: ArcSpendState;
    };

/**
 * Callable spend front door (#5466). Mirrors only the callable pattern of
 * resolveArcRunPostureForHost — never copies missing-token auto-resolve onto
 * spend. Bare arc requires explicit --recommend; never defaults N=1; never asks.
 */
export function resolveDesignCritiqueSpend(
  input: ResolveDesignCritiqueSpendInput,
): ResolveDesignCritiqueSpendResult {
  const now = input.nowMs ?? Date.now();
  const updatedAt = new Date(now).toISOString();
  const sessionId = resolveArcSpendSessionId(input);
  const sessionOpts = { sessionId, env: input.env };
  const baseState = (): Omit<
    ArcSpendState,
    "spendRecommend" | "spend" | "spendAsk" | "askPermitted"
  > => ({
    schema: ARC_SPEND_STATE_SCHEMA,
    status: "in-flight",
    updatedAt,
    utterance: input.utterance,
    sessionId,
  });
  const recommend =
    input.recommendRaw === undefined || input.recommendRaw === null || input.recommendRaw === ""
      ? null
      : parseRecommendFlag(input.recommendRaw);

  if (
    input.recommendRaw !== undefined &&
    input.recommendRaw !== null &&
    input.recommendRaw !== "" &&
    recommend === null
  ) {
    const state: ArcSpendState = {
      ...baseState(),
      spendRecommend: null,
      spend: null,
      spendAsk: null,
      askPermitted: false,
    };
    writeArcSpendState(input.projectRoot, state, sessionOpts);
    return {
      ok: false,
      code: "invalid-recommend",
      message:
        "design-critique:spend-resolve: invalid --recommend (expected N=1 or N\u22653). " +
        "Supply --recommend N=1|N\u22653.",
      state,
    };
  }

  const parse = parseOperatorSpend(input.utterance, { spendRecommend: recommend });

  if (parse.kind === "ask" && parse.reason === "ambiguous") {
    const state: ArcSpendState = {
      ...baseState(),
      spendRecommend: recommend,
      spend: null,
      spendAsk: null,
      askPermitted: true,
    };
    writeArcSpendState(input.projectRoot, state, sessionOpts);
    return {
      ok: false,
      code: "ambiguous",
      message:
        "design-critique:spend-resolve: utterance is ambiguous (colliding tokens or bare panel). " +
        "Ask is lawful under the #5373 hatch after this resolve attempt; do not invent N.",
      state,
    };
  }

  if (parse.kind === "ask" && parse.reason === "missing-token") {
    if (input.unclosableRecommend === true) {
      const state: ArcSpendState = {
        ...baseState(),
        spendRecommend: null,
        spend: null,
        spendAsk: null,
        askPermitted: true,
      };
      writeArcSpendState(input.projectRoot, state, sessionOpts);
      return {
        ok: false,
        code: "unclosable",
        message:
          "design-critique:spend-resolve: parent declared unclosable recommend. " +
          "Ask is lawful under the #5373 hatch; do not invent N.",
        state,
      };
    }
    const state: ArcSpendState = {
      ...baseState(),
      spendRecommend: null,
      spend: null,
      spendAsk: null,
      askPermitted: false,
    };
    writeArcSpendState(input.projectRoot, state, sessionOpts);
    return {
      ok: false,
      code: "missing-recommend",
      message:
        "design-critique:spend-resolve: bare arc missing --recommend is a parent defect. " +
        "Record spend-recommend then resolve: supply --recommend N=1 (or N\u22653 under panel permission). " +
        "Never ask; never default N=1.",
      state,
    };
  }

  if (parse.kind !== "resolved") {
    const state: ArcSpendState = {
      ...baseState(),
      spendRecommend: null,
      spend: null,
      spendAsk: null,
      askPermitted: false,
    };
    writeArcSpendState(input.projectRoot, state, sessionOpts);
    return {
      ok: false,
      code: "missing-recommend",
      message:
        "design-critique:spend-resolve: bare arc missing --recommend is a parent defect. " +
        "Supply --recommend N=1|N\u22653.",
      state,
    };
  }

  // Parent --recommend is the only spend-recommend source. Operator n= sets spend
  // only and must not invent spend-recommend (esp. N≥3 without panel permission).
  const spendRecommend = recommend;
  const record = evaluateSpendRecord({
    parse,
    asked: false,
    answer: null,
    stop1Spend: parse.spend,
    spendAsk: "resolved",
  });
  if (!record.ok) {
    const state: ArcSpendState = {
      ...baseState(),
      spendRecommend: null,
      spend: null,
      spendAsk: null,
      askPermitted: false,
    };
    writeArcSpendState(input.projectRoot, state, sessionOpts);
    return {
      ok: false,
      code: "missing-recommend",
      message: `design-critique:spend-resolve: spend record refused (${record.reason}). Supply --recommend N=1|N\u22653.`,
      state,
    };
  }

  const state: ArcSpendState = {
    ...baseState(),
    spendRecommend,
    spend: record.spend,
    spendAsk: "resolved",
    askPermitted: false,
  };
  writeArcSpendState(input.projectRoot, state, sessionOpts);
  const lines =
    spendRecommend !== null
      ? [
          spendRecommendRecordLine(spendRecommend),
          spendRecordLine(record.spend),
          spendAskRecordLine("resolved"),
        ]
      : [spendRecordLine(record.spend), spendAskRecordLine("resolved")];
  return {
    ok: true,
    spend: record.spend,
    spendRecommend,
    lines,
    state,
  };
}
