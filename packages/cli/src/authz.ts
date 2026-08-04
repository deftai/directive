#!/usr/bin/env node
/**
 * Authz CLI (#2944 Wave 1 + #1095 Wave 4 + #3110): human-origin grants + UAT lease +
 * AFK closed-verb templates (mint via mintHumanOriginGrant only).
 *
 *   deft authz:show
 *   deft authz:uat-start -- --campaign <id> [--actor <name>] [--note <text>] [--confirm]
 *   deft authz:uat-suspend [--confirm]
 *   deft authz:grant -- --operations edit,push --surfaces 'src/**' --cohort <id> ... [--confirm]
 *   deft authz:grant -- --template release-publish --target 0.30.0 [--confirm]
 *   deft authz:grant -- --template finish-loop [--confirm]
 *   deft authz:revoke -- <grant-id> [--confirm]
 *
 * Mutating subcommands require **both** an interactive TTY **and** explicit `--confirm`
 * so pseudo-TTY / agent shells cannot silent-stamp operator-cli origin (#3110).
 * Argv `--confirm` alone is never enough; TTY alone is never enough.
 */
import { closeSync, openSync, readSync } from "node:fs";
import {
  AFK_TEMPLATE_NAMES,
  AUTHZ_OPERATIONS,
  type AuthzOperation,
  CLOSED_VERB_TEMPLATE_NAMES,
  FINISH_LOOP_TEMPLATE_NAME,
  isAfkTemplateName,
  isClosedVerbTemplateName,
  isFinishLoopTemplateName,
  mintAfkTemplateGrant,
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
  /** Explicit operator confirm for non-TTY / agent shells (#3110). */
  confirm: boolean;
  error?: string;
}

/**
 * Env markers that indicate an agent/host/CI shell even when stdin reports a TTY
 * (pseudo-terminal residual; #3110 Greptile). Presence refuses mutating authz.
 * Expanded for dogfood conf 5/5 — markers are fail-closed (any non-empty value).
 */
export const AUTHZ_AGENT_SHELL_ENV_MARKERS = [
  // Coding agents / IDEs
  "CLAUDECODE",
  "CLAUDE_CODE",
  "CLAUDE_CODE_ENTRYPOINT",
  "CURSOR_AGENT",
  "CURSOR_TRACE_ID",
  "CURSOR_SESSION_ID",
  "AIDER",
  "CONTINUE_CLI",
  "CODEX_SANDBOX",
  "CODEX_CI",
  "OPENAI_CODEX",
  "OPENCLAW",
  "OPENCLAW_STATE_DIR",
  "DEFT_PROBE_OPENCLAW",
  "DEFT_HOOK_HOST",
  "DEFT_AGENT_SHELL",
  "DEFT_AGENT_RUNTIME",
  "WARP_SESSION_ID",
  "WARP_HARNESS",
  "WARP_RUN_ID",
  "GEMINI_CLI",
  "AMP_CLI",
  "SWARM_AGENT",
  "AI_AGENT",
  // CI / automation (never a human interactive operator mint)
  "CI",
  "CONTINUOUS_INTEGRATION",
  "GITHUB_ACTIONS",
  "GITLAB_CI",
  "CIRCLECI",
  "BUILDKITE",
  "TRAVIS",
  "JENKINS_URL",
  "TEAMCITY_VERSION",
  "TF_BUILD",
  "APPVEYOR",
  "BITBUCKET_BUILD_NUMBER",
  "CODEBUILD_BUILD_ID",
] as const;

/** Phrase an operator must type on the controlling TTY after --confirm (#3110). */
export const AUTHZ_INTERACTIVE_CONFIRM_PHRASE = "mint";

/** Testable seams for TTY / agent-shell detection (#3110). */
export interface AuthzMainSeams {
  /**
   * When true, interactive human TTY is present.
   * Default: both stdin and stdout report isTTY (pseudo-TTY residual; #3110).
   */
  readonly isTty?: () => boolean;
  /** Environ for agent-shell marker detection (default: process.env). */
  readonly environ?: NodeJS.ProcessEnv;
  /**
   * True when a controlling terminal device is available (`/dev/tty` or `CONIN$`).
   * Default: open/close the platform controlling terminal (fail-closed on error).
   */
  readonly hasControllingTerminal?: () => boolean;
  /**
   * Read one interactive confirmation line from the operator (trimmed).
   * Default: one line from stdin. Tests inject a fixed phrase.
   */
  readonly readInteractiveConfirm?: () => string | null;
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
    "  deft authz:revoke -- <grant-id> [--confirm]",
    "",
    "Human-origin grants are minted only via this CLI (origin.kind=operator-cli).",
    "Self-authored xBRIEF/lifecycle/dispatch tokens never satisfy implement gates (#2944).",
    "Mutating verbs require multi-factor human presence (#3110):",
    "  - Interactive TTY (stdin+stdout) + controlling terminal (/dev/tty|CONIN$)",
    "  - Explicit --confirm (argv flag alone never enough)",
    "  - Typed phrase 'mint' on the controlling TTY (PTY+--confirm alone never enough)",
    "  - Known agent/CI env markers always refuse (fail-closed).",
    "",
    `AFK templates (#1095 / #871): ${AFK_TEMPLATE_NAMES.join(", ")}`,
    `  Closed-verb (#1095): ${CLOSED_VERB_TEMPLATE_NAMES.join(", ")} — require --target`,
    `  Finish-loop (#871): ${FINISH_LOOP_TEMPLATE_NAME} — edit/push/pr/merge (no release ops)`,
    "  Templates call mintHumanOriginGrant only — no second session-auth mint engine.",
    "  Env bypass for a single shell: DEFT_ALLOW_RELEASE_PUBLISH=1 / DEFT_ALLOW_FINISH_LOOP=1.",
  ].join("\n");
}

