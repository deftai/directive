#!/usr/bin/env node
/**
 * Authz CLI (#2944 Wave 1 + #1095 Wave 4 + #3110 + #3291): human-origin grants + UAT lease +
 * AFK closed-verb templates + structural scope:decompose apply grants
 * (mint via mintHumanOriginGrant / mintDecomposeStructuralApplyGrant only).
 *
 *   deft authz:show
 *   deft authz:uat-start -- --campaign <id> [--actor <name>] [--note <text>] [--confirm]
 *   deft authz:uat-suspend [--confirm]
 *   deft authz:grant -- --operations edit,push --surfaces 'src/**' --cohort <id> ... [--confirm]
 *   deft authz:grant -- --template release-publish --target 0.30.0 [--confirm]
 *   deft authz:grant -- --template finish-loop [--confirm]
 *   deft authz:grant -- --template spec-drift-override --target <baseline> --plan-ref <scopeId> --story-ids <ids> [--confirm]
 *   deft authz:grant -- --template delivery-identity-attest --target <owner>/<repo>#<pr>@<merge_commit_sha> \\
 *       --plan-ref <scopeId> [--confirm]
 *   deft authz:grant -- --template acceptance-disposition --plan-ref <scopeId> --story-ids <itemIds> \\
 *       [--disposition deferred|not_applicable|waived] [--deferred-to <issue>] --reason <text> [--confirm]
 *   deft authz:grant -- --template gate-override --target <refuseCode> --plan-ref <attemptId> \\
 *       --base-sha <sha> --head-sha <sha> --tree-hash <hash> [--confirm]
 *   deft authz:grant -- --parent <parent.xbrief.json> --draft <draft.json> [--repo owner/name] [--confirm]
 *   deft authz:revoke -- <grant-id> [--confirm]
 *
 * **UAT-active mint refuse (#3110 / #4632):** while any UAT lease is active,
 * `uat-start`, `grant`, and `revoke` refuse unconditionally — no TTY, `--confirm`,
 * or typed phrase path. `uat-suspend` skips that mint-refuse and still requires
 * multi-factor human presence (real operator console). Suspend reuses the typed
 * phrase `mint`; it is not a remint.
 *
 * **Outside UAT:** mutating verbs require multi-factor human presence: interactive
 * TTY + controlling terminal + `--confirm` + typed phrase `mint`. Under agent/CI
 * markers, inventoried kept-mint verbs open a harness-attended freeze and
 * complete only via controlling-TTY phrase or host-authenticated user-event
 * bound to that request (markers may stay set; bare chat-yes is request-open
 * only) (#7279). Argv `--confirm` alone is never enough.
 */
import { existsSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { onePrUnit } from "@deftai/directive-core";
import {
  AFK_TEMPLATE_NAMES,
  AUTHZ_OPERATIONS,
  type AuthzOperation,
  appendDelegationAudit,
  CLOSED_VERB_TEMPLATE_NAMES,
  DELEGATED_ACTION_CHAT_LINE_PREFIX,
  DELEGATED_TOTP_PROVENANCE,
  type DelegatedCompletion,
  DELEGATION_SCHEMA_VERSION,
  endDelegation,
  FINISH_LOOP_TEMPLATE_NAME,
  mintDelegatedReleaseGrant,
  resolveClosedVerbTemplate,
  resolveDelegationStoreRoot,
  formatDecomposeStructuralMintCommand,
  GATE_OVERRIDE_TEMPLATE_NAME,
  isAfkTemplateName,
  isClosedVerbTemplateName,
  isFinishLoopTemplateName,
  isGateOverrideTemplateName,
  mintAfkTemplateGrant,
  mintDecomposeStructuralApplyGrant,
  mintGateOverrideTemplateGrant,
  mintHumanOriginGrant,
  revokeGrant,
  showAuthzSnapshot,
  startUatLease,
  suspendUatLease,
  toProjectRelativePosix,
} from "@deftai/directive-core/authz";
import { uatCampaignEndSeal } from "@deftai/directive-core/authz/campaign-end-seal";
import {
  isPlanSequenceApprovalTemplateName,
  mintPlanSequenceApprovalGrant,
  PLAN_SEQUENCE_APPROVAL_TEMPLATE_NAME,
} from "@deftai/directive-core/plan-sequence";
import {
  ACCEPTANCE_DISPOSITION_TEMPLATE_NAME,
  ACCEPTANCE_DISPOSITION_VALUE_PREFIX,
  DELIVERY_IDENTITY_ATTEST_TEMPLATE_NAME,
  isAcceptanceDispositionTemplateName,
  isDeliveryIdentityAttestTemplateName,
  isSpecDriftOverrideTemplateName,
  listAcceptanceDispositionGrants,
  listDeliveryIdentityAttestGrants,
  mintAcceptanceDispositionTemplateGrant,
  mintDeliveryIdentityAttestTemplateGrant,
  mintSpecDriftOverrideTemplateGrant,
  resolveDeliveryIdentityAttestStore,
  SPEC_DRIFT_OVERRIDE_TEMPLATE_NAME,
} from "@deftai/directive-core/policy";
import {
  type HumanPresenceMintSeams,
  type MintOperatorStopContext,
  mintArgsAfterVerb,
  refuseMintWhileUatActive,
  refuseNonInteractiveMint,
  resolveHumanPresenceMintSeams,
} from "./human-presence-mint.js";

export type { HumanPresenceMintSeams as AuthzMainSeams } from "./human-presence-mint.js";
export {
  AUTHZ_AGENT_SHELL_ENV_MARKERS,
  AUTHZ_INTERACTIVE_CONFIRM_PHRASE,
  detectedAgentShellMarkers,
  looksLikeAgentShell,
} from "./human-presence-mint.js";

interface Parsed {
  cmd: "show" | "uat-start" | "uat-suspend" | "grant" | "revoke";
  projectRoot: string;
  campaign: string | null;
  actor: string;
  note: string | null;
  operations: AuthzOperation[];
  surfaces: string[];
  cohort: string | null;
  planRef: string | null;
  repo: string | null;
  branch: string | null;
  storyIds: string[];
  issueIds: number[];
  expiresAt: string | null;
  singleUse: boolean;
  grantId: string | null;
  template: string | null;
  target: string | null;
  /** Parent xBRIEF path for structural decompose apply mint (#3291). */
  parent: string | null;
  /** Draft path for structural decompose apply mint (#3291). */
  draft: string | null;
  /** Classifier binding for gate-override (#5542). */
  baseSha: string | null;
  headSha: string | null;
  treeHash: string | null;
  worktree: string | null;
  evaluatorId: string | null;
  format: "text" | "json";
  /** Explicit operator confirm for non-TTY / agent shells (#3110). */
  confirm: boolean;
  /** Complete a previously opened harness-attended request (#7279). */
  requestId: string | null;
  /** acceptance-disposition target issue (#6318). */
  deferredTo: string | null;
  /** acceptance-disposition reason (#6318). */
  reason: string | null;
  /** acceptance-disposition value: deferred (default), not_applicable, waived (#6644). */
  disposition: string | null;
  /** plan-sequence-approval: the plan's generation (#6205). */
  generation: number | null;
  /** plan-sequence-approval insert: entry index (#6205). */
  position: number | null;
  /** plan-sequence-approval insert: entry title, bound to the grant (#6205). */
  title: string | null;
  error?: string;
}

/** Non-negative integer flag value, or null when malformed. */
function parseIndexFlag(raw: string | undefined): number | null {
  if (raw === undefined || !/^(0|[1-9]\d*)$/.test(raw.trim())) return null;
  return Number(raw.trim());
}

function parseOps(raw: string): AuthzOperation[] {
  const allowed = new Set<string>(AUTHZ_OPERATIONS);
  const out: AuthzOperation[] = [];
  for (const part of raw.split(/[,\s]+/)) {
    const op = part.trim().toLowerCase();
    if (op.length === 0) continue;
    if (!allowed.has(op)) {
      throw new Error(`unknown operation '${op}'; expected one of ${AUTHZ_OPERATIONS.join(", ")}`);
    }
    out.push(op as AuthzOperation);
  }
  return out;
}

function parseArgv(argv: string[]): Parsed {
  const base: Parsed = {
    cmd: "show",
    projectRoot: process.cwd(),
    campaign: null,
    actor: "operator",
    note: null,
    operations: [],
    surfaces: [],
    cohort: null,
    planRef: null,
    repo: null,
    branch: null,
    storyIds: [],
    issueIds: [],
    expiresAt: null,
    singleUse: false,
    grantId: null,
    template: null,
    target: null,
    parent: null,
    draft: null,
    baseSha: null,
    headSha: null,
    treeHash: null,
    worktree: null,
    evaluatorId: null,
    format: "text",
    confirm: false,
    requestId: null,
    deferredTo: null,
    reason: null,
    disposition: null,
    generation: null,
    position: null,
    title: null,
  };

  const args = [...argv];
  // Drop leading `--` separators from task-style invocation.
  while (args[0] === "--") args.shift();

  if (args.length > 0 && !args[0]?.startsWith("-")) {
    const cmd = args.shift() as string;
    if (
      cmd === "show" ||
      cmd === "uat-start" ||
      cmd === "uat-suspend" ||
      cmd === "grant" ||
      cmd === "revoke"
    ) {
      base.cmd = cmd;
    } else if (cmd.startsWith("grant-")) {
      base.cmd = "revoke";
      base.grantId = cmd;
    } else {
      return { ...base, error: `unknown authz subcommand: ${cmd}` };
    }
  }

  while (args[0] === "--") args.shift();

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === undefined) break;
    if (a === "--project-root" || a === "--projectRoot") {
      base.projectRoot = args[++i] ?? base.projectRoot;
      continue;
    }
    if (a === "--campaign") {
      base.campaign = args[++i] ?? null;
      continue;
    }
    if (a === "--actor") {
      base.actor = args[++i] ?? base.actor;
      continue;
    }
    if (a === "--note") {
      base.note = args[++i] ?? null;
      continue;
    }
    if (a === "--operations" || a === "--ops") {
      try {
        base.operations = parseOps(args[++i] ?? "");
      } catch (err) {
        return { ...base, error: String(err) };
      }
      continue;
    }
    if (a === "--surfaces") {
      const raw = args[++i] ?? "";
      base.surfaces = raw
        .split(/[,\s]+/)
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
      continue;
    }
    if (a === "--cohort") {
      base.cohort = args[++i] ?? null;
      continue;
    }
    if (a === "--plan-ref" || a === "--planRef") {
      base.planRef = args[++i] ?? null;
      continue;
    }
    if (a === "--repo") {
      base.repo = args[++i] ?? null;
      continue;
    }
    if (a === "--branch") {
      base.branch = args[++i] ?? null;
      continue;
    }
    if (a === "--stories" || a === "--story-ids") {
      const raw = args[++i] ?? "";
      base.storyIds = raw
        .split(/[,\s]+/)
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
      continue;
    }
    if (a === "--issues" || a === "--issue-ids") {
      const raw = args[++i] ?? "";
      base.issueIds = raw
        .split(/[,\s]+/)
        .map((s) => Number(s.trim()))
        .filter((n) => Number.isFinite(n));
      continue;
    }
    if (a === "--expires" || a === "--expires-at") {
      base.expiresAt = args[++i] ?? null;
      continue;
    }
    if (a === "--single-use") {
      base.singleUse = true;
      continue;
    }
    if (a === "--format") {
      const fmt = (args[++i] ?? "text").toLowerCase();
      base.format = fmt === "json" ? "json" : "text";
      continue;
    }
    if (a === "--grant-id") {
      base.grantId = args[++i] ?? null;
      continue;
    }
    if (a === "--template") {
      base.template = args[++i] ?? null;
      continue;
    }
    if (a === "--target") {
      base.target = args[++i] ?? null;
      continue;
    }
    if (a === "--parent") {
      base.parent = args[++i] ?? null;
      continue;
    }
    if (a === "--draft") {
      base.draft = args[++i] ?? null;
      continue;
    }
    if (a === "--base-sha" || a === "--baseSha") {
      base.baseSha = args[++i] ?? null;
      continue;
    }
    if (a === "--head-sha" || a === "--headSha") {
      base.headSha = args[++i] ?? null;
      continue;
    }
    if (a === "--tree-hash" || a === "--treeHash") {
      base.treeHash = args[++i] ?? null;
      continue;
    }
    if (a === "--worktree") {
      base.worktree = args[++i] ?? null;
      continue;
    }
    if (a === "--evaluator-id" || a === "--evaluatorId") {
      base.evaluatorId = args[++i] ?? null;
      continue;
    }
    if (a === "--confirm") {
      base.confirm = true;
      continue;
    }
    if (a === "--request-id" || a === "--requestId") {
      base.requestId = args[++i] ?? null;
      continue;
    }
    if (a.startsWith("--request-id=")) {
      base.requestId = a.slice("--request-id=".length) || null;
      continue;
    }
    if (a.startsWith("--requestId=")) {
      base.requestId = a.slice("--requestId=".length) || null;
      continue;
    }
    if (a === "--deferred-to" || a === "--deferredTo") {
      base.deferredTo = args[++i] ?? null;
      continue;
    }
    if (a === "--disposition") {
      base.disposition = args[++i] ?? null;
      continue;
    }
    if (a === "--reason") {
      base.reason = args[++i] ?? null;
      continue;
    }
    if (a === "--title") {
      base.title = args[++i] ?? null;
      continue;
    }
    if (a === "--generation" || a === "--position") {
      const value = parseIndexFlag(args[++i]);
      if (value === null) {
        return { ...base, error: `${a} requires a non-negative integer` };
      }
      if (a === "--generation") base.generation = value;
      else base.position = value;
      continue;
    }
    if (!a.startsWith("-") && base.cmd === "revoke" && base.grantId === null) {
      base.grantId = a;
      continue;
    }
    if (a === "--help" || a === "-h") {
      return { ...base, error: "help" };
    }
  }
  return base;
}

