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
 *   deft authz:grant -- --parent <parent.xbrief.json> --draft <draft.json> [--repo owner/name] [--confirm]
 *   deft authz:revoke -- <grant-id> [--confirm]
 *
 * **UAT-active hard refuse (#3110):** while any UAT lease is active, ALL mutating
 * verbs (`uat-start`, `uat-suspend`, `grant`, `revoke`) refuse unconditionally —
 * no TTY, no `--confirm`, no typed phrase path. Self-approval under UAT is
 * impossible by construction (agent PTY cannot mint operator-cli authority).
 *
 * **Outside UAT:** mutating verbs require multi-factor human presence: interactive
 * TTY + controlling terminal + `--confirm` + typed phrase `mint`; agent/CI env
 * markers refuse fail-closed. Argv `--confirm` alone is never enough.
 */
import { existsSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import {
  AFK_TEMPLATE_NAMES,
  AUTHZ_OPERATIONS,
  type AuthzOperation,
  CLOSED_VERB_TEMPLATE_NAMES,
  FINISH_LOOP_TEMPLATE_NAME,
  formatDecomposeStructuralMintCommand,
  isAfkTemplateName,
  isClosedVerbTemplateName,
  isFinishLoopTemplateName,
  mintAfkTemplateGrant,
  mintDecomposeStructuralApplyGrant,
  mintHumanOriginGrant,
  revokeGrant,
  showAuthzSnapshot,
  startUatLease,
  suspendUatLease,
  toProjectRelativePosix,
} from "@deftai/directive-core/authz";
import {
  type HumanPresenceMintSeams,
  refuseMintWhileUatActive,
  refuseNonInteractiveMint,
  resolveHumanPresenceMintSeams,
} from "./human-presence-mint.js";

export type { HumanPresenceMintSeams as AuthzMainSeams } from "./human-presence-mint.js";
export {
  AUTHZ_AGENT_SHELL_ENV_MARKERS,
  AUTHZ_INTERACTIVE_CONFIRM_PHRASE,
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
  format: "text" | "json";
  /** Explicit operator confirm for non-TTY / agent shells (#3110). */
  confirm: boolean;
  error?: string;
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
    format: "text",
    confirm: false,
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
    if (a === "--confirm") {
      base.confirm = true;
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
    "  deft authz:grant -- --parent <parent.xbrief.json> --draft <draft.json> \\",
    "      [--repo owner/name] [--expires ISO] [--single-use] [--actor <name>] [--confirm]",
    "  deft authz:revoke -- <grant-id> [--confirm]",
    "",
    "Human-origin grants are minted only via this CLI (origin.kind=operator-cli).",
    "Self-authored xBRIEF/lifecycle/dispatch tokens never satisfy implement gates (#2944).",
    "While any UAT lease is ACTIVE (#3110): ALL mutating verbs refuse unconditionally",
    "  (grant / uat-start / uat-suspend / revoke) — no TTY, --confirm, or phrase path.",
    "  Self-approval under UAT is impossible by construction. Mint grants BEFORE uat-start.",
    "Outside UAT, mutating verbs require multi-factor human presence (#3110):",
    "  - Interactive TTY (stdin+stdout) + controlling terminal (/dev/tty|CONIN$)",
    "  - Explicit --confirm (argv flag alone never enough)",
    "  - Typed phrase 'mint' on the controlling TTY (PTY+--confirm alone never enough)",
    "  - Known agent/CI env markers always refuse (fail-closed).",
    "  End UAT only after the lease is cleared out-of-band (state edit / suspend path",
    "  that does not run while the lease is active) — or suspend before re-minting.",
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
   * Mutating-verb gate stack (#3110):
   * 1. Active UAT → hard refuse (no multi-factor escape; self-approval impossible)
   * 2. Else multi-factor: TTY + controlling tty + --confirm + typed phrase; agent/CI markers refuse
   * Required-arg validation runs before this so missing --campaign / --ops still report clearly.
   */
  const gateConfirm = (): number | null => {
    if (args.cmd === "show") return null;
    const uatBlocked = refuseMintWhileUatActive(`authz:${args.cmd}`, args.projectRoot);
    if (uatBlocked !== null) return uatBlocked;
    return refuseNonInteractiveMint({
      verb: `authz:${args.cmd}`,
      confirm: args.confirm,
      isTty: resolved.isTty,
      environ: resolved.environ,
      hasControllingTerminal: resolved.hasControllingTerminal,
      readInteractiveConfirm: resolved.readInteractiveConfirm,
    });
  };

  try {
    switch (args.cmd) {
      case "show": {
        const snap = showAuthzSnapshot(args.projectRoot);
        if (args.format === "json") {
          process.stdout.write(`${JSON.stringify(snap, null, 2)}\n`);
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
        return 0;
      }
      case "uat-start": {
        if (args.campaign === null || args.campaign.trim().length === 0) {
          process.stderr.write("authz:uat-start requires --campaign <id>\n");
          return 2;
        }
        const blocked = gateConfirm();
        if (blocked !== null) return blocked;
        const { lease } = startUatLease({
          projectRoot: args.projectRoot,
          campaignId: args.campaign,
          actor: args.actor,
          note: args.note,
        });
        process.stdout.write(
          `✓ UAT lease ACTIVE campaign=${lease.campaignId} (human-origin operator-cli)\n`,
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
        const state = suspendUatLease({
          projectRoot: args.projectRoot,
          actor: args.actor,
        });
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
          const grant = mintDecomposeStructuralApplyGrant({
            projectRoot: root,
            parentPath: parentAbs,
            draftPath: draftAbs,
            actor: args.actor,
            repo: args.repo,
            expiresAt: args.expiresAt,
            singleUse: args.singleUse,
          });
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
        // AFK template path (#1095 / #871): presets only — still mintHumanOriginGrant.
        if (args.template !== null && args.template.trim().length > 0) {
          if (!isAfkTemplateName(args.template)) {
            process.stderr.write(
              `authz:grant unknown --template '${args.template}'; expected one of: ${AFK_TEMPLATE_NAMES.join(", ")}\n`,
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
          const blocked = gateConfirm();
          if (blocked !== null) return blocked;
          const grant = mintAfkTemplateGrant({
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
            "authz:grant requires --operations <edit,push,...>, --template <finish-loop|release-*>, " +
              "or --parent + --draft (structural scope:decompose apply)\n",
          );
          return 2;
        }
        {
          const blocked = gateConfirm();
          if (blocked !== null) return blocked;
        }
        const grant = mintHumanOriginGrant({
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
        const revoked = revokeGrant({
          projectRoot: args.projectRoot,
          grantId: args.grantId,
        });
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

export default main;

if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, "/")}`) {
  process.exitCode = main();
}
