#!/usr/bin/env node
/**
 * Authz CLI (#2944 Wave 1 + #1095 Wave 4): human-origin grants + UAT lease +
 * AFK closed-verb templates (mint via mintHumanOriginGrant only).
 *
 *   deft authz:show
 *   deft authz:uat-start -- --campaign <id> [--actor <name>] [--note <text>]
 *   deft authz:uat-suspend
 *   deft authz:grant -- --operations edit,push --surfaces 'src/**' --cohort <id> ...
 *   deft authz:grant -- --template release-publish --target 0.30.0
 *   deft authz:revoke -- <grant-id>
 */
import {
  AUTHZ_OPERATIONS,
  type AuthzOperation,
  CLOSED_VERB_TEMPLATE_NAMES,
  isClosedVerbTemplateName,
  mintClosedVerbTemplateGrant,
  mintHumanOriginGrant,
  revokeGrant,
  showAuthzSnapshot,
  startUatLease,
  suspendUatLease,
} from "@deftai/directive-core/authz";

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
  format: "text" | "json";
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
    format: "text",
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
    "  deft authz:uat-start -- --campaign <id> [--actor <name>] [--note <text>]",
    "  deft authz:uat-suspend",
    "  deft authz:grant -- --operations edit,push --surfaces 'src/**' --cohort <id> \\",
    "      [--stories 2944] [--plan-ref <id>] [--repo owner/name] [--branch <b>] [--expires ISO]",
    "  deft authz:grant -- --template release-publish --target 0.30.0 [--actor <name>] [--expires ISO]",
    "  deft authz:revoke -- <grant-id>",
    "",
    "Human-origin grants are minted only via this CLI (origin.kind=operator-cli).",
    "Self-authored xBRIEF/lifecycle/dispatch tokens never satisfy implement gates (#2944).",
    "",
    `AFK closed-verb templates (#1095): ${CLOSED_VERB_TEMPLATE_NAMES.join(", ")}`,
    "  Templates call mintHumanOriginGrant only — no second session-auth mint engine.",
    "  Env bypass for a single shell: DEFT_ALLOW_RELEASE_PUBLISH=1 (etc.).",
  ].join("\n");
}

export function main(argv: string[] = process.argv.slice(2)): number {
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
        // AFK template path (#1095): presets only — still mintHumanOriginGrant.
        if (args.template !== null && args.template.trim().length > 0) {
          if (!isClosedVerbTemplateName(args.template)) {
            process.stderr.write(
              `authz:grant unknown --template '${args.template}'; expected one of: ${CLOSED_VERB_TEMPLATE_NAMES.join(", ")}\n`,
            );
            return 2;
          }
          if (args.target === null || args.target.trim().length === 0) {
            process.stderr.write(
              `authz:grant --template ${args.template} requires --target <version>\n`,
            );
            return 2;
          }
          const grant = mintClosedVerbTemplateGrant({
            projectRoot: args.projectRoot,
            template: args.template,
            target: args.target,
            actor: args.actor,
            expiresAt: args.expiresAt,
            singleUse: args.singleUse,
            planRef: args.planRef,
            repo: args.repo,
            branch: args.branch,
          });
          process.stdout.write(
            `✓ human-origin grant minted id=${grant.id} origin=${grant.origin.kind} ` +
              `template=${args.template}\n`,
          );
          process.stdout.write(
            `  ops=[${grant.scope.operations.join(",")}] target surfaces=${grant.scope.surfaces.join(", ")}\n`,
          );
          process.stdout.write(
            "  Authorization SoT: Wave 1 grant store (.deft/authz/grants) — not session-auth.\n",
          );
          return 0;
        }
        if (args.operations.length === 0) {
          process.stderr.write(
            "authz:grant requires --operations <edit,push,...> or --template <release-*> --target <ver>\n",
          );
          return 2;
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