function helpText(): string {
  return [
    "Usage:",
    "  deft authz:show [--format json]",
    "  deft authz:uat-start -- --campaign <id> [--actor <name>] [--note <text>] [--confirm]",
    "  deft authz:uat-suspend [--confirm]",
    "  deft authz:grant -- --operations edit,push --surfaces 'src/**' --cohort <id> \\",
    "      [--stories 2944] [--plan-ref <id>] [--repo owner/name] [--branch <b>] [--expires ISO] [--confirm]",
    "  deft authz:grant -- --template release-publish --target 0.30.0 [--actor <name>] [--expires ISO] [--confirm]",
    "  deft authz:grant -- --template finish-loop [--actor <name>] [--expires ISO] [--confirm]",
    "  deft authz:grant -- --template delivery-identity-attest \\",
    "      --target <owner>/<repo>#<pr>@<merge_commit_sha> --plan-ref <scopeId> [--confirm]",
    "  deft authz:grant -- --template acceptance-disposition --plan-ref <scopeId> \\",
    "      --story-ids <itemIds> [--disposition deferred|not_applicable|waived] \\",
    "      [--deferred-to <issue>] --reason <text> [--confirm]",
    "  deft authz:grant -- --template plan-sequence-approval --target <insert:<kind>:<id>|replace|clear> \\",
    "      --plan-ref <sequence_id> --generation <n> [--position <n>] [--issue-ids <n>] [--title <t>] [--repo owner/name] [--confirm]",
    "  deft authz:grant -- --parent <parent.xbrief.json> --draft <draft.json> \\",
    "      [--repo owner/name] [--expires ISO] [--single-use] [--actor <name>] [--confirm]",
    "  deft authz:revoke -- <grant-id> [--confirm]",
    "",
    "Human-origin grants are minted only via this CLI (origin.kind=operator-cli).",
    "Self-authored xBRIEF/lifecycle/dispatch tokens never satisfy implement gates (#2944).",
    "While any UAT lease is ACTIVE (#3110 / #4632): grant / uat-start / revoke refuse",
    "  unconditionally — no TTY, --confirm, or phrase path. Self-approval remint under",
    "  UAT is impossible by construction. Mint grants BEFORE uat-start.",
    "  uat-suspend is reachable from a real operator console: listed agent/CI markers",
    "  empty, stdin+stdout TTY, controlling terminal, --confirm, typed phrase 'mint'",
    "  (suspend reuses the mint phrase; it is not a remint). Agent/CI and missing-factor",
    "  seams still refuse (exit 2). After suspend, grant is available again through",
    "  the same human-presence gate.",
    "Outside UAT, mutating verbs require multi-factor human presence (#3110):",
    "  - Interactive TTY (stdin+stdout) + controlling terminal (/dev/tty|\\\\.\\CONIN$)",
    "  - Explicit --confirm (argv flag alone never enough)",
    "  - Typed phrase 'mint' on the controlling TTY (PTY+--confirm alone never enough)",
    "  - Known agent/CI env markers always refuse (fail-closed).",
    "",
    "Structural scope:decompose apply (#3239 / #3291):",
    "  Pass --parent + --draft (paths under project root). Digest is SHA-256 of exact",
    "  draft bytes; binds parent, target, worktree, and optional --repo. Mints only",
    "  scope.decompose.apply.structural via mintDecomposeStructuralApplyGrant.",
    "  Example (after --check validates the draft):",
    "    deft authz:grant -- --parent xbrief/pending/epic.xbrief.json \\",
    "        --draft xbrief/.triage-cache/decompositions/draft.json --confirm",
    "  Then: deft scope:decompose -- <parent> --draft <draft>",
    "  scope:decompose --check remains ungated (no structural grant required).",
    "",
    `AFK templates (#1095 / #871): ${AFK_TEMPLATE_NAMES.join(", ")}`,
    `  Closed-verb (#1095): ${CLOSED_VERB_TEMPLATE_NAMES.join(", ")} — require --target`,
    `  Finish-loop (#871): ${FINISH_LOOP_TEMPLATE_NAME} — edit/push/pr/merge (no release ops)`,
    "  Templates call mintHumanOriginGrant only — no second session-auth mint engine.",
    "  Env bypass for a single shell: DEFT_ALLOW_RELEASE_PUBLISH=1 / DEFT_ALLOW_FINISH_LOOP=1.",
    "",
    `Gate-override (#5542): ${GATE_OVERRIDE_TEMPLATE_NAME}`,
    "  deft authz:grant -- --template gate-override --target <refuseCode> --plan-ref <attemptId> \\",
    "      --base-sha <sha> --head-sha <sha> --tree-hash <hash> [--worktree <id>] [--evaluator-id <id>] [--confirm]",
    "  operator-cli human-presence only; waived ≠ passed; no independent push/merge.",
  ].join("\n");
}

