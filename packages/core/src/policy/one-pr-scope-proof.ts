/**
 * One-PR scope proof level (#6273).
 *
 * `plan.policy.onePrScopeProof` is the owner-chosen proof level for landing a
 * new or widened brief with its code in one PR:
 * - `off` (default): today's behaviour. A same-PR approved-scope record is refused.
 * - `mint`: a same-PR human-presence mint record may admit the head brief for
 *   membership when the record names exactly the head brief's scope.
 * - `signed`: reserved for #5862. The setter refuses it.
 *
 * The level and `requireHumanMerge` are read from the merge base only. A PR that
 * changes either field cannot use the one-PR path.
 *
 * CI cannot tell a real mint from a file an agent wrote. The control depends on
 * the merge-base merge policy (#6354): with `requireHumanMerge: true` the human
 * merge is the control; otherwise CI verifies nothing human and the control is
 * the local mint gate plus the always-on protected-store deny on
 * `.deft/approved-scope/`. The local write fence admits a brief absent from the
 * merge base on this same mint (#6361), so the shell-write residual
 * (#3597, #3595) also reaches local scope admission.
 */

import {
  compareExtractedIntent,
  type IntentCompareFinding,
} from "../scope-provenance/compare-intent.js";
import {
  type ApprovedScopeRecord,
  computeFileScopeDigest,
  extractFileScope,
  extractPlanId,
  isHumanApprovalStamp,
  normalizeFileScope,
} from "../scope-provenance/digest.js";
import {
  type ExtractIntentOptions,
  extractIntentFromRaw,
} from "../scope-provenance/extract-intent.js";
import { computeAuthHashV1 } from "../scope-provenance/forge-approval.js";
import { computeIntentDigest } from "../scope-provenance/intent-digest.js";
import { parseIntentPreimageRaw } from "../scope-provenance/intent-evaluate.js";
import { withProjectDefinitionMutation } from "../vbrief-build/project-definition-mutation.js";
import { migrateLegacyPolicyKey, PLAN_POLICY_KEY, readPlanPolicy } from "./plan-extensions.js";
import { policyColonInvocation } from "./policy-invocation.js";
import { appendAuditLog, loadProjectDefinition } from "./resolve.js";

/** Canonical registered policy field name. */
export const FIELD_ONE_PR_SCOPE_PROOF = "plan.policy.onePrScopeProof";

/** Short alias for `policy:show --field=onePrScopeProof`. */
export const FIELD_ONE_PR_SCOPE_PROOF_CLI_ALIAS = "onePrScopeProof";

export const ONE_PR_SCOPE_PROOF_LEVELS = ["off", "mint", "signed"] as const;
export type OnePrScopeProofLevel = (typeof ONE_PR_SCOPE_PROOF_LEVELS)[number];

/** Levels the setter writes. `signed` is reserved until #5862 lands. */
export const SETTABLE_ONE_PR_SCOPE_PROOF_LEVELS = ["off", "mint"] as const;
export type SettableOnePrScopeProofLevel = (typeof SETTABLE_ONE_PR_SCOPE_PROOF_LEVELS)[number];

export const DEFAULT_ONE_PR_SCOPE_PROOF: OnePrScopeProofLevel = "off";

/** Control line for a mint-level admit when merge-base `requireHumanMerge` is true. */
export const MINT_LEVEL_CI_LIMIT_LINE =
  "CI cannot tell this mint from a file an agent wrote; the human merge is the control";

/**
 * Control line for a mint-level admit without a merge-base human merge
 * (#6354 / #6361). The local write fence now reads the mint, so the part of it
 * that stays a control is its always-on protected-store deny.
 */
export const MINT_LEVEL_LOCAL_CONTROL_LINE =
  "CI cannot tell this mint from a file an agent wrote; requireHumanMerge is not true " +
  "on the merge base, so CI verifies nothing human: the control is the local mint gate " +
  "and the write fence's protected-store deny on .deft/approved-scope/; a record written " +
  "by a shell form that deny misses (#3597, #3595) also reaches local scope admission";

export const SIGNED_LEVEL_RESERVED_MESSAGE =
  "onePrScopeProof=signed is reserved: the signed level lands with #5862. " +
  "Use --set mint or --set off.";

export type OnePrScopeProofSource = "typed" | "default" | "default-on-error";