function looksLikeAgentShell(environ: NodeJS.ProcessEnv): boolean {
  for (const key of AUTHZ_AGENT_SHELL_ENV_MARKERS) {
    const v = environ[key];
    if (v !== undefined && String(v).trim().length > 0) return true;
  }
  return false;
}

function defaultHasControllingTerminal(): boolean {
  try {
    const path = process.platform === "win32" ? "CONIN$" : "/dev/tty";
    const fd = openSync(path, "r");
    closeSync(fd);
    return true;
  } catch {
    return false;
  }
}

function defaultReadInteractiveConfirm(): string | null {
  try {
    // Synchronous one-line read from stdin (operator TTY). Agents piping input fail the phrase check.
    const buf = Buffer.alloc(256);
    let n = 0;
    try {
      n = readSync(0, buf, 0, buf.length, null);
    } catch {
      return null;
    }
    if (n <= 0) return null;
    return buf.subarray(0, n).toString("utf8").trim();
  } catch {
    return null;
  }
}

/**
 * Refuse non-interactive / agent-shell operator-cli stamps (#3110 / Greptile residual).
 *
 * Multi-factor human-presence gate (dogfood conf 5/5):
 * 1. No known agent/CI env markers
 * 2. Interactive TTY (stdin + stdout isTTY)
 * 3. Controlling terminal device present (`/dev/tty` / `CONIN$`)
 * 4. Explicit argv `--confirm` (flag alone never enough)
 * 5. Interactive typed phrase `mint` (argv --confirm alone never enough even on PTY)
 *
 * Fail-closed: if a real human interactive path cannot be proven, refuse mint.
 * Returns an exit code when blocked, or null when the mutation may proceed.
 */
function refuseNonInteractiveMint(
  cmd: Parsed["cmd"],
  isTty: () => boolean,
  environ: NodeJS.ProcessEnv,
  confirm: boolean,
  hasControllingTerminal: () => boolean,
  readInteractiveConfirm: () => string | null,
): number | null {
  if (cmd === "show") return null;
  if (looksLikeAgentShell(environ)) {
    process.stderr.write(
      `authz:${cmd}: refusing operator-cli stamp from an agent/host/CI shell ` +
        `(detected agent or CI env marker). Mutating authz requires a human interactive ` +
        "TTY without agent-shell markers, plus --confirm and typed phrase (#3110).\n",
    );
    return 2;
  }
  const tty = isTty();
  if (!tty && !confirm) {
    process.stderr.write(
      `authz:${cmd}: refusing non-interactive operator-cli stamp. ` +
        "Mutating authz verbs require interactive TTY, --confirm, and typed phrase " +
        `'${AUTHZ_INTERACTIVE_CONFIRM_PHRASE}' (#3110).\n`,
    );
    return 2;
  }
  if (!tty) {
    process.stderr.write(
      `authz:${cmd}: refusing non-TTY operator-cli stamp. ` +
        "--confirm alone never authorizes mint — interactive TTY is required (#3110).\n",
    );
    return 2;
  }
  if (!confirm) {
    process.stderr.write(
      `authz:${cmd}: refusing operator-cli stamp without --confirm. ` +
        "Interactive TTY alone never authorizes mint — pass --confirm explicitly (#3110).\n",
    );
    return 2;
  }
  if (!hasControllingTerminal()) {
    process.stderr.write(
      `authz:${cmd}: refusing operator-cli stamp without a controlling terminal. ` +
        "Open a real interactive console (not a headless/agent pipe) to mint (#3110).\n",
    );
    return 2;
  }
  process.stderr.write(
    `authz:${cmd}: type '${AUTHZ_INTERACTIVE_CONFIRM_PHRASE}' and press Enter to confirm operator mint: `,
  );
  const line = readInteractiveConfirm();
  const phrase = (line ?? "").trim().toLowerCase();
  if (phrase !== AUTHZ_INTERACTIVE_CONFIRM_PHRASE) {
    process.stderr.write(
      `\nauthz:${cmd}: interactive confirm phrase mismatch (got ${JSON.stringify(line ?? "")}). ` +
        `Type exactly '${AUTHZ_INTERACTIVE_CONFIRM_PHRASE}' on the controlling TTY (#3110).\n`,
    );
    return 2;
  }
  return null;
}

export function main(argv: string[] = process.argv.slice(2), seams: AuthzMainSeams = {}): number {
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

  // Both stdin and stdout TTY — agent-allocated single-side PTY is not enough.
  const isTty =
    seams.isTty ?? (() => process.stdin.isTTY === true && process.stdout.isTTY === true);
  const environ = seams.environ ?? process.env;
  const hasControllingTerminal = seams.hasControllingTerminal ?? defaultHasControllingTerminal;
  const readInteractiveConfirm = seams.readInteractiveConfirm ?? defaultReadInteractiveConfirm;
  // Gate after required-arg validation so missing --campaign / --ops still report clearly.
  // Multi-factor: TTY + controlling tty + --confirm + typed phrase; agent/CI markers refuse.
  const gateConfirm = (): number | null =>
    refuseNonInteractiveMint(
      args.cmd,
      isTty,
      environ,
      args.confirm,
      hasControllingTerminal,
      readInteractiveConfirm,
    );

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
            "authz:grant requires --operations <edit,push,...> or --template <finish-loop|release-*> \n",
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