export function main(
  argv: string[] = process.argv.slice(2),
  seams: HumanPresenceMintSeams = {},
): number {
  const args = parseArgv(argv);
  if (args.error === "help") {
    process.stdout.write(`${helpText()}\n`);
    return 0;
  }
  if (args.error !== undefined) {
    process.stderr.write(`authz: ${args.error}\n`);
    process.stderr.write(`${helpText()}\n`);
    return 2;
  }

  const resolved = resolveHumanPresenceMintSeams(seams);
  /**
   * Mutating-verb gate stack (#3110 / #4632):
   * 1. Active UAT mint-refuse for grant / uat-start / revoke (no multi-factor escape)
   * 2. uat-suspend skips that mint-refuse so campaign-end stays reachable
   * 3. Multi-factor human presence: TTY + controlling tty + --confirm + typed phrase;
   *    agent/CI markers refuse. Suspend reuses phrase `mint`.
   * Required-arg validation runs before this so missing --campaign / --ops still report clearly.
   */
  /**
   * Set when the harness-attended request completed with provenance
   * `delegated-totp` (#7420). Only the release-template branch passes
   * `delegable`; every other branch never sees a delegated completion.
   */
  const delegated: { completion: DelegatedCompletion | null } = { completion: null };
  const gateConfirm = (delegable?: { readonly template: string | null }): number | null => {
    if (args.cmd === "show") return null;
    if (args.cmd !== "uat-suspend") {
      const uatBlocked = refuseMintWhileUatActive(`authz:${args.cmd}`, args.projectRoot);
      if (uatBlocked !== null) return uatBlocked;
    }
    const projectRoot = resolve(args.projectRoot);
    const operatorStop: MintOperatorStopContext = {
      projectRoot,
      args: mintArgsAfterVerb(argv, args.cmd),
      record: resolved.recordOperatorStop,
    };
    // Inventoried authz kept-mint mutators: harness-attended freeze+confirm (#7279).
    // Destination is the local authz store root (one-pr-unit still binds checkout).
    const mintBlocked = refuseNonInteractiveMint({
      verb: `authz:${args.cmd}`,
      confirm: args.confirm,
      isTty: resolved.isTty,
      environ: resolved.environ,
      hasControllingTerminal: resolved.hasControllingTerminal,
      readInteractiveConfirm: resolved.readInteractiveConfirm,
      readHostAuthenticatedConfirm: resolved.readHostAuthenticatedConfirm,
      readDelegatedConfirm: resolved.readDelegatedConfirm,
      operatorStop,
      harnessAttended: {
        destinations: [join(projectRoot, ".deft", "authz")],
        ...(args.requestId !== null && args.requestId.trim().length > 0
          ? { requestId: args.requestId.trim() }
          : {}),
        ...(delegable !== undefined
          ? {
              delegation: { template: delegable.template },
              onDelegatedCompletion: (c: DelegatedCompletion) => {
                delegated.completion = c;
              },
            }
          : {}),
      },
    });
    if (mintBlocked !== null) return mintBlocked;
    // Fresh admission recheck at confirm time; suspend keeps its exception (#7279).
    if (args.cmd !== "uat-suspend") {
      const uatRecheck = refuseMintWhileUatActive(`authz:${args.cmd}`, args.projectRoot);
      if (uatRecheck !== null) return uatRecheck;
    }
    return null;
  };

  try {
    switch (args.cmd) {
      case "show": {
        const snap = showAuthzSnapshot(args.projectRoot);
        if (args.format === "json") {
          // #6317: delivery-identity-attest grants live in the main clone store.
          const attest = listDeliveryIdentityAttestGrants(args.projectRoot);
          const deliveryIdentityAttest = attest.ok
            ? { storeRoot: attest.root, grants: attest.grants }
            : { storeRoot: null, error: attest.reason, grants: [] };
          // #6318: acceptance-disposition grants share that store.
          const deferrals = listAcceptanceDispositionGrants(args.projectRoot);
          const acceptanceDisposition = deferrals.ok
            ? { storeRoot: deferrals.root, grants: deferrals.grants }
            : { storeRoot: null, error: deferrals.reason, grants: [] };
          process.stdout.write(
            `${JSON.stringify({ ...snap, deliveryIdentityAttest, acceptanceDisposition }, null, 2)}\n`,
          );
          return 0;
        }
        const uat = snap.state.uat;
        if (uat === null) {
          process.stdout.write("UAT lease: inactive\n");
        } else {
          process.stdout.write(
            `UAT lease: ${uat.active ? "ACTIVE" : "suspended"} campaign=${uat.campaignId}\n`,
          );
          process.stdout.write(
            `  started=${uat.startedAt} by=${uat.startedBy.actor} (${uat.startedBy.kind})\n`,
          );
          if (uat.suspendedAt) process.stdout.write(`  suspended=${uat.suspendedAt}\n`);
        }
        process.stdout.write(`Active human-origin grants: ${snap.activeGrants.length}\n`);
        for (const g of snap.activeGrants) {
          process.stdout.write(
            `  - ${g.id} ops=[${g.scope.operations.join(",")}] ` +
              `cohort=${g.scope.cohortId ?? "-"} surfaces=${g.scope.surfaces.join("|") || "*"}\n`,
          );
        }
        const rejected = snap.allGrants.length - snap.activeGrants.length;
        if (rejected > 0) {
          process.stdout.write(`(${rejected} grant file(s) present but not active/human-origin)\n`);
        }
        writeDeliveryIdentityAttestShow(args.projectRoot);
        writeAcceptanceDispositionShow(args.projectRoot);
        return 0;
      }
      case "uat-start": {
        if (args.campaign === null || args.campaign.trim().length === 0) {
          process.stderr.write("authz:uat-start requires --campaign <id>\n");
          return 2;
        }
        const blocked = gateConfirm();
        if (blocked !== null) return blocked;
        // Result narrowing; pinActive mint wiring stays parked (class 4).
        const started = startUatLease({
          projectRoot: args.projectRoot,
          campaignId: args.campaign,
          actor: args.actor,
          note: args.note,
        });
        if (!started.ok) {
          process.stderr.write(`authz:uat-start: ${started.reason}\n`);
          return 2;
        }
        process.stdout.write(
          `✓ UAT lease ACTIVE campaign=${started.lease.campaignId} (human-origin operator-cli)\n`,
        );
        process.stdout.write(
          "  Product edit/push/PR/merge denied until a named fix cohort grant is minted.\n",
        );
        process.stdout.write("  Tests, evidence capture, and issue filing remain allowed.\n");
        return 0;
      }
      case "uat-suspend": {
        const blocked = gateConfirm();
        if (blocked !== null) return blocked;
        // Sealed campaign-end only after CLI human-presence gateConfirm (#4233).
        // pinActive mint wiring stays parked (class 4 follow-up).
        const suspended = suspendUatLease({
          projectRoot: args.projectRoot,
          actor: args.actor,
          campaignEndSeal: uatCampaignEndSeal(),
        });
        if (!suspended.ok) {
          process.stderr.write(`authz:uat-suspend: ${suspended.reason}\n`);
          return 2;
        }
        const state = suspended.state;
        if (state.uat === null) {
          process.stdout.write("UAT lease was already inactive.\n");
        } else {
          process.stdout.write(
            `✓ UAT lease suspended campaign=${state.uat.campaignId} at ${state.uat.suspendedAt}\n`,
          );
        }
        return 0;
      }
      case "grant": {
        // Structural decompose apply path (#3291): --parent + --draft → mintDecomposeStructuralApplyGrant.
        const parentRaw = args.parent?.trim() ?? "";
        const draftRaw = args.draft?.trim() ?? "";
        const hasParent = parentRaw.length > 0;
        const hasDraft = draftRaw.length > 0;
        if (hasParent !== hasDraft) {
          process.stderr.write(
            "authz:grant structural mint requires both --parent <path> and --draft <path>\n" +
              `  Example: ${formatDecomposeStructuralMintCommand(
                hasParent ? parentRaw : "xbrief/pending/parent.xbrief.json",
                hasDraft ? draftRaw : "xbrief/.triage-cache/decompositions/draft.json",
                { repo: args.repo },
              )}\n`,
          );
          return 2;
        }
        if (hasParent && hasDraft) {
          if (args.template !== null && args.template.trim().length > 0) {
            process.stderr.write(
              "authz:grant: --parent/--draft structural mint cannot be combined with --template\n",
            );
            return 2;
          }
          if (args.operations.length > 0) {
            process.stderr.write(
              "authz:grant: --parent/--draft structural mint cannot be combined with --operations " +
                "(operation is fixed to scope.decompose.apply.structural)\n",
            );
            return 2;
          }
          const root = resolve(args.projectRoot);
          const parentAbs = isAbsolute(parentRaw) ? resolve(parentRaw) : resolve(root, parentRaw);
          const draftAbs = isAbsolute(draftRaw) ? resolve(draftRaw) : resolve(root, draftRaw);
          const parentRel = toProjectRelativePosix(root, parentAbs);
          const draftRel = toProjectRelativePosix(root, draftAbs);
          if (parentRel === null) {
            process.stderr.write(
              `authz:grant: --parent path is outside project root: ${parentRaw}\n`,
            );
            return 2;
          }
          if (draftRel === null) {
            process.stderr.write(
              `authz:grant: --draft path is outside project root: ${draftRaw}\n`,
            );
            return 2;
          }
          if (!existsSync(parentAbs)) {
            process.stderr.write(`authz:grant: --parent path does not exist: ${parentRaw}\n`);
            return 2;
          }
          if (!existsSync(draftAbs)) {
            process.stderr.write(`authz:grant: --draft path does not exist: ${draftRaw}\n`);
            return 2;
          }
          const blocked = gateConfirm();
          if (blocked !== null) return blocked;
          const minted = mintDecomposeStructuralApplyGrant({
            projectRoot: root,
            parentPath: parentAbs,
            draftPath: draftAbs,
            actor: args.actor,
            repo: args.repo,
            expiresAt: args.expiresAt,
            singleUse: args.singleUse,
          });
          if (!minted.ok) {
            process.stderr.write(`authz:grant: ${minted.reason}\n`);
            return 2;
          }
          const grant = minted.grant;
          // mintDecomposeStructuralApplyGrant always sets contentDigest + worktree.
          const digest = grant.scope.contentDigest || "";
          process.stdout.write(
            `✓ human-origin structural grant minted id=${grant.id} origin=${grant.origin.kind}\n`,
          );
          process.stdout.write(
            `  ops=[${grant.scope.operations.join(",")}] digest=${digest.slice(0, 12)}…\n`,
          );
          process.stdout.write(`  parent=${parentRel} draft=${draftRel}\n`);
          if (grant.scope.repo) {
            process.stdout.write(`  repo=${grant.scope.repo}\n`);
          }
          process.stdout.write(`  worktree=${grant.scope.worktree || root}\n`);
          if (grant.semantics.singleUse) {
            process.stdout.write("  single-use=true (spent on first successful apply)\n");
          }
          process.stdout.write(
            "  Apply: deft scope:decompose -- <parent> --draft <draft>\n" +
              "  Authorization SoT: Wave 1 grant store (.deft/authz/grants) — not session-auth.\n",
          );
          return 0;
        }
        if (args.template !== null && args.template.trim().toLowerCase() === "one-pr-unit") {
          if (args.repo === null || args.repo.trim().length === 0) {
            process.stderr.write("authz:grant --template one-pr-unit requires --repo owner/name\n");
            return 2;
          }
          if (args.issueIds.length < 2) {
            process.stderr.write(
              "authz:grant --template one-pr-unit requires --issue-ids with at least two origins\n",
            );
            return 2;
          }
          const blocked = gateConfirm();
          if (blocked !== null) return blocked;
          if ((process.env.DEFT_ONE_PR_UNIT_APP ?? "").trim().length === 0) {
            process.stderr.write(
              "authz:grant --template one-pr-unit requires DEFT_ONE_PR_UNIT_APP (durable Directive App store). " +
                "The in-process simulator is test-only and is discarded on process exit.\n",
            );
            return 2;
          }
          const resolved = onePrUnit.resolveProductionAppStore(process.env);
          if (!resolved.ok) {
            process.stderr.write(`${resolved.message}\n`);
            return 2;
          }
          const claim = onePrUnit.mintOnePrUnitGrant({
            actor: args.actor,
            approvalRef: args.note ?? "authz:grant --template one-pr-unit",
            rationale: args.note ?? "one-PR-unit",
            origins: args.issueIds.map((issueId) => ({ repo: args.repo as string, issueId })),
            repo: args.repo,
            store: resolved.store,
          });
          process.stdout.write(
            `✓ one-PR-unit claim minted id=${claim.id} state=${claim.state} (reserved unbound)\n`,
          );
          process.stdout.write(
            "  Opaque id is not a bearer. Only the App store plus the bound PR node id authorizes.\n",
          );
          process.stdout.write(
            `  origins=${claim.origins.map((o: { repo: string; issueId: number }) => `${o.repo}#${o.issueId}`).join(",")}\n`,
          );
          return 0;
        }
        // Gate-override hatch (#5542 Prefer-A Bound): coverage-applicability refuse waiver.
        if (args.template !== null && isGateOverrideTemplateName(args.template)) {
          if (args.target === null || args.target.trim().length === 0) {
            process.stderr.write(
              "authz:grant --template gate-override requires --target <refuseCode>\n",
            );
            return 2;
          }
          if (args.planRef === null || args.planRef.trim().length === 0) {
            process.stderr.write(
              "authz:grant --template gate-override requires --plan-ref <attemptId>\n",
            );
            return 2;
          }
          if (
            args.baseSha === null ||
            args.baseSha.trim().length === 0 ||
            args.headSha === null ||
            args.headSha.trim().length === 0 ||
            args.treeHash === null ||
            args.treeHash.trim().length === 0
          ) {
            process.stderr.write(
              "authz:grant --template gate-override requires --base-sha --head-sha --tree-hash\n",
            );
            return 2;
          }
          const blockedGate = gateConfirm();
          if (blockedGate !== null) return blockedGate;
          const mintedGate = mintGateOverrideTemplateGrant({
            projectRoot: args.projectRoot,
            target: args.target,
            planRef: args.planRef,
            baseSha: args.baseSha,
            headSha: args.headSha,
            treeHash: args.treeHash,
            actor: args.actor,
            expiresAt: args.expiresAt,
            // gate-override template is always single-use (#5542 Greptile P2).
            singleUse: true,
            repo: args.repo,
            branch: args.branch,
            worktree: args.worktree,
            evaluatorId: args.evaluatorId,
            failedGateEvidence: args.note,
          });
          if (!mintedGate.ok) {
            process.stderr.write(`authz:grant: ${mintedGate.reason}\n`);
            return 2;
          }
          const gateGrant = mintedGate.grant;
          process.stdout.write(
            `✓ human-origin grant minted id=${gateGrant.id} origin=${gateGrant.origin.kind} ` +
              `template=${GATE_OVERRIDE_TEMPLATE_NAME}\n`,
          );
          process.stdout.write(
            `  ops=[${gateGrant.scope.operations.join(",")}] attempt=${gateGrant.scope.planRef} ` +
              `surfaces=${gateGrant.scope.surfaces.join(", ")}\n`,
          );
          process.stdout.write(
            "  Hatch: waives coverage-applicability refuse for bound attempt/tree only; " +
              "waived ≠ passed; reviewObligation=pre-merge-human-review-required.\n",
          );
          process.stdout.write(
            "  Authorization SoT: Wave 1 grant store (.deft/authz/grants) — not session-auth / chat.\n",
          );
          return 0;
        }
        // Acceptance-disposition deferral (#6318): policy module, main clone store.
        if (args.template !== null && isAcceptanceDispositionTemplateName(args.template)) {
          return grantAcceptanceDisposition(args, gateConfirm);
        }
        // Ordered-plan write approval (#6205): plan-sequence module, main clone store.
        if (args.template !== null && isPlanSequenceApprovalTemplateName(args.template)) {
          return grantPlanSequenceApproval(args, gateConfirm);
        }
        // Delivery-identity attestation (#6317): policy module, main clone store.
        if (args.template !== null && isDeliveryIdentityAttestTemplateName(args.template)) {
          if (args.target === null || args.target.trim().length === 0) {
            process.stderr.write(
              "authz:grant --template delivery-identity-attest requires --target <owner>/<repo>#<pr>@<merge_commit_sha>\n",
            );
            return 2;
          }
          if (args.planRef === null || args.planRef.trim().length === 0) {
            process.stderr.write(
              "authz:grant --template delivery-identity-attest requires --plan-ref <scopeId>\n",
            );
            return 2;
          }
          const blockedAttest = gateConfirm();
          if (blockedAttest !== null) return blockedAttest;
          const mintedAttest = mintDeliveryIdentityAttestTemplateGrant({
            projectRoot: args.projectRoot,
            target: args.target,
            planRef: args.planRef,
            actor: args.actor,
            expiresAt: args.expiresAt,
            branch: args.branch,
          });
          if (!mintedAttest.ok) {
            process.stderr.write(`authz:grant: ${mintedAttest.reason}\n`);
            return 2;
          }
          const attestGrant = mintedAttest.grant;
          process.stdout.write(
            `✓ human-origin grant minted id=${attestGrant.id} origin=${attestGrant.origin.kind} ` +
              `template=${DELIVERY_IDENTITY_ATTEST_TEMPLATE_NAME}\n`,
          );
          process.stdout.write(
            `  plan=${attestGrant.scope.planRef} surfaces=${attestGrant.scope.surfaces.join(", ")} ` +
              `expires=${attestGrant.semantics.expiresAt ?? "-"}\n`,
          );
          process.stdout.write(
            "  Basis: operator-attested for this PR, merge commit and plan only; first use is " +
              "recorded when the completed/ write succeeds.\n",
          );
          process.stdout.write(
            `  Store: ${mintedAttest.storeRoot} (main clone, .deft/authz/grants)\n`,
          );
          return 0;
        }
        // Spec-drift override hatch (#5350): policy module, not authz/** (class 4).
        if (args.template !== null && isSpecDriftOverrideTemplateName(args.template)) {
          if (args.target === null || args.target.trim().length === 0) {
            process.stderr.write(
              "authz:grant --template spec-drift-override requires --target <baselineRevision>\n",
            );
            return 2;
          }
          if (args.planRef === null || args.planRef.trim().length === 0) {
            process.stderr.write(
              "authz:grant --template spec-drift-override requires --plan-ref <scopeId>\n",
            );
            return 2;
          }
          if (args.storyIds.length === 0) {
            process.stderr.write(
              "authz:grant --template spec-drift-override requires --story-ids <covered-item-ids>\n",
            );
            return 2;
          }
          const blockedOverride = gateConfirm();
          if (blockedOverride !== null) return blockedOverride;
          const mintedOverride = mintSpecDriftOverrideTemplateGrant({
            projectRoot: args.projectRoot,
            target: args.target,
            planRef: args.planRef,
            storyIds: args.storyIds,
            actor: args.actor,
            expiresAt: args.expiresAt,
            singleUse: args.singleUse,
            repo: args.repo,
            branch: args.branch,
          });
          if (!mintedOverride.ok) {
            process.stderr.write(`authz:grant: ${mintedOverride.reason}\n`);
            return 2;
          }
          const overrideGrant = mintedOverride.grant;
          process.stdout.write(
            `✓ human-origin grant minted id=${overrideGrant.id} origin=${overrideGrant.origin.kind} ` +
              `template=${SPEC_DRIFT_OVERRIDE_TEMPLATE_NAME}\n`,
          );
          process.stdout.write(
            `  ops=[${overrideGrant.scope.operations.join(",")}] scope=${overrideGrant.scope.planRef} ` +
              `items=${overrideGrant.scope.storyIds.join(",")} surfaces=${overrideGrant.scope.surfaces.join(", ")}\n`,
          );
          process.stdout.write(
            "  Hatch: discharges rewrite/coverage refuse for bound ids only under enforce; single-use preferred.\n",
          );
          process.stdout.write(
            "  Authorization SoT: Wave 1 grant store (.deft/authz/grants) — not session-auth.\n",
          );
          return 0;
        }
        // AFK template path (#1095 / #871): presets only — still mintHumanOriginGrant.
        if (args.template !== null && args.template.trim().length > 0) {
          if (!isAfkTemplateName(args.template)) {
            process.stderr.write(
              `authz:grant unknown --template '${args.template}'; expected one of: ${AFK_TEMPLATE_NAMES.join(", ")}, ${SPEC_DRIFT_OVERRIDE_TEMPLATE_NAME}, ${GATE_OVERRIDE_TEMPLATE_NAME}, ${DELIVERY_IDENTITY_ATTEST_TEMPLATE_NAME}, ${ACCEPTANCE_DISPOSITION_TEMPLATE_NAME}, ${PLAN_SEQUENCE_APPROVAL_TEMPLATE_NAME}\n`,
            );
            return 2;
          }
          if (
            isClosedVerbTemplateName(args.template) &&
            (args.target === null || args.target.trim().length === 0)
          ) {
            process.stderr.write(
              `authz:grant --template ${args.template} requires --target <version>\n`,
            );
            return 2;
          }
          const blocked = gateConfirm({ template: args.template });
          if (blocked !== null) return blocked;
          if (delegated.completion !== null) {
            return mintDelegatedTemplateGrant(args, delegated.completion);
          }
          const minted = mintAfkTemplateGrant({
            projectRoot: args.projectRoot,
            template: args.template,
            target: args.target,
            actor: args.actor,
            expiresAt: args.expiresAt,
            singleUse: args.singleUse,
            planRef: args.planRef,
            repo: args.repo,
            branch: args.branch,
            surfaces: args.surfaces,
            storyIds: args.storyIds,
            issueIds: args.issueIds,
            cohortId: args.cohort,
          });
          if (!minted.ok) {
            process.stderr.write(`authz:grant: ${minted.reason}\n`);
            return 2;
          }
          const grant = minted.grant;
          process.stdout.write(
            `✓ human-origin grant minted id=${grant.id} origin=${grant.origin.kind} ` +
              `template=${args.template}\n`,
          );
          if (isFinishLoopTemplateName(args.template)) {
            process.stdout.write(
              `  ops=[${grant.scope.operations.join(",")}] ` +
                `(finish-loop walk-away; release-* NOT authorized)\n`,
            );
          } else {
            process.stdout.write(
              `  ops=[${grant.scope.operations.join(",")}] target surfaces=${grant.scope.surfaces.join(", ")}\n`,
            );
          }
          process.stdout.write(
            "  Authorization SoT: Wave 1 grant store (.deft/authz/grants) — not session-auth.\n",
          );
          return 0;
        }
        if (args.operations.length === 0) {
          process.stderr.write(
            "authz:grant requires --operations <edit,push,...>, --template <finish-loop|release-*|spec-drift-override|gate-override|delivery-identity-attest|acceptance-disposition|plan-sequence-approval>, " +
              "or --parent + --draft (structural scope:decompose apply)\n",
          );
          return 2;
        }
        {
          // Raw operations are never delegable (#7420 B7): asking proves the
          // allowlist refuses, and the human-presence path stays the only way.
          const blocked = gateConfirm({ template: null });
          if (blocked !== null) return blocked;
          if (delegated.completion !== null) {
            process.stderr.write("authz:grant: raw-ops grants are never delegable (#7420).\n");
            return 2;
          }
        }
        const minted = mintHumanOriginGrant({
          projectRoot: args.projectRoot,
          actor: args.actor,
          operations: args.operations,
          surfaces: args.surfaces,
          cohortId: args.cohort,
          planRef: args.planRef,
          repo: args.repo,
          branch: args.branch,
          storyIds: args.storyIds,
          issueIds: args.issueIds,
          expiresAt: args.expiresAt,
          singleUse: args.singleUse,
        });
        if (!minted.ok) {
          process.stderr.write(`authz:grant: ${minted.reason}\n`);
          return 2;
        }
        const grant = minted.grant;
        process.stdout.write(
          `✓ human-origin grant minted id=${grant.id} origin=${grant.origin.kind}\n`,
        );
        process.stdout.write(
          `  ops=[${grant.scope.operations.join(",")}] cohort=${grant.scope.cohortId ?? "-"}\n`,
        );
        if (grant.scope.surfaces.length > 0) {
          process.stdout.write(`  surfaces=${grant.scope.surfaces.join(", ")}\n`);
        }
        return 0;
      }
      case "revoke": {
        if (args.grantId === null) {
          process.stderr.write("authz:revoke requires <grant-id>\n");
          return 2;
        }
        {
          const blocked = gateConfirm();
          if (blocked !== null) return blocked;
        }
        // A terminal authz:revoke ends any live delegation (#7420 B2). revoke is
        // never delegable, so reaching here means the human-presence gate passed.
        const ended = endDelegation(resolve(args.projectRoot), "authz-revoke");
        if (ended.ok && ended.ended) {
          process.stdout.write(
            `✓ delegation ${ended.record?.delegationId ?? ""} ended (terminal authz:revoke)\n`,
          );
        }
        let revokedResult = revokeGrant({
          projectRoot: args.projectRoot,
          grantId: args.grantId,
        });
        // #6317 / #6318: a grant absent here may live in the main clone store
        // (delivery-identity-attest, acceptance-disposition), so revoke from a
        // linked dest finds it.
        if (revokedResult.ok && revokedResult.grant === null) {
          const mainStore = resolveDeliveryIdentityAttestStore(args.projectRoot);
          if (mainStore.ok && resolve(mainStore.root) !== resolve(args.projectRoot)) {
            revokedResult = revokeGrant({ projectRoot: mainStore.root, grantId: args.grantId });
          }
        }
        if (!revokedResult.ok) {
          process.stderr.write(`authz:revoke: ${revokedResult.reason}\n`);
          return 2;
        }
        const revoked = revokedResult.grant;
        if (revoked === null) {
          process.stderr.write(`authz: grant not found: ${args.grantId}\n`);
          return 1;
        }
        process.stdout.write(
          `✓ grant revoked id=${revoked.id} at ${revoked.semantics.revokedAt}\n`,
        );
        return 0;
      }
      default:
        process.stderr.write(`${helpText()}\n`);
        return 2;
    }
  } catch (err) {
    process.stderr.write(`authz: ${String(err)}\n`);
    return 1;
  }
}