export interface OnePrScopeProofResolved {
  readonly level: OnePrScopeProofLevel;
  readonly source: OnePrScopeProofSource;
  readonly error: string | null;
}

export interface OnePrScopeProofPolicyField {
  readonly name: typeof FIELD_ONE_PR_SCOPE_PROOF;
  readonly current: OnePrScopeProofLevel;
  readonly default: OnePrScopeProofLevel;
  readonly source: string;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

export function isOnePrScopeProofLevel(value: unknown): value is OnePrScopeProofLevel {
  return (
    typeof value === "string" && (ONE_PR_SCOPE_PROOF_LEVELS as readonly string[]).includes(value)
  );
}

/** Missing/null → off. Malformed → off with an error (fail closed). */
export function resolveOnePrScopeProofFromPlan(plan: unknown): OnePrScopeProofResolved {
  const policyBlock = readPlanPolicy(plan);
  if (policyBlock === undefined) {
    return { level: DEFAULT_ONE_PR_SCOPE_PROOF, source: "default", error: null };
  }
  const block = asRecord(policyBlock);
  if (block === null) {
    return {
      level: DEFAULT_ONE_PR_SCOPE_PROOF,
      source: "default-on-error",
      error: "plan.policy must be an object",
    };
  }
  const raw = block.onePrScopeProof;
  if (raw === undefined || raw === null) {
    return { level: DEFAULT_ONE_PR_SCOPE_PROOF, source: "default", error: null };
  }
  if (isOnePrScopeProofLevel(raw)) {
    return { level: raw, source: "typed", error: null };
  }
  const shown = typeof raw === "string" ? JSON.stringify(raw) : typeof raw;
  return {
    level: DEFAULT_ONE_PR_SCOPE_PROOF,
    source: "default-on-error",
    error: `${FIELD_ONE_PR_SCOPE_PROOF} must be one of ${ONE_PR_SCOPE_PROOF_LEVELS.join("|")}; got ${shown}`,
  };
}

/** Resolve from the working-tree PROJECT-DEFINITION (inspection only, never gating). */
export function resolveOnePrScopeProof(projectRoot: string): OnePrScopeProofResolved {
  const [data, err] = loadProjectDefinition(projectRoot);
  if (data === null) {
    if (err?.includes("PROJECT-DEFINITION not found")) {
      return { level: DEFAULT_ONE_PR_SCOPE_PROOF, source: "default", error: null };
    }
    return {
      level: DEFAULT_ONE_PR_SCOPE_PROOF,
      source: "default-on-error",
      error: err ?? "PROJECT-DEFINITION unreadable",
    };
  }
  return resolveOnePrScopeProofFromPlan(data.plan);
}

/** Inspector row for policy:show --field=onePrScopeProof. */
export function inspectOnePrScopeProof(
  data: Record<string, unknown> | null,
  projectRoot?: string,
): OnePrScopeProofPolicyField {
  const resolved =
    data !== null
      ? resolveOnePrScopeProofFromPlan(data.plan)
      : projectRoot !== undefined
        ? resolveOnePrScopeProof(projectRoot)
        : { level: DEFAULT_ONE_PR_SCOPE_PROOF, source: "default" as const, error: null };
  return {
    name: FIELD_ONE_PR_SCOPE_PROOF,
    current: resolved.level,
    default: DEFAULT_ONE_PR_SCOPE_PROOF,
    source: resolved.source,
  };
}

// ---------------------------------------------------------------------------
// Merge-base gate
// ---------------------------------------------------------------------------

export type OnePrScopeProofGate =
  | {
      readonly kind: "mint";
      /** Merge-base `requireHumanMerge` is a typed `true` (#6354). */
      readonly humanMerge: boolean;
    }
  | { readonly kind: "off" }
  | { readonly kind: "refuse"; readonly reason: string };

interface PolicyFieldsRead {
  readonly ok: boolean;
  readonly level: unknown;
  readonly requireHumanMerge: unknown;
}

function readPolicyFields(raw: string | null): PolicyFieldsRead {
  if (raw === null) return { ok: false, level: undefined, requireHumanMerge: undefined };
  let data: unknown;
  try {
    data = JSON.parse(raw) as unknown;
  } catch {
    return { ok: false, level: undefined, requireHumanMerge: undefined };
  }
  const plan = asRecord(data)?.plan;
  if (asRecord(plan) === null) return { ok: false, level: undefined, requireHumanMerge: undefined };
  const block = asRecord(readPlanPolicy(plan)) ?? {};
  return { ok: true, level: block.onePrScopeProof, requireHumanMerge: block.requireHumanMerge };
}

function sameValue(a: unknown, b: unknown): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

/**
 * Decide the one-PR proof level for a change set (#6273).
 *
 * `baseRaw` is PROJECT-DEFINITION at the merge base; `headRaw` is the head
 * copy. Only the merge base sets the level, and the head must not change
 * `onePrScopeProof` or `requireHumanMerge`. `mint` carries the merge-base merge
 * policy (`humanMerge`) so the admit block can name the control; it is not a
 * precondition (#6354). `off` means the level is off at the merge base
 * (today's behaviour).
 */
export function evaluateOnePrScopeProofGate(input: {
  readonly baseRaw: string | null;
  readonly headRaw: string | null;
}): OnePrScopeProofGate {
  const base = readPolicyFields(input.baseRaw);
  if (!base.ok) return { kind: "off" };
  if (base.level === undefined || base.level === null || base.level === "off") {
    return { kind: "off" };
  }
  if (base.level === "signed") {
    return { kind: "refuse", reason: "merge-base level signed is reserved for #5862" };
  }
  if (base.level !== "mint") {
    return { kind: "refuse", reason: "merge-base onePrScopeProof is malformed" };
  }
  const head = readPolicyFields(input.headRaw);
  if (!head.ok) {
    return { kind: "refuse", reason: "head PROJECT-DEFINITION unreadable" };
  }
  if (
    !sameValue(head.level, base.level) ||
    !sameValue(head.requireHumanMerge, base.requireHumanMerge)
  ) {
    return {
      kind: "refuse",
      reason: "this change set edits onePrScopeProof or requireHumanMerge",
    };
  }
  return { kind: "mint", humanMerge: base.requireHumanMerge === true };
}

// ---------------------------------------------------------------------------
// Same-PR record admit
// ---------------------------------------------------------------------------

export type MintLevelRecordVerdict =
  | { readonly kind: "admit"; readonly fileScope: readonly string[] }
  | { readonly kind: "reject"; readonly reason: string };

export interface MintLevelRecordInput {
  /** Same-PR `.deft/approved-scope/<id>.json` (head copy), or null. */
  readonly record: ApprovedScopeRecord | null;
  /** Same-PR `.intent.json` text (head copy), or null. */
  readonly intentRaw: string | null;
  readonly xbriefRelPath: string;
  readonly headPayload: unknown;
  readonly headRaw: string;
  readonly changedFiles?: readonly string[];
  readonly extract?: ExtractIntentOptions;
  readonly decisionExists?: (relPath: string) => boolean;
}

function normalizeRel(raw: string): string {
  return raw.replace(/\\/g, "/").replace(/^\.\//, "");
}

function hasGlob(entry: string): boolean {
  return entry.includes("*") || entry.includes("?") || entry.includes("[");
}

function describeIntentFinding(f: IntentCompareFinding): string {
  return `${f.path}: ${f.detail}`;
}

/**
 * Admit a same-PR human mint record for membership at the mint level (#6273).
 * Every check must hold; any failure is a reject with a reason. Never throws.
 */
export function evaluateMintLevelRecord(input: MintLevelRecordInput): MintLevelRecordVerdict {
  try {
    return evaluateMintLevelRecordUnsafe(input);
  } catch (err) {
    return {
      kind: "reject",
      reason: `mint record unreadable: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

function evaluateMintLevelRecordUnsafe(input: MintLevelRecordInput): MintLevelRecordVerdict {
  const deny = (reason: string): MintLevelRecordVerdict => ({ kind: "reject", reason });
  const rel = normalizeRel(input.xbriefRelPath);
  const record = input.record;
  if (record === null) return deny("no same-PR approved-scope record");
  if (!isHumanApprovalStamp(record.humanApproval)) return deny("record lacks a human stamp");

  const planId = extractPlanId(input.headPayload);
  if (planId === null) return deny("head brief has no plan.id");
  if (record.planId !== planId) return deny("record planId does not match the head brief");
  if (typeof record.xbriefRelPath !== "string" || normalizeRel(record.xbriefRelPath) !== rel) {
    return deny("record xbriefRelPath does not match the head brief");
  }

  const headScope = normalizeFileScope(extractFileScope(input.headPayload));
  if (headScope.some(hasGlob)) return deny("head brief file_scope has a glob entry");
  const recordScope = normalizeFileScope(Array.isArray(record.fileScope) ? record.fileScope : []);
  if (
    recordScope.length !== headScope.length ||
    recordScope.some((entry, i) => entry !== headScope[i])
  ) {
    return deny("record fileScope differs from the head brief file_scope");
  }
  if (record.fileScopeDigest !== computeFileScopeDigest(headScope)) {
    return deny("record fileScopeDigest does not match the head brief file_scope");
  }

  const headHash = computeAuthHashV1(input.headPayload, rel);
  if (typeof record.authHashV1 !== "string" || record.authHashV1.length === 0) {
    return deny("record has no authHashV1");
  }
  if (headHash === null || record.authHashV1 !== headHash) {
    return deny("record authHashV1 differs from the head brief");
  }

  // Intent pin: the same-PR preimage must be the one the mint wrote, and the
  // head brief must not drift from it (#3385 semantics on the same-PR pair).
  if (typeof record.intentDigest !== "string" || record.intentDigest.length === 0) {
    return deny("record has no intentDigest");
  }
  if (input.intentRaw === null) return deny("no same-PR intent preimage");
  const preimage = parseIntentPreimageRaw(input.intentRaw);
  if (preimage === null) return deny("same-PR intent preimage is malformed");
  if (computeIntentDigest(preimage) !== record.intentDigest) {
    return deny("intent preimage digest does not match the record");
  }
  const live = extractIntentFromRaw(input.headRaw, input.extract ?? {});
  if (!live.ok) return deny(`head brief intent unreadable: ${live.error}`);
  const compared = compareExtractedIntent(preimage, live.preimage, {
    changedFiles: input.changedFiles,
    decisionExists: input.decisionExists,
  });
  if (!compared.ok) {
    return deny(
      `head brief drifted from the minted intent (${compared.findings.map(describeIntentFinding).join("; ")})`,
    );
  }
  return { kind: "admit", fileScope: headScope };
}

// ---------------------------------------------------------------------------
// Visibility
// ---------------------------------------------------------------------------

export interface MintLevelAdmit {
  readonly planId: string;
  readonly xbriefRelPath: string;
  readonly fileScope: readonly string[];
  readonly productionFileCount: number;
  /** Merge-base `requireHumanMerge` is a typed `true`; picks the control line (#6354). */
  readonly humanMerge: boolean;
}

/** The control line for the merge-base merge policy (#6354). */
export function mintLevelControlLine(humanMerge: boolean): string {
  return humanMerge ? MINT_LEVEL_CI_LIMIT_LINE : MINT_LEVEL_LOCAL_CONTROL_LINE;
}

/** Plain-text admit block for stdout and `$GITHUB_STEP_SUMMARY` (#6273 / #6354). */
export function formatMintLevelAdmitBlock(admit: MintLevelAdmit): string {
  const lines = [
    `one-PR scope proof (mint level, #6273): ${admit.xbriefRelPath}`,
    `  plan id: ${admit.planId}`,
    `  production files: ${String(admit.productionFileCount)}`,
    `  admitted file_scope (${String(admit.fileScope.length)}):`,
    ...admit.fileScope.map((p) => `    - ${p}`),
    `  merge-base requireHumanMerge: ${admit.humanMerge ? "true" : "not true"}`,
    `  ${mintLevelControlLine(admit.humanMerge)}`,
  ];
  return `${lines.join("\n")}\n`;
}

// ---------------------------------------------------------------------------
// Setter
// ---------------------------------------------------------------------------

export interface SetOnePrScopeProofOptions {
  readonly level: string;
  readonly confirm?: boolean;
  readonly actor?: string;
  readonly note?: string;
}

export interface SetOnePrScopeProofResult {
  readonly exitCode: 0 | 1 | 2;
  readonly stdout: string;
  readonly changed: boolean;
}

function isSettableLevel(value: string): value is SettableOnePrScopeProofLevel {
  return (SETTABLE_ONE_PR_SCOPE_PROOF_LEVELS as readonly string[]).includes(value);
}

/**
 * Typed write path under the PROJECT-DEFINITION mutation lock (#6273).
 * Refuses `signed` (#5862). Requires --confirm. No-op when the value matches.
 */
export function setOnePrScopeProof(
  projectRoot: string,
  options: SetOnePrScopeProofOptions,
): SetOnePrScopeProofResult {
  if (options.level === "signed") {
    return { exitCode: 1, stdout: `✗ ${SIGNED_LEVEL_RESERVED_MESSAGE}\n`, changed: false };
  }
  if (!isSettableLevel(options.level)) {
    return {
      exitCode: 2,
      stdout: `✗ ${FIELD_ONE_PR_SCOPE_PROOF} must be one of ${SETTABLE_ONE_PR_SCOPE_PROOF_LEVELS.join("|")}\n`,
      changed: false,
    };
  }
  const level = options.level;
  if (options.confirm !== true) {
    return {
      exitCode: 1,
      stdout:
        "onePrScopeProof sets whether a same-PR human mint record may admit a new or widened brief.\n" +
        "  CI cannot verify the mint. With requireHumanMerge=true the human merge is the control;\n" +
        "  otherwise the control is the local mint gate and the write fence's protected-store\n" +
        "  deny on .deft/approved-scope/.\n" +
        "  Re-run with --confirm to apply.\n" +
        `  Inspect: ${policyColonInvocation("show", " --field=onePrScopeProof")}\n`,
      changed: false,
    };
  }

  try {
    const mutationResult = withProjectDefinitionMutation(projectRoot, (mutation) => {
      const data = mutation.load();
      if (typeof data.plan !== "object" || data.plan === null || Array.isArray(data.plan)) {
        if (data.plan === undefined) {
          data.plan = {};
        } else {
          return { changed: false, error: "PROJECT-DEFINITION 'plan' is not an object" };
        }
      }
      const plan = data.plan as Record<string, unknown>;
      const legacyKeyMigrated = migrateLegacyPolicyKey(plan);
      const existingPolicy = plan[PLAN_POLICY_KEY];
      if (asRecord(existingPolicy) === null) {
        if (existingPolicy === undefined) {
          plan[PLAN_POLICY_KEY] = {};
        } else {
          return { changed: false, error: "plan.policy is not an object" };
        }
      }
      const policyBlock = plan[PLAN_POLICY_KEY] as Record<string, unknown>;
      const previous = policyBlock.onePrScopeProof;
      const changedFlag = previous !== level || legacyKeyMigrated;
      policyBlock.onePrScopeProof = level;
      if (changedFlag) {
        mutation.persist(data);
      }
      const actor = options.actor ?? policyColonInvocation("set-one-pr-scope-proof");
      const note = options.note ?? "";
      const parts = [
        `actor=${actor}`,
        `onePrScopeProof=${level}`,
        `previous=${JSON.stringify(previous ?? null)}`,
      ];
      if (note) parts.push(`note=${note.replace(/\n/g, " ").replace(/\r/g, " ")}`);
      appendAuditLog(projectRoot, parts.join(" "), changedFlag);
      return { changed: changedFlag, error: null as string | null };
    });
    if (mutationResult.error !== null && mutationResult.error !== undefined) {
      return { exitCode: 2, stdout: `✗ Config error: ${mutationResult.error}\n`, changed: false };
    }
    const changed = mutationResult.changed;
    const lines = [
      `✓ ${FIELD_ONE_PR_SCOPE_PROOF} updated.`,
      changed ? "  audit: meta/policy-changes.log updated." : "  (no-op; value already matched)",
      `[deft policy] onePrScopeProof=${level}.`,
    ];
    if (level === "mint") {
      lines.push(
        "  The level is read from the merge base; the head brief file_scope must be " +
          "concrete (no globs). Without requireHumanMerge=true, CI verifies nothing human: " +
          "the control is the local mint gate and the write fence's protected-store deny " +
          "on .deft/approved-scope/.",
      );
    }
    return { exitCode: 0, stdout: `${lines.join("\n")}\n`, changed };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes("PROJECT-DEFINITION not found")) {
      return { exitCode: 2, stdout: `✗ ${message}\n`, changed: false };
    }
    return { exitCode: 2, stdout: `✗ Config error: ${message}\n`, changed: false };
  }
}