/**
 * Mint a release grant after a delegated completion (#7420 B3 / B4 / B8).
 * Core refuses anything but the four release templates and a live delegation;
 * the grant carries the delegated origin. Audited in the delegation store and
 * announced with one chat line.
 */
function mintDelegatedTemplateGrant(args: Parsed, completion: DelegatedCompletion): number {
  const template = (args.template ?? "").trim().toLowerCase();
  if (!isClosedVerbTemplateName(template) || args.target === null) {
    process.stderr.write(`authz:grant: template ${template} is not delegable (#7420).\n`);
    return 2;
  }
  const projectRoot = resolve(args.projectRoot);
  const resolvedTemplate = resolveClosedVerbTemplate({
    template,
    target: args.target,
    expiresAt: args.expiresAt,
  });
  const minted = mintDelegatedReleaseGrant({
    projectRoot,
    completion,
    template,
    surfaces: resolvedTemplate.surfaces,
    expiresAt: resolvedTemplate.expiresAt,
    actor: args.actor,
    singleUse: args.singleUse,
    planRef: args.planRef,
    repo: args.repo,
    branch: args.branch,
  });
  if (!minted.ok) {
    process.stderr.write(`authz:grant: ${minted.reason}\n`);
    return 2;
  }
  const grant = minted.grant;
  const storeRoot = resolveDelegationStoreRoot(projectRoot);
  appendDelegationAudit(storeRoot, {
    schemaVersion: DELEGATION_SCHEMA_VERSION,
    ts: grant.origin.mintedAt,
    event: "delegated-mint",
    provenance: DELEGATED_TOTP_PROVENANCE,
    delegationId: completion.delegationId,
    hostSessionId: completion.hostSessionId,
    detail:
      `authz:grant --template ${template} target=${args.target} grant=${grant.id} ` +
      `request=${completion.requestId} expires=${grant.semantics.expiresAt ?? "-"}`,
  });
  process.stdout.write(
    `${DELEGATED_ACTION_CHAT_LINE_PREFIX} authz:grant ${template} target=${args.target} ` +
      `minted grant ${grant.id} under delegation ${completion.delegationId} ` +
      `(origin ${grant.origin.kind}, expires ${grant.semantics.expiresAt ?? "-"}; ` +
      "stops admitting when the delegation ends).\n",
  );
  return 0;
}

/** authz:show text section for main-clone delivery-identity-attest grants (#6317). */
function writeDeliveryIdentityAttestShow(projectRoot: string): void {
  const attest = listDeliveryIdentityAttestGrants(projectRoot);
  if (!attest.ok) {
    process.stdout.write(`Delivery-identity-attest grants: store unresolved (${attest.reason})\n`);
    return;
  }
  process.stdout.write(
    `Delivery-identity-attest grants (main clone store ${attest.root}): ${attest.grants.length}\n`,
  );
  for (const g of attest.grants) {
    const state =
      g.semantics.revokedAt !== null
        ? `revoked=${g.semantics.revokedAt}`
        : g.semantics.usedAt !== null
          ? `used=${g.semantics.usedAt}`
          : `expires=${g.semantics.expiresAt ?? "-"}`;
    process.stdout.write(
      `  - ${g.id} plan=${g.scope.planRef ?? "-"} ${state} surfaces=${g.scope.surfaces.join("|")}\n`,
    );
  }
}

/** Mint an acceptance-disposition grant from parsed argv (#6318). */
function grantAcceptanceDisposition(args: Parsed, gateConfirm: () => number | null): number {
  const disposition = (args.disposition ?? "deferred").trim();
  const needsDeferredTo = disposition === "deferred";
  const missing =
    args.planRef === null || args.planRef.trim().length === 0
      ? "--plan-ref <scopeId>"
      : args.storyIds.length === 0
        ? "--story-ids <itemIds>"
        : needsDeferredTo && (args.deferredTo === null || args.deferredTo.trim().length === 0)
          ? "--deferred-to <issue> (for --disposition deferred)"
          : args.reason === null || args.reason.trim().length === 0
            ? "--reason <text>"
            : null;
  if (missing !== null) {
    process.stderr.write(`authz:grant --template acceptance-disposition requires ${missing}\n`);
    return 2;
  }
  const blocked = gateConfirm();
  if (blocked !== null) return blocked;
  const minted = mintAcceptanceDispositionTemplateGrant({
    projectRoot: args.projectRoot,
    planRef: args.planRef as string,
    storyIds: args.storyIds,
    disposition,
    ...(args.deferredTo === null ? {} : { deferredTo: args.deferredTo }),
    reason: args.reason as string,
    actor: args.actor,
    expiresAt: args.expiresAt,
    branch: args.branch,
  });
  if (!minted.ok) {
    process.stderr.write(`authz:grant: ${minted.reason}\n`);
    return 2;
  }
  const grant = minted.grant;
  process.stdout.write(
    `✓ human-origin grant minted id=${grant.id} origin=${grant.origin.kind} ` +
      `template=${ACCEPTANCE_DISPOSITION_TEMPLATE_NAME}\n`,
  );
  process.stdout.write(
    `  plan=${grant.scope.planRef} items=${minted.itemIds.join(",")} ` +
      `expires=${grant.semantics.expiresAt ?? "-"}\n`,
  );
  process.stdout.write(
    `  scope:complete writes these items as ${disposition} with this grant id, only while each ` +
      "covered text still matches; first use is recorded when the completed/ write succeeds.\n",
  );
  process.stdout.write(`  Store: ${minted.storeRoot} (main clone, .deft/authz/grants)\n`);
  return 0;
}

/** Mint a single-use plan-sequence-approval grant from parsed argv (#6205). */
function grantPlanSequenceApproval(args: Parsed, gateConfirm: () => number | null): number {
  const missing =
    args.target === null || args.target.trim().length === 0
      ? "--target <insert:<kind>:<id>|replace|clear>"
      : args.planRef === null || args.planRef.trim().length === 0
        ? "--plan-ref <sequence_id>"
        : args.generation === null
          ? "--generation <n>"
          : null;
  if (missing !== null) {
    process.stderr.write(`authz:grant --template plan-sequence-approval requires ${missing}\n`);
    return 2;
  }
  const blocked = gateConfirm();
  if (blocked !== null) return blocked;
  const minted = mintPlanSequenceApprovalGrant({
    projectRoot: args.projectRoot,
    target: args.target as string,
    sequenceId: args.planRef as string,
    generation: args.generation,
    position: args.position,
    issue: args.issueIds[0] ?? null,
    title: args.title,
    repo: args.repo,
    actor: args.actor,
    expiresAt: args.expiresAt,
  });
  if (!minted.ok) {
    process.stderr.write(`authz:grant: ${minted.reason}\n`);
    return 2;
  }
  const grant = minted.grant;
  process.stdout.write(
    `✓ human-origin grant minted id=${grant.id} origin=${grant.origin.kind} ` +
      `template=${PLAN_SEQUENCE_APPROVAL_TEMPLATE_NAME}\n`,
  );
  process.stdout.write(
    `  plan=${grant.scope.planRef} repo=${grant.scope.repo} binds=${grant.scope.surfaces.join("|")} ` +
      `expires=${grant.semantics.expiresAt ?? "-"}\n`,
  );
  process.stdout.write(
    "  Single-use: spent by the one plan-sequence write it binds; a failed write leaves it unspent.\n",
  );
  process.stdout.write(`  Store: ${minted.storeRoot} (main clone, .deft/authz/grants)\n`);
  return 0;
}

/** authz:show text section for main-clone acceptance-disposition grants (#6318). */
function writeAcceptanceDispositionShow(projectRoot: string): void {
  const listed = listAcceptanceDispositionGrants(projectRoot);
  if (!listed.ok) {
    process.stdout.write(`Acceptance-disposition grants: store unresolved (${listed.reason})\n`);
    return;
  }
  process.stdout.write(
    `Acceptance-disposition grants (main clone store ${listed.root}): ${listed.grants.length}\n`,
  );
  for (const g of listed.grants) {
    const state =
      g.semantics.revokedAt !== null
        ? `revoked=${g.semantics.revokedAt}`
        : g.semantics.usedAt !== null
          ? `used=${g.semantics.usedAt}`
          : `expires=${g.semantics.expiresAt ?? "-"}`;
    const stored = g.scope.surfaces
      .find((s) => s.startsWith(ACCEPTANCE_DISPOSITION_VALUE_PREFIX))
      ?.slice(ACCEPTANCE_DISPOSITION_VALUE_PREFIX.length);
    process.stdout.write(
      `  - ${g.id} plan=${g.scope.planRef ?? "-"} disposition=${stored ?? "deferred"} ` +
        `items=${g.scope.storyIds.join(",")} ${state}\n`,
    );
  }
}

export default main;

if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, "/")}`) {
  process.exitCode = main();
}
