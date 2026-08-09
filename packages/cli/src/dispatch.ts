/**
 * Unified `directive <verb> [args]` dispatcher (#1828 s0).
 * Routes to ported command modules in packages/cli and packages/core.
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { engineInfo, userConfig } from "@deftai/directive-core";
import { assertWriteTargetSafe } from "@deftai/directive-core/dist/fs/projection-containment.js";
import { parseInitArgv, runInitDepositCli } from "@deftai/directive-core/init-deposit";
import {
  appendAuditLog,
  disclosureLine,
  migrateLegacyPolicyKey,
  PLAN_POLICY_KEY,
  policyColonInvocation,
  policySetInvocation,
  projectDefinitionPath,
  resolvePolicy,
  resolveWipCap,
  setPolicy,
} from "@deftai/directive-core/policy";
import { defaultWhich, type WhichFn } from "@deftai/directive-core/scm";
import {
  KNOWN_SUBAGENT_BACKEND_IDS,
  probeSubagentBackends,
  resolveSwarmSubagentBackend,
  type SubagentBackendDescriptor,
} from "@deftai/directive-core/swarm";
import { atomicWriteProjectDefinition } from "@deftai/directive-core/vbrief-build";

export type CommandHandler = (argv: string[]) => number | Promise<number>;

export interface DispatchIo {
  writeOut: (text: string) => void;
  writeErr: (text: string) => void;
}

interface CliResult {
  exitCode: number;
  stdout?: string;
  stderr?: string;
}

const HANDLER_KEYS = [
  "run",
  "main",
  "mainEntry",
  "launchMain",
  "completeCohortMain",
  "readinessMain",
  "verifyReviewCleanMain",
  "worktreesMain",
] as const;

/** CLI modules in packages/cli/src (excluding parity harnesses and bin/index). */
export const CLI_MODULE_VERBS = [
  "agents-refresh",
  "cache",
  "check",
  "capacity-backfill",
  "capacity-show",
  "codebase-default-extractor",
  "codebase-map",
  "codebase-map-fresh",
  "codebase-projection-registry",
  "codebase-provider",
  "doctor",
  "install-upgrade",
  "install-uninstall",
  "migrate-preflight",
  "migrate-xbrief",
  "migrate-category-b",
  "framework-check-updates",
  "hook-dispatch",
  "umbrella-current-shape",
  "changelog-check",
  "change-init",
  "commit-lint",
  "coverage-hotspots",
  "policy",
  "authz",
  "escalation-cli",
  "pr-closing-keywords",
  "pr-merge-readiness",
  "pr-monitor",
  "pr-protected-issues",
  "pr-wait-mergeable",
  "pr-watch",
  "pr-finish-loop",
  "directive-finish-loop",
  "preflight-cache",
  "preflight-gh",
  "probe-session",
  "release",
  "release-e2e",
  "release-publish",
  "release-rollback",
  "scope-lifecycle",
  "scope-record-approved-scope",
  "lifecycle-event",
  "lifecycle-stats",
  "session-start",
  "session-ready",
  "plan-sequence",
  "slice",
  "subagent-monitor",
  "toolchain-check",
  "triage-actions",
  "triage-bootstrap",
  "triage-bulk",
  "triage-classify",
  "triage-help",
  "triage-queue",
  "triage-reconcile",
  "triage-refresh",
  "triage-scope",
  "triage-scope-drift",
  "triage-smoketest",
  "triage-subscribe",
  "triage-summary",
  "triage-welcome",
  "ts-check-lane",
  "vbrief-activate",
  "vbrief-build",
  "vbrief-preflight",
  "vbrief-reconcile",
  "vbrief-validate",
  "vbrief-validation",
  "xbrief-create",
  "xbrief-verify",
  "verify-branch",
  "verify-encoding",
  "verify-forward-coverage",
  "verify-test-boundary",
  "verify-scope-provenance",
  "verify-consumer-check-contract",
  "verify-hooks-installed",
  "verify-investigation",
  "verify-judgment-gates",
  "verify-no-task-runtime",
  "validate-links",
  "validate-strategy-output",
  "verify-biome-config",
  "verify-bridge-drift",
  "verify-capacity",
  "verify-contained-writes",
  "verify-content-manifest",
  "verify-skill-external-fetch-gate",
  "verify-contract-drift",
  "verify-cursor-tier1",
  "verify-openclaw-tier1",
  "verify-go-freeze",
  "verify-scm-boundary",
  "verify-session-ritual",
  "verify-plan-sequence",
  "verify-stubs",
  "verify-xbrief-drift",
  "rule-ownership-lint",
  "verify-story-ready",
  "verify-review-monitor",
  "verify-l4-owner",
  "verify-subagent-alive",
  "review-monitor-register",
  "review-monitor-release",
  "verify-tools",
  "verify-wip-cap",
  "verify-orphan-active",
  "verify-agents-md-budget",
  "verify-agents-md-advisory",
  "verify-eval-health-relocation",
  "verify-eval-triggers-relocation",
  "eval-health",
  "eval-run",
  "eval-report",
  "eval-triggers",
] as const;

/** Core-only CLI entrypoints without a packages/cli wrapper. */
export const CORE_MODULE_VERBS = [
  "scm",
  "scm-readiness",
  "github-auth-modes",
  "github-body",
  "issue-emit",
  "issue-ingest",
  "issue-sync-from-xbrief",
  "reconcile-issues",
  "swarm-launch",
  "swarm-complete-cohort",
  "swarm-finalize-cohort",
  "swarm-readiness",
  "swarm-routing-verify",
  "swarm-routing-set",
  "swarm-verify-review-clean",
  "swarm-worktrees",
  "framework-commands",
  "pack-render",
  "packs-slice",
  "prd-render",
  "export-spec",
  "project-render",
  "roadmap-render",
  "rule-map",
  "spec-render",
  "spec-validate",
  "code-structure-validate",
  "pack-migrate-skills",
  "pack-migrate-rules",
  "pack-migrate-strategies",
  "pack-migrate-patterns",
  "pack-migrate-swarm-spec",
  "policy-set",
  "setup-ghx",
  "scope-undo",
  "scope-demote",
  "scope-decompose",
  "changelog-resolve-unreleased",
  "architecture-preflight-sor",
  "feedback-file",
  "value-readback",
  "product-signal",
  "freshness-report",
  "decision-write",
  "decision-list",
] as const;

/** Colon aliases for triage-actions (mirrors cli-router SUBCOMMAND_ROUTES). */
export const TRIAGE_ACTION_ALIAS_SUBCOMMANDS: Readonly<Record<string, string>> = {
  "triage:accept": "accept",
  "triage:reject": "reject",
  "triage:defer": "defer",
  "triage:needs-ac": "needs-ac",
  "triage:mark-duplicate": "mark-duplicate",
  "triage:status": "status",
  "triage:reset": "reset",
  "triage:history": "history",
};

const TRIAGE_ACTION_COLON_ALIASES = Object.fromEntries(
  Object.keys(TRIAGE_ACTION_ALIAS_SUBCOMMANDS).map((alias) => [alias, "triage-actions"]),
) as Record<string, string>;

/** Colon aliases for policy subcommands (mirrors cli-router SUBCOMMAND_ROUTES). */
export const POLICY_ACTION_ALIAS_SUBCOMMANDS: Readonly<Record<string, string>> = {
  "policy:show": "show",
  "policy:enforce-branches": "enforce-branches",
  "policy:allow-direct-commits": "allow-direct-commits",
  "policy:allow-bot-merge": "allow-bot-merge",
  "policy:enable-value-feedback": "enable-value-feedback",
  "policy:clear-value-feedback": "clear-value-feedback",
  "policy:coverage-check-resume-preset": "coverage-check-resume-preset",
  "policy:coverage-check-resume-dismiss": "coverage-check-resume-dismiss",
  "policy:coverage-check-resume-later": "coverage-check-resume-later",
  "policy:disable-directive": "disable-directive",
  "policy:enable-directive": "enable-directive",
};

const POLICY_ACTION_COLON_ALIASES = Object.fromEntries(
  Object.keys(POLICY_ACTION_ALIAS_SUBCOMMANDS).map((alias) => [alias, "policy"]),
) as Record<string, string>;

/** Colon aliases for authz subcommands (#2944). */
export const AUTHZ_ACTION_ALIAS_SUBCOMMANDS: Readonly<Record<string, string>> = {
  "authz:show": "show",
  "authz:uat-start": "uat-start",
  "authz:uat-suspend": "uat-suspend",
  "authz:grant": "grant",
  "authz:revoke": "revoke",
};

const AUTHZ_ACTION_COLON_ALIASES = Object.fromEntries(
  Object.keys(AUTHZ_ACTION_ALIAS_SUBCOMMANDS).map((alias) => [alias, "authz"]),
) as Record<string, string>;

/** Colon aliases for escalation subcommands (#518). */
export const ESCALATION_ACTION_ALIAS_SUBCOMMANDS: Readonly<Record<string, string>> = {
  "escalation:file": "file",
  "escalation:list": "list",
  "escalation:resolve": "resolve",
  "escalation:batch-approve": "batch-approve",
};

const ESCALATION_ACTION_COLON_ALIASES = Object.fromEntries(
  Object.keys(ESCALATION_ACTION_ALIAS_SUBCOMMANDS).map((alias) => [alias, "escalation-cli"]),
) as Record<string, string>;

/** Colon aliases for plan-sequence subcommands (#2402). */
export const PLAN_SEQUENCE_ALIAS_SUBCOMMANDS: Readonly<Record<string, string>> = {
  "plan-sequence:set": "set",
  "plan-sequence:current": "current",
  "plan-sequence:clear": "clear",
  "plan-sequence:advance": "advance",
};

const PLAN_SEQUENCE_COLON_ALIASES = Object.fromEntries(
  Object.keys(PLAN_SEQUENCE_ALIAS_SUBCOMMANDS).map((alias) => [alias, "plan-sequence"]),
) as Record<string, string>;

/** Colon aliases for product-signal subcommands (#2693). */
export const PRODUCT_SIGNAL_ALIAS_SUBCOMMANDS: Readonly<Record<string, string>> = {
  "product-signal:status": "status",
  "product-signal:enable": "enable",
  "product-signal:consent": "consent",
  "product-signal:submit": "submit",
  "product-signal:bootstrap-sink": "bootstrap-sink",
};

const PRODUCT_SIGNAL_COLON_ALIASES = Object.fromEntries(
  Object.keys(PRODUCT_SIGNAL_ALIAS_SUBCOMMANDS).map((alias) => [alias, "product-signal"]),
) as Record<string, string>;

/** Colon aliases for freshness subcommands (#3117). */
export const FRESHNESS_ALIAS_SUBCOMMANDS: Readonly<Record<string, string>> = {
  "freshness:report": "report",
  "freshness:bind": "bind",
  "session:freshness": "report",
  freshness: "report",
};

const FRESHNESS_COLON_ALIASES = Object.fromEntries(
  Object.keys(FRESHNESS_ALIAS_SUBCOMMANDS).map((alias) => [alias, "freshness-report"]),
) as Record<string, string>;

/** Task-style aliases (framework_commands / Taskfile names). */
export const VERB_ALIASES: Readonly<Record<string, string>> = {
  "hook:dispatch": "hook-dispatch",
  "verify:encoding": "verify-encoding",
  "verify:forward-coverage": "verify-forward-coverage",
  "verify:test-boundary": "verify-test-boundary",
  "verify:scope-provenance": "verify-scope-provenance",
  "scope:record-approved-scope": "scope-record-approved-scope",
  "verify:consumer-check-contract": "verify-consumer-check-contract",
  "coverage:hotspots": "coverage-hotspots",
  "verify:branch": "verify-branch",
  "verify:vbrief-conformance": "vbrief-validate",
  "verify:wip-cap": "verify-wip-cap",
  "verify:orphan-active": "verify-orphan-active",
  "verify:agents-md-budget": "verify-agents-md-budget",
  "verify:agents-md-advisory": "verify-agents-md-advisory",
  "verify:eval-health-relocation": "verify-eval-health-relocation",
  "verify:eval-triggers-relocation": "verify-eval-triggers-relocation",
  "verify:hooks-installed": "verify-hooks-installed",
  "verify:no-task-runtime": "verify-no-task-runtime",
  "vbrief:validate": "vbrief-validate",
  "vbrief:preflight": "vbrief-preflight",
  "xbrief:preflight": "vbrief-preflight",
  "xbrief:create": "xbrief-create",
  "xbrief:verify": "xbrief-verify",
  "vbrief:activate": "vbrief-activate",
  "verify:story-ready": "verify-story-ready",
  "verify:review-monitor": "verify-review-monitor",
  "verify:l4-owner": "verify-l4-owner",
  "verify:subagent-alive": "verify-subagent-alive",
  "agent:monitor": "subagent-monitor",
  "review-monitor:register": "review-monitor-register",
  "review-monitor:release": "review-monitor-release",
  "verify:tools": "verify-tools",
  "verify:investigation": "verify-investigation",
  "verify:judgment-gates": "verify-judgment-gates",
  "verify:stubs": "verify-stubs",
  "verify:links": "validate-links",
  "validate:links": "validate-links",
  "verify:rule-ownership": "rule-ownership-lint",
  "rule:ownership-lint": "rule-ownership-lint",
  "verify:biome-config": "verify-biome-config",
  "verify:contained-writes": "verify-contained-writes",
  "verify:content-manifest": "verify-content-manifest",
  "verify:skill-external-fetch-gate": "verify-skill-external-fetch-gate",
  "verify:contract-drift": "verify-contract-drift",
  "verify:cursor-tier1": "verify-cursor-tier1",
  "verify:openclaw-tier1": "verify-openclaw-tier1",
  "verify:go-freeze": "verify-go-freeze",
  "verify:bridge-drift": "verify-bridge-drift",
  "verify:scm-boundary": "verify-scm-boundary",
  "verify:xbrief-drift": "verify-xbrief-drift",
  "verify:capacity": "verify-capacity",
  "verify:session-ritual": "verify-session-ritual",
  "verify:plan-sequence": "verify-plan-sequence",
  ...PLAN_SEQUENCE_COLON_ALIASES,
  "verify-strategy-output": "validate-strategy-output",
  "validate:strategy-output": "validate-strategy-output",
  "verify:codebase-map-fresh": "codebase-map-fresh",
  "codebase:map": "codebase-map",
  "triage:welcome": "triage-welcome",
  "triage:bootstrap": "triage-bootstrap",
  "triage:summary": "triage-summary",
  "triage:queue": "triage-queue",
  "triage:scope": "triage-scope",
  ...TRIAGE_ACTION_COLON_ALIASES,
  ...POLICY_ACTION_COLON_ALIASES,
  ...AUTHZ_ACTION_COLON_ALIASES,
  ...ESCALATION_ACTION_COLON_ALIASES,
  ...PRODUCT_SIGNAL_COLON_ALIASES,
  "agents:refresh": "agents-refresh",
  "migrate:preflight": "migrate-preflight",
  "migrate:xbrief": "migrate-xbrief",
  "migrate:category-b": "migrate-category-b",
  "framework:check-updates": "framework-check-updates",
  "umbrella:current-shape": "umbrella-current-shape",
  "issue:sync-from-xbrief": "issue-sync-from-xbrief",
  upgrade: "install-upgrade",
  "session:start": "session-start",
  "session:ready": "session-ready",
  ...FRESHNESS_COLON_ALIASES,
  "lifecycle:event": "lifecycle-event",
  "lifecycle:stats": "lifecycle-stats",
  "toolchain:check": "toolchain-check",
  "ts:check-lane": "ts-check-lane",
  "spec:validate": "spec-validate",
  "spec:render": "spec-render",
  "prd:render": "prd-render",
  "project:render": "project-render",
  "docs:rule-map": "rule-map",
  "project:export-spec": "export-spec",
  "pr:watch": "pr-watch",
  "pr:finish-loop": "pr-finish-loop",
  "directive:finish-loop": "directive-finish-loop",
  doctor: "doctor",
  "eval:health": "eval-health",
  "feedback:file": "feedback-file",
  "value:show": "value-readback",
  "triage:metrics": "value-readback",
  "decision:write": "decision-write",
  "decision:list": "decision-list",
  "eval:run": "eval-run",
  "eval:triggers": "eval-triggers",
  "eval:report": "eval-report",
  build: "framework-commands",
  "setup:ghx": "setup-ghx",
  "scm:status": "scm-readiness",
  "scm:readiness": "scm-readiness",
};

/** CLI modules living under verify-source-cli/ or content-validate-cli/ subdirs. */
const SUBDIR_CLI_STEMS: Readonly<Record<string, string>> = {
  "verify-stubs": "verify-source-cli/verify-stubs",
  "rule-ownership-lint": "verify-source-cli/rule-ownership-lint",
  "verify-biome-config": "verify-source-cli/verify-biome-config",
  "verify-contained-writes": "verify-source-cli/verify-contained-writes",
  "verify-content-manifest": "verify-source-cli/verify-content-manifest",
  "verify-skill-external-fetch-gate": "verify-source-cli/verify-skill-external-fetch-gate",
  "verify-contract-drift": "verify-source-cli/verify-contract-drift",
  "verify-cursor-tier1": "verify-source-cli/verify-cursor-tier1",
  "verify-openclaw-tier1": "verify-source-cli/verify-openclaw-tier1",
  "verify-scm-boundary": "verify-source-cli/verify-scm-boundary",
  "verify-xbrief-drift": "verify-source-cli/verify-xbrief-drift",
  "verify-go-freeze": "gates-cli/verify-go-freeze",
  "verify-bridge-drift": "gates-cli/verify-bridge-drift",
  "validate-links": "content-validate-cli/validate-links",
  "verify-capacity": "content-validate-cli/verify-capacity",
  "validate-strategy-output": "content-validate-cli/validate-strategy-output",
};

const WRAPPER_CLI_STEMS = new Set<string>([
  "capacity-backfill",
  "capacity-show",
  "codebase-default-extractor",
  "codebase-map",
  "codebase-map-fresh",
  "codebase-projection-registry",
  "codebase-provider",
  "vbrief-activate",
  "vbrief-build",
  "vbrief-reconcile",
  "vbrief-validate",
  "vbrief-validation",
  "xbrief-create",
  "xbrief-verify",
]);

function emitCliResult(result: CliResult, io: DispatchIo): number {
  if (result.stdout) io.writeOut(result.stdout);
  if (result.stderr) io.writeErr(result.stderr);
  return result.exitCode;
}

function resolveHandler(mod: Record<string, unknown>): CommandHandler | null {
  for (const key of HANDLER_KEYS) {
    const fn = mod[key];
    if (typeof fn === "function") {
      return fn as CommandHandler;
    }
  }
  return null;
}

async function loadWrapperCliHandler(stem: string, io: DispatchIo): Promise<CommandHandler> {
  switch (stem) {
    case "capacity-backfill": {
      const { runCapacityBackfillCli } = await import("@deftai/directive-core/capacity");
      return async (argv) => emitCliResult(await runCapacityBackfillCli(argv), io);
    }
    case "capacity-show": {
      const { runCapacityShowCli } = await import("@deftai/directive-core/capacity");
      return (argv) => emitCliResult(runCapacityShowCli(argv), io);
    }
    case "codebase-default-extractor": {
      const { runDefaultExtractorCli } = await import("@deftai/directive-core/codebase");
      return (argv) => emitCliResult(runDefaultExtractorCli(argv), io);
    }
    case "codebase-map": {
      const { runCodebaseMapCli } = await import("@deftai/directive-core/codebase");
      return (argv) => emitCliResult(runCodebaseMapCli(argv), io);
    }
    case "codebase-map-fresh": {
      const { runCodebaseMapFreshCli } = await import("@deftai/directive-core/codebase");
      return (argv) => emitCliResult(runCodebaseMapFreshCli(argv), io);
    }
    case "codebase-projection-registry": {
      const { runProjectionRegistryCli } = await import("@deftai/directive-core/codebase");
      return (argv) => emitCliResult(runProjectionRegistryCli(argv), io);
    }
    case "codebase-provider": {
      const { runProviderCli } = await import("@deftai/directive-core/codebase");
      return (argv) => emitCliResult(runProviderCli(argv), io);
    }
    case "vbrief-activate": {
      const { run } = await import("@deftai/directive-core/vbrief-activate");
      return run;
    }
    case "vbrief-build": {
      const { cmdVbriefBuild } = await import("@deftai/directive-core/vbrief-build");
      return cmdVbriefBuild;
    }
    case "vbrief-reconcile": {
      const { cmdVbriefReconcile } = await import("@deftai/directive-core/vbrief-reconcile");
      return cmdVbriefReconcile;
    }
    case "vbrief-validate": {
      const { cmdVbriefValidate } = await import("@deftai/directive-core/vbrief-validate");
      return cmdVbriefValidate;
    }
    case "vbrief-validation": {
      const { cmdVbriefValidation } = await import("@deftai/directive-core/vbrief-validation");
      return cmdVbriefValidation;
    }
    case "xbrief-create": {
      const { runXbriefCreateCli } = await import("@deftai/directive-core/xbrief");
      return (argv) => emitCliResult(runXbriefCreateCli(argv), io);
    }
    case "xbrief-verify": {
      const { runXbriefVerifyCli } = await import("@deftai/directive-core/xbrief");
      return (argv) => emitCliResult(runXbriefVerifyCli(argv), io);
    }
    default:
      throw new Error(`no wrapper handler for ${stem}`);
  }
}

async function loadCliModuleHandler(stem: string, io: DispatchIo): Promise<CommandHandler> {
  if (WRAPPER_CLI_STEMS.has(stem)) {
    return loadWrapperCliHandler(stem, io);
  }
  const subdir = SUBDIR_CLI_STEMS[stem];
  const modulePath = subdir !== undefined ? `./${subdir}.js` : `./${stem}.js`;
  const mod = (await import(modulePath)) as Record<string, unknown>;
  const handler = resolveHandler(mod);
  if (handler === null) {
    throw new Error(`module ${stem} has no command handler export`);
  }
  return handler;
}

function resolveDeftRoot(): string {
  if (process.env.DEFT_ROOT !== undefined && process.env.DEFT_ROOT.length > 0) {
    return resolve(process.env.DEFT_ROOT);
  }
  return resolve(import.meta.dirname, "..", "..", "..");
}

function parseCodeStructureArgs(argv: readonly string[]): {
  projectRoot: string;
  paths: string[];
  json: boolean;
  strict: boolean;
  error?: string;
} {
  let projectRoot = ".";
  const paths: string[] = [];
  let json = false;
  let strict = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--project-root") {
      const v = argv[i + 1];
      if (v === undefined)
        return { projectRoot, paths, json, strict, error: "missing --project-root value" };
      projectRoot = v;
      i += 1;
    } else if (arg?.startsWith("--project-root=")) {
      projectRoot = arg.slice("--project-root=".length);
    } else if (arg === "--path") {
      const v = argv[i + 1];
      if (v === undefined)
        return { projectRoot, paths, json, strict, error: "missing --path value" };
      paths.push(v);
      i += 1;
    } else if (arg?.startsWith("--path=")) {
      paths.push(arg.slice("--path=".length));
    } else if (arg === "--json") {
      json = true;
    } else if (arg === "--strict") {
      strict = true;
    } else {
      return { projectRoot, paths, json, strict, error: `unrecognized argument: ${arg}` };
    }
  }
  return { projectRoot, paths, json, strict };
}

// ===========================================================================
// Native pack-migrate handlers (#2022 Phase 1).
//
// Port of scripts/pack_migrate_{skills,rules,strategies,patterns,swarm_spec}.py
// to native TypeScript so the pack-render surface no longer shells into bundled
// Python. Output parity with the Python scripts is exact, including the
// json.dumps(..., indent=2, ensure_ascii=True) + "\n" serialization, document
// scanning order, and per-entry field ordering.
// ===========================================================================

const PACK_VERSION = "0.1";
const DEFAULT_SKILL_VERSION = "0.1";

const SHOULD_NOT_GLYPH = "\u2249";
const MUST_NOT_GLYPH = "\u2297";

/** Serialize like Python json.dumps(value, indent=2, ensure_ascii=True) + "\n". */
function dumpsAsciiJson(value: unknown): string {
  const base = JSON.stringify(value, null, 2);
  let out = "";
  for (let i = 0; i < base.length; i += 1) {
    const code = base.charCodeAt(i);
    // ensure_ascii escapes every code unit outside the printable ASCII range
    // (0x20-0x7e). JSON.stringify has already escaped control chars (< 0x20)
    // and the structural quote/backslash, so only chars > 0x7e remain literal.
    if (code > 0x7e) {
      out += `\\u${code.toString(16).padStart(4, "0")}`;
    } else {
      out += base.charAt(i);
    }
  }
  return `${out}\n`;
}

/** Strip leading/trailing chars in `chars` (Python str.strip(chars)); whitespace when omitted. */
function pyStrip(value: string, chars?: string): string {
  if (chars === undefined) {
    return value.replace(/^\s+/, "").replace(/\s+$/, "");
  }
  let start = 0;
  let end = value.length;
  while (start < end && chars.includes(value.charAt(start))) start += 1;
  while (end > start && chars.includes(value.charAt(end - 1))) end -= 1;
  return value.slice(start, end);
}

// Python str.splitlines() universal newlines: \n \r \r\n \v \f \x1c \x1d \x1e \x85 \u2028 \u2029.
// Built from code points (as \uXXXX escape text) so no literal control characters land in the source.
const LINE_BOUNDARY_CLASS = [0x0a, 0x0d, 0x0b, 0x0c, 0x1c, 0x1d, 0x1e, 0x85, 0x2028, 0x2029]
  .map((code) => `\\u${code.toString(16).padStart(4, "0")}`)
  .join("");
const LINE_BOUNDARY_RE = new RegExp(`\\r\\n|[${LINE_BOUNDARY_CLASS}]`);

/** Mirror Python str.splitlines(): split on universal line boundaries, dropping one terminal break. */
function splitLines(text: string): string[] {
  if (text === "") return [];
  const parts = text.split(LINE_BOUNDARY_RE);
  if (parts.length > 0 && parts[parts.length - 1] === "") parts.pop();
  return parts;
}

/** Repo-relative POSIX path of `to` measured from `from`. */
function relPosix(from: string, to: string): string {
  return relative(from, to).split(/[\\/]/).join("/");
}

/** Python Path.stem -- filename minus its final suffix. */
function stemOf(filePath: string): string {
  const base = basename(filePath);
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(0, dot) : base;
}

/** Slugify a doc stem: lowercase, runs of non-alnum -> '-', trimmed of '-'. */
function slugify(stem: string): string {
  return pyStrip(stem.toLowerCase().replace(/[^a-z0-9]+/g, "-"), "-");
}

function isFileSafe(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function isDirSafe(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** Sorted SKILL.md paths one directory below skillsDir (Python skills_dir glob of the SKILL.md docs). */
function globSkillMd(skillsDir: string): string[] {
  const out: string[] = [];
  let names: string[];
  try {
    names = readdirSync(skillsDir);
  } catch {
    return out;
  }
  for (const name of names) {
    const dir = join(skillsDir, name);
    if (!isDirSafe(dir)) continue;
    const candidate = join(dir, "SKILL.md");
    if (isFileSafe(candidate)) out.push(candidate);
  }
  out.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return out;
}

/** Sorted full paths of `<dir>/*.md` (Python dir.glob("*.md")). */
function globMd(dir: string): string[] {
  const out: string[] = [];
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of names) {
    if (!name.endsWith(".md")) continue;
    const candidate = join(dir, name);
    if (isFileSafe(candidate)) out.push(candidate);
  }
  out.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return out;
}

const H1_RE = /^#\s+(.+?)\s*$/;
const CHROME_PREFIXES = [
  "legend ",
  "legend(",
  "**legend",
  `**${"\u26a0\ufe0f"}`,
  "**see also",
  "<!--",
] as const;

function isChrome(line: string): boolean {
  const low = line.replace(/^\s+/, "").toLowerCase();
  if (CHROME_PREFIXES.some((prefix) => low.startsWith(prefix))) return true;
  const stripped = line.trim();
  return stripped.length > 0 && [...stripped].every((ch) => ch === "-" || ch === "=");
}

/** Index a line array with a defined fallback (`i` is always in range at call sites). */
function lineAt(lines: string[], i: number): string {
  return lines[i] ?? "";
}

function extractTitle(md: string): string {
  for (const line of splitLines(md)) {
    const match = H1_RE.exec(line);
    if (match) return (match[1] ?? "").trim();
  }
  return "";
}

function extractDescription(md: string): string {
  const lines = splitLines(md);
  const n = lines.length;
  let i = 0;
  while (i < n && !H1_RE.test(lineAt(lines, i))) i += 1;
  if (i < n) i += 1;
  while (i < n && (lineAt(lines, i).trim() === "" || isChrome(lineAt(lines, i)))) i += 1;
  const block: string[] = [];
  while (
    i < n &&
    lineAt(lines, i).trim() !== "" &&
    !lineAt(lines, i).replace(/^\s+/, "").startsWith("#")
  ) {
    let stripped = lineAt(lines, i).trim();
    if (stripped.startsWith(">")) stripped = stripped.replace(/^>+/, "").trim();
    if (stripped) block.push(stripped);
    i += 1;
  }
  return block.join(" ");
}

const REDIRECT_MARKERS = [
  "legacy alias",
  "superseded",
  "has been renamed",
  "has moved",
  "deprecated",
];

function isRedirectStub(md: string): boolean {
  const lines = splitLines(md);
  const n = lines.length;
  let i = 0;
  while (i < n && !H1_RE.test(lineAt(lines, i))) i += 1;
  if (i < n) i += 1;
  while (i < n && (lineAt(lines, i).trim() === "" || isChrome(lineAt(lines, i)))) i += 1;
  if (i >= n || !lineAt(lines, i).replace(/^\s+/, "").startsWith(">")) return false;
  const block: string[] = [];
  while (i < n && lineAt(lines, i).replace(/^\s+/, "").startsWith(">")) {
    block.push(lineAt(lines, i).replace(/^\s+/, "").replace(/^>+/, "").trim());
    i += 1;
  }
  const quote = block.join(" ").toLowerCase();
  return REDIRECT_MARKERS.some((marker) => quote.includes(marker));
}

const BANNER_OPEN = "<!-- AUTO-GENERATED by task packs:render";

function stripLeadingBanner(body: string): string {
  const lines = body.split("\n");
  const n = lines.length;
  let i = 0;
  while (i < n && lineAt(lines, i).trim() === "") i += 1;
  if (i < n && lineAt(lines, i).startsWith(BANNER_OPEN)) {
    while (i < n && lineAt(lines, i).replace(/^\s+/, "").startsWith("<!--")) i += 1;
    while (i < n && lineAt(lines, i).trim() === "") i += 1;
  }
  return lines.slice(i).join("\n");
}

const FRONTMATTER_RE = /^---\n([\s\S]*?\n)---\n?([\s\S]*)$/;

function splitFrontmatter(text: string): [string | null, string] {
  if (!text.startsWith("---\n")) return [null, text];
  const match = FRONTMATTER_RE.exec(text);
  if (!match) return [null, text];
  return [match[1] ?? "", match[2] ?? ""];
}

function foldBlock(blockLines: string[]): string {
  const paragraphs: string[] = [];
  let current: string[] = [];
  for (const line of blockLines) {
    if (line.trim() === "") {
      if (current.length) {
        paragraphs.push(current.join(" "));
        current = [];
      }
    } else {
      current.push(line.trim());
    }
  }
  if (current.length) paragraphs.push(current.join(" "));
  return paragraphs.join("\n");
}

const KEY_RE = /^([A-Za-z_][\w-]*):(.*)$/;
const BLOCK_INDICATORS = new Set([">", ">-", ">+", "|", "|-", "|+"]);

function isIndented(line: string): boolean {
  return line.startsWith(" ") || line.startsWith("\t");
}

function parseFrontmatterFields(frontmatter: string): Record<string, string> {
  const lines = frontmatter.split("\n");
  const fields: Record<string, string> = {};
  const n = lines.length;
  let i = 0;
  while (i < n) {
    const line = lineAt(lines, i);
    const match = KEY_RE.exec(line);
    if (!match || isIndented(line)) {
      i += 1;
      continue;
    }
    const key = match[1] ?? "";
    const value = (match[2] ?? "").trim();
    if (BLOCK_INDICATORS.has(value)) {
      const block: string[] = [];
      i += 1;
      while (i < n) {
        const nxt = lineAt(lines, i);
        if (nxt.trim() === "") {
          block.push("");
          i += 1;
          continue;
        }
        if (isIndented(nxt)) {
          block.push(nxt);
          i += 1;
          continue;
        }
        break;
      }
      fields[key] = foldBlock(block);
      continue;
    }
    if (value === "" || value.startsWith("- ")) {
      i += 1;
      while (
        i < n &&
        (lineAt(lines, i).replace(/^\s+/, "").startsWith("- ") || isIndented(lineAt(lines, i)))
      ) {
        i += 1;
      }
      if (!(key in fields)) fields[key] = "";
      continue;
    }
    fields[key] = pyStrip(pyStrip(value, '"'), "'");
    i += 1;
  }
  return fields;
}

function extractExtraFrontmatter(frontmatter: string): string | null {
  const lines = frontmatter.split("\n");
  const extra: string[] = [];
  const n = lines.length;
  let i = 0;
  while (i < n) {
    const line = lineAt(lines, i);
    const match = KEY_RE.exec(line);
    if (!match || isIndented(line)) {
      i += 1;
      continue;
    }
    const key = match[1] ?? "";
    const value = (match[2] ?? "").trim();
    const block: string[] = [line];
    i += 1;
    if (BLOCK_INDICATORS.has(value)) {
      while (i < n && (lineAt(lines, i).trim() === "" || isIndented(lineAt(lines, i)))) {
        block.push(lineAt(lines, i));
        i += 1;
      }
    } else if (value === "" || value.startsWith("- ")) {
      while (
        i < n &&
        (lineAt(lines, i).replace(/^\s+/, "").startsWith("- ") || isIndented(lineAt(lines, i)))
      ) {
        block.push(lineAt(lines, i));
        i += 1;
      }
    }
    if (key !== "name" && key !== "description") extra.push(...block);
  }
  while (extra.length && (extra[extra.length - 1] ?? "").trim() === "") extra.pop();
  return extra.length ? extra.join("\n") : null;
}

// Skill trigger keywords are sourced from durable, post-#838 surfaces rather
// than the removed AGENTS.md "## Skill Routing" table (#838 / #2152). Priority:
//   1. each SKILL.md frontmatter `triggers:` list (the skill's own contract);
//   2. the REFERENCES.md "Skills Index" table (the #838 single source of truth).
// This decouples the skills pack from AGENTS.md, so adding a skill no longer
// requires editing the always-loaded policy file and the trigger map stays
// non-empty after #838 removed the heading parseRouting used to read.

const SKILLS_INDEX_HEADING_RE = /Skills Index/i;
const HEADING_LINE_RE = /^#{1,6}\s/;
const SKILL_LINK_RE = /\(([^)]*skills\/[^)]+\/SKILL\.md)\)/;
const BACKTICK_TOKEN_RE = /`([^`]+)`/g;

/** Normalize a REFERENCES.md skill link path to the `skills/<name>/SKILL.md` key. */
function normalizeSkillIndexPath(linkPath: string): string {
  let p = linkPath.trim();
  if (p.startsWith("./")) p = p.slice(2);
  const marker = p.indexOf("skills/");
  return marker >= 0 ? p.slice(marker) : p;
}

/**
 * Parse the REFERENCES.md "Skills Index" table into a `skills/<name>/SKILL.md`
 * -> triggers map. Skill rows are identified by their SKILL.md link (so the
 * header and separator rows are skipped); the trigger cell is the last
 * pipe-delimited column and its keywords are the backtick-quoted tokens.
 */
function parseSkillsIndexTriggers(referencesMd: string): Map<string, string[]> {
  const mapping = new Map<string, string[]>();
  let inSection = false;
  for (const raw of splitLines(referencesMd)) {
    const line = raw.trim();
    if (HEADING_LINE_RE.test(line)) {
      inSection = SKILLS_INDEX_HEADING_RE.test(line);
      continue;
    }
    if (!inSection || !line.startsWith("|")) continue;
    const linkMatch = SKILL_LINK_RE.exec(line);
    if (!linkMatch) continue;
    const path = normalizeSkillIndexPath(linkMatch[1] ?? "");
    const cells = line
      .split("|")
      .map((cell) => cell.trim())
      .filter((cell) => cell.length > 0);
    const triggerCell = cells[cells.length - 1] ?? "";
    const bucket = mapping.get(path) ?? [];
    for (const match of triggerCell.matchAll(BACKTICK_TOKEN_RE)) {
      const keyword = (match[1] ?? "").trim();
      if (keyword && !bucket.includes(keyword)) bucket.push(keyword);
    }
    if (bucket.length > 0) mapping.set(path, bucket);
  }
  return mapping;
}

// Split on quoted phrases (single or double) or bare comma-delimited runs, so a
// quoted trigger containing a comma (`["what's next, please", other]`) is not
// mis-tokenised. All shipped skills use the block-list form today; this keeps
// the inline flow-list form correct for future skills.
const FLOW_LIST_TOKEN_RE = /(?:"([^"]*)")|(?:'([^']*)')|([^,]+)/g;

/** Split an inline YAML flow list (`[a, "b"]`) into trimmed, unquoted tokens. */
function parseFlowListTokens(value: string): string[] {
  const inner = value.replace(/^\[/, "").replace(/\]$/, "");
  const out: string[] = [];
  for (const match of inner.matchAll(FLOW_LIST_TOKEN_RE)) {
    const token = (match[1] ?? match[2] ?? match[3] ?? "").trim();
    if (token) out.push(token);
  }
  return out;
}

/** Extract a `triggers:` list (block or inline flow form) from SKILL.md frontmatter. */
function parseFrontmatterTriggers(frontmatter: string): string[] {
  const lines = frontmatter.split("\n");
  const n = lines.length;
  for (let i = 0; i < n; i += 1) {
    const line = lineAt(lines, i);
    if (isIndented(line)) continue;
    const match = KEY_RE.exec(line);
    if (!match || (match[1] ?? "") !== "triggers") continue;
    const value = (match[2] ?? "").trim();
    if (value.startsWith("[")) return parseFlowListTokens(value);
    const out: string[] = [];
    let j = i + 1;
    while (j < n) {
      const nxt = lineAt(lines, j);
      if (nxt.trim() === "") {
        j += 1;
        continue;
      }
      if (!isIndented(nxt)) break;
      const item = nxt.trim();
      if (item.startsWith("- ")) {
        const token = pyStrip(pyStrip(item.slice(2).trim(), '"'), "'");
        if (token) out.push(token);
      }
      j += 1;
    }
    return out;
  }
  return [];
}

interface SkillEntry {
  id: string;
  description: string;
  triggers: string[];
  path: string;
  version: string;
  body: string | null;
  frontmatter_extra: string | null;
}

function buildSkillEntry(
  skillMd: string,
  skillsDir: string,
  indexTriggers: Map<string, string[]>,
  captureBody: boolean,
): SkillEntry | null {
  const text = readFileSync(skillMd, "utf8");
  const [frontmatter, body] = splitFrontmatter(text);
  if (frontmatter === null) return null;
  const fields = parseFrontmatterFields(frontmatter);
  const name = (fields.name ?? "").trim();
  if (!name) return null;
  const relPath = relPosix(dirname(resolve(skillsDir)), resolve(skillMd));
  // Prefer the skill's own frontmatter `triggers:` contract; fall back to the
  // REFERENCES.md Skills Index (#838 single source of truth) so shipped skills
  // that carry no frontmatter triggers still get a non-empty trigger list.
  const frontmatterTriggers = parseFrontmatterTriggers(frontmatter);
  const triggers =
    frontmatterTriggers.length > 0 ? frontmatterTriggers : (indexTriggers.get(relPath) ?? []);
  const version = (fields.version ?? "").trim() || DEFAULT_SKILL_VERSION;
  return {
    id: name,
    description: (fields.description ?? "").trim(),
    triggers,
    path: relPath,
    version,
    body: captureBody ? stripLeadingBanner(body) : null,
    frontmatter_extra: extractExtraFrontmatter(frontmatter),
  };
}

function buildSkillsPack(
  skillsDir: string,
  referencesMd: string,
  proofSkill: string | null,
): { pack: string; version: string; generated_from: string; skills: SkillEntry[] } {
  const indexTriggers = parseSkillsIndexTriggers(readFileSync(referencesMd, "utf8"));
  const captureAll = proofSkill === null;
  const proofPath = proofSkill !== null ? `skills/${proofSkill}/SKILL.md` : null;
  const base = dirname(resolve(skillsDir));
  const skills: SkillEntry[] = [];
  for (const skillMd of globSkillMd(skillsDir)) {
    const relPath = relPosix(base, resolve(skillMd));
    const entry = buildSkillEntry(
      skillMd,
      skillsDir,
      indexTriggers,
      captureAll || relPath === proofPath,
    );
    if (entry !== null) skills.push(entry);
  }
  return {
    pack: "skills-pack-0.1",
    version: PACK_VERSION,
    generated_from: "skills/*/SKILL.md frontmatter triggers + REFERENCES.md (Skills Index)",
    skills,
  };
}

const GLYPH_TIER: Record<string, string> = {
  "!": "MUST",
  "~": "SHOULD",
  [SHOULD_NOT_GLYPH]: "SHOULD_NOT",
  [MUST_NOT_GLYPH]: "MUST_NOT",
  "?": "MAY",
};

const MARKER_RE = new RegExp(
  `^\\s*(?:-\\s+)?([!~?${SHOULD_NOT_GLYPH}${MUST_NOT_GLYPH}])\\s+(\\S.*)$`,
);

const PROSE_TIERS: ReadonlyArray<readonly [string, string]> = [
  ["MUST NOT", "MUST_NOT"],
  ["SHOULD NOT", "SHOULD_NOT"],
  ["MUST", "MUST"],
  ["SHOULD", "SHOULD"],
  ["MAY", "MAY"],
];

function proseTier(text: string): string | null {
  for (const [keyword, tier] of PROSE_TIERS) {
    const pattern = new RegExp(`\\b${keyword.replace(/ /g, "[ ]")}\\b`);
    if (pattern.test(text)) return tier;
  }
  return null;
}

interface RuleEntry {
  id: string;
  tier: string;
  domain: string;
  text: string;
  path?: string;
  body?: string | null;
}

function parseRules(md: string, domain: string): RuleEntry[] {
  const rules: RuleEntry[] = [];
  let seq = 0;
  for (const raw of splitLines(md)) {
    const line = raw.replace(/\s+$/, "");
    let tier: string | null = null;
    let text = "";
    const marker = MARKER_RE.exec(line);
    if (marker) {
      tier = GLYPH_TIER[marker[1] ?? ""] ?? null;
      text = (marker[2] ?? "").trim();
    } else {
      const stripped = line.trim();
      if (!stripped.startsWith("- ")) continue;
      text = stripped.slice(2).trim();
      tier = text ? proseTier(text) : null;
    }
    if (tier === null || text === "") continue;
    seq += 1;
    rules.push({ id: `${domain}-${String(seq).padStart(3, "0")}`, tier, domain, text });
  }
  return rules;
}

const MANAGED_SECTION_RE =
  /<!--\s*deft:managed-section[\s\S]*?<!--\s*\/deft:managed-section\s*-->/g;

function stripManagedSection(md: string): string {
  return md.replace(MANAGED_SECTION_RE, "");
}

function buildRulesPack(
  codingDir: string,
  extraSources: string[],
): { pack: string; version: string; generated_from: string; rules: RuleEntry[] } {
  const base = dirname(resolve(codingDir));
  const rules: RuleEntry[] = [];
  for (const md of globMd(codingDir)) {
    const relPath = relPosix(base, resolve(md));
    const domain = slugify(stemOf(md));
    const text = readFileSync(md, "utf8");
    const docRules = parseRules(text, domain);
    docRules.forEach((rule, idx) => {
      rule.path = relPath;
      rule.body = idx === 0 ? stripLeadingBanner(text) : null;
      rules.push(rule);
    });
  }
  for (const src of extraSources) {
    if (!isFileSafe(src)) continue;
    const candidate = relPosix(base, resolve(src));
    const relPath = candidate.startsWith("..") || isAbsolute(candidate) ? basename(src) : candidate;
    const domain = slugify(stemOf(src));
    let text = readFileSync(src, "utf8");
    if (basename(src) === "AGENTS.md") text = stripManagedSection(text);
    for (const rule of parseRules(text, domain)) {
      rule.path = relPath;
      rule.body = null;
      rules.push(rule);
    }
  }
  return {
    pack: "rules-pack-0.1",
    version: PACK_VERSION,
    generated_from:
      "coding/*.md + AGENTS.md + main.md (marker-prefixed RFC2119 directives; " +
      "AGENTS.md managed-section excluded; coding bodies rendered, " +
      "AGENTS.md/main.md metadata-only)",
    rules,
  };
}

interface MdEntry {
  id: string;
  title: string;
  description: string;
  triggers: string[];
  path: string;
  body: string | null;
}

function buildMdEntry(md: string, dir: string, captureBody: boolean): MdEntry {
  const relPath = relPosix(dirname(resolve(dir)), resolve(md));
  const stemSlug = slugify(stemOf(md));
  const text = readFileSync(md, "utf8");
  return {
    id: stemSlug,
    title: extractTitle(text),
    description: extractDescription(text),
    triggers: stemSlug ? [stemSlug] : [],
    path: relPath,
    body: captureBody ? stripLeadingBanner(text) : null,
  };
}

function buildStrategiesPack(
  strategiesDir: string,
  proofStrategy: string | null,
): { pack: string; version: string; generated_from: string; strategies: MdEntry[] } {
  const base = dirname(resolve(strategiesDir));
  const captureAll = proofStrategy === null;
  const strategies: MdEntry[] = [];
  for (const md of globMd(strategiesDir)) {
    const relPath = relPosix(base, resolve(md));
    const captureBody = captureAll
      ? !isRedirectStub(readFileSync(md, "utf8"))
      : relPath === proofStrategy;
    strategies.push(buildMdEntry(md, strategiesDir, captureBody));
  }
  return {
    pack: "strategies-pack-0.1",
    version: PACK_VERSION,
    generated_from: "strategies/*.md",
    strategies,
  };
}

function buildPatternsPack(
  patternsDir: string,
  proofPattern: string,
): { pack: string; version: string; generated_from: string; patterns: MdEntry[] } {
  const base = dirname(resolve(patternsDir));
  const patterns: MdEntry[] = [];
  for (const md of globMd(patternsDir)) {
    const relPath = relPosix(base, resolve(md));
    patterns.push(buildMdEntry(md, patternsDir, relPath === proofPattern));
  }
  return {
    pack: "patterns-pack-0.1",
    version: PACK_VERSION,
    generated_from: "patterns/*.md",
    patterns,
  };
}

function buildSwarmSpecPack(
  swarmDir: string,
  proofEntry: string,
): { pack: string; version: string; generated_from: string; entries: MdEntry[] } {
  const base = dirname(resolve(swarmDir));
  const entries: MdEntry[] = [];
  for (const md of globMd(swarmDir)) {
    const relPath = relPosix(base, resolve(md));
    entries.push(buildMdEntry(md, swarmDir, relPath === proofEntry));
  }
  return {
    pack: "swarm-spec-pack-0.1",
    version: PACK_VERSION,
    generated_from: "swarm/*.md",
    entries,
  };
}

function writePack(out: string, pack: unknown): void {
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, dumpsAsciiJson(pack), "utf8");
}

/** Resolve the shippable content root: <root>/content when present, else <root> (#1875). */
function resolveContentRoot(): string {
  const root = resolveDeftRoot();
  const candidate = join(root, "content");
  return isDirSafe(candidate) ? candidate : root;
}

interface ParsedPackArgs {
  values: Record<string, string>;
  lists: Record<string, string[]>;
  error?: string;
}

/**
 * Minimal argparse-compatible option reader supporting `--flag value` and
 * `--flag=value`. `listFlags` accumulate repeats; all flags take a value.
 */
function parsePackArgs(
  argv: readonly string[],
  valueFlags: readonly string[],
  listFlags: readonly string[] = [],
): ParsedPackArgs {
  const values: Record<string, string> = {};
  const lists: Record<string, string[]> = {};
  const known = new Set([...valueFlags, ...listFlags]);
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === undefined) continue;
    let flag = arg;
    let inlineValue: string | undefined;
    if (arg.startsWith("--") && arg.includes("=")) {
      const eq = arg.indexOf("=");
      flag = arg.slice(0, eq);
      inlineValue = arg.slice(eq + 1);
    }
    if (!known.has(flag)) {
      return { values, lists, error: `unrecognized argument: ${arg}` };
    }
    let value: string | undefined = inlineValue;
    if (value === undefined) {
      i += 1;
      value = argv[i];
    }
    if (value === undefined) {
      return { values, lists, error: `argument ${flag}: expected one argument` };
    }
    if (listFlags.includes(flag)) {
      const bucket = lists[flag] ?? [];
      bucket.push(value);
      lists[flag] = bucket;
    } else {
      values[flag] = value;
    }
  }
  return { values, lists };
}

function runPackMigrateSkills(argv: string[], io: DispatchIo): number {
  const contentRoot = resolveContentRoot();
  const parsed = parsePackArgs(argv, ["--skills-dir", "--references-md", "--proof-skill", "--out"]);
  if (parsed.error !== undefined) {
    io.writeErr(`error: ${parsed.error}\n`);
    return 2;
  }
  const skillsDir = parsed.values["--skills-dir"] ?? join(contentRoot, "skills");
  const referencesMd = parsed.values["--references-md"] ?? join(resolveDeftRoot(), "REFERENCES.md");
  const proofSkill = parsed.values["--proof-skill"] ?? null;
  const out =
    parsed.values["--out"] ?? join(contentRoot, "packs", "skills", "skills-pack-0.1.json");

  if (!isDirSafe(skillsDir)) {
    io.writeErr(`error: skills directory not found: ${skillsDir}\n`);
    return 1;
  }
  if (!isFileSafe(referencesMd)) {
    io.writeErr(`error: REFERENCES.md not found: ${referencesMd}\n`);
    return 1;
  }
  const pack = buildSkillsPack(skillsDir, referencesMd, proofSkill);
  if (pack.skills.length === 0) {
    io.writeErr(`error: no skills with frontmatter discovered under ${skillsDir}\n`);
    return 1;
  }
  writePack(out, pack);
  const bodied = pack.skills.filter((s) => s.body !== null).length;
  io.writeOut(`Migrated ${pack.skills.length} skills (${bodied} with body) -> ${out}\n`);
  return 0;
}

function runPackMigrateRules(argv: string[], io: DispatchIo): number {
  const contentRoot = resolveContentRoot();
  const deftRoot = resolveDeftRoot();
  const parsed = parsePackArgs(argv, ["--coding-dir", "--out"], ["--extra-source"]);
  if (parsed.error !== undefined) {
    io.writeErr(`error: ${parsed.error}\n`);
    return 2;
  }
  const codingDir = parsed.values["--coding-dir"] ?? join(contentRoot, "coding");
  const extraSources = parsed.lists["--extra-source"] ?? [
    join(deftRoot, "AGENTS.md"),
    join(deftRoot, "main.md"),
  ];
  const out = parsed.values["--out"] ?? join(contentRoot, "packs", "rules", "rules-pack-0.1.json");

  if (!isDirSafe(codingDir)) {
    io.writeErr(`error: coding directory not found: ${codingDir}\n`);
    return 1;
  }
  const pack = buildRulesPack(codingDir, extraSources);
  if (pack.rules.length === 0) {
    io.writeErr(`error: no directives discovered under ${codingDir}\n`);
    return 1;
  }
  writePack(out, pack);
  const bodied = pack.rules.filter((r) => r.body != null).length;
  io.writeOut(`Migrated ${pack.rules.length} rules (${bodied} with body) -> ${out}\n`);
  return 0;
}

function runPackMigrateStrategies(argv: string[], io: DispatchIo): number {
  const contentRoot = resolveContentRoot();
  const parsed = parsePackArgs(argv, ["--strategies-dir", "--proof-strategy", "--out"]);
  if (parsed.error !== undefined) {
    io.writeErr(`error: ${parsed.error}\n`);
    return 2;
  }
  const strategiesDir = parsed.values["--strategies-dir"] ?? join(contentRoot, "strategies");
  const proofStrategy = parsed.values["--proof-strategy"] ?? null;
  const out =
    parsed.values["--out"] ?? join(contentRoot, "packs", "strategies", "strategies-pack-0.1.json");

  if (!isDirSafe(strategiesDir)) {
    io.writeErr(`error: strategies directory not found: ${strategiesDir}\n`);
    return 1;
  }
  const pack = buildStrategiesPack(strategiesDir, proofStrategy);
  if (pack.strategies.length === 0) {
    io.writeErr(`error: no strategies discovered under ${strategiesDir}\n`);
    return 1;
  }
  writePack(out, pack);
  const bodied = pack.strategies.filter((s) => s.body !== null).length;
  io.writeOut(`Migrated ${pack.strategies.length} strategies (${bodied} with body) -> ${out}\n`);
  return 0;
}

function runPackMigratePatterns(argv: string[], io: DispatchIo): number {
  const contentRoot = resolveContentRoot();
  const parsed = parsePackArgs(argv, ["--patterns-dir", "--proof-pattern", "--out"]);
  if (parsed.error !== undefined) {
    io.writeErr(`error: ${parsed.error}\n`);
    return 2;
  }
  const patternsDir = parsed.values["--patterns-dir"] ?? join(contentRoot, "patterns");
  const proofPattern = parsed.values["--proof-pattern"] ?? "patterns/multi-agent.md";
  const out =
    parsed.values["--out"] ?? join(contentRoot, "packs", "patterns", "patterns-pack-0.1.json");

  if (!isDirSafe(patternsDir)) {
    io.writeErr(`error: patterns directory not found: ${patternsDir}\n`);
    return 1;
  }
  const pack = buildPatternsPack(patternsDir, proofPattern);
  if (pack.patterns.length === 0) {
    io.writeErr(`error: no patterns discovered under ${patternsDir}\n`);
    return 1;
  }
  writePack(out, pack);
  const bodied = pack.patterns.filter((p) => p.body !== null).length;
  io.writeOut(`Migrated ${pack.patterns.length} patterns (${bodied} with body) -> ${out}\n`);
  return 0;
}

function runPackMigrateSwarmSpec(argv: string[], io: DispatchIo): number {
  const contentRoot = resolveContentRoot();
  const parsed = parsePackArgs(argv, ["--swarm-dir", "--proof-entry", "--out"]);
  if (parsed.error !== undefined) {
    io.writeErr(`error: ${parsed.error}\n`);
    return 2;
  }
  const swarmDir = parsed.values["--swarm-dir"] ?? join(contentRoot, "swarm");
  const proofEntry = parsed.values["--proof-entry"] ?? "swarm/swarm.md";
  const out =
    parsed.values["--out"] ?? join(contentRoot, "packs", "swarm-spec", "swarm-spec-pack-0.1.json");

  if (!isDirSafe(swarmDir)) {
    io.writeErr(`error: swarm directory not found: ${swarmDir}\n`);
    return 1;
  }
  const pack = buildSwarmSpecPack(swarmDir, proofEntry);
  if (pack.entries.length === 0) {
    io.writeErr(`error: no swarm-spec docs discovered under ${swarmDir}\n`);
    return 1;
  }
  writePack(out, pack);
  const bodied = pack.entries.filter((e) => e.body !== null).length;
  io.writeOut(
    `Migrated ${pack.entries.length} swarm-spec entries (${bodied} with body) -> ${out}\n`,
  );
  return 0;
}

// ===========================================================================
// Native setup:ghx handler (#2022 Phase 1; #2178 download-verify-execute).
//
// Port of scripts/setup_ghx.py to native TypeScript: consent-gated ghx proxy
// installer with three-state exit (0 ok / 1 install failure / 2 config error).
//
// #2178: the installer no longer pipes remote bytes straight into a shell
// (`curl | bash` / `irm | iex`). Socket Security's AI-malware heuristic flags
// exactly that live-pipe-with-no-integrity-check pattern and blocks every
// consumer PR that bumps @deftai/directive (Socket scored the package ~65%
// likely malicious, severity 0.78 -- seen on deftai/evolution#1046 / #1047).
// Instead: download the installer script to memory, verify it against a
// SHA-256 vendored below, write it to a private local temp file, and only
// then execute that local file directly. The fetch URL also pins to the
// immutable commit SHA that GHX_VERSION resolved to at vendor time (not the
// mutable tag name), so a future tag force-move on the upstream repo cannot
// swap the fetched bytes out from under the vendored hash without also
// failing the hash check.
//
// Bumping GHX_VERSION (`.github/workflows/ci.yml` env.GHX_VERSION MUST stay
// in lockstep):
//   1. Resolve the new tag's commit SHA:
//        gh api repos/brunoborges/ghx/git/refs/tags/<new-version>
//      Use `object.sha`. If `object.type` is "tag" (an annotated tag, not a
//      lightweight one), resolve one level further:
//        gh api repos/brunoborges/ghx/git/tags/<object.sha>
//      and use THAT response's `object.sha` (the commit, not the tag object).
//   2. Refetch both installers at the resolved commit and recompute hashes:
//        curl -fsSL https://raw.githubusercontent.com/brunoborges/ghx/<sha>/install.sh  | sha256sum
//        curl -fsSL https://raw.githubusercontent.com/brunoborges/ghx/<sha>/install.ps1 | sha256sum
//   3. Update GHX_VERSION, GHX_COMMIT_SHA, GHX_INSTALL_SH_SHA256, and
//      GHX_INSTALL_PS1_SHA256 below IN THE SAME COMMIT as the matching
//      `.github/workflows/ci.yml` env values -- never let the two drift.
// ===========================================================================

/** Pinned ghx version (display only) — keep in lockstep with .github/workflows/ci.yml env.GHX_VERSION. */
export const GHX_VERSION = "v1.5.1";

/**
 * Immutable commit SHA the GHX_VERSION tag resolved to at vendor time
 * (2026-07-02, via `gh api repos/brunoborges/ghx/git/refs/tags/v1.5.1`).
 * Fetch URLs pin to this SHA rather than the mutable tag name so a future
 * tag force-move on brunoborges/ghx cannot silently swap the fetched bytes
 * out from under the vendored SHA-256 hashes below (#2178).
 */
export const GHX_COMMIT_SHA = "aa4a2786660e27392b0d3e8886f140e0a0261a0c";

export const INSTALL_PS1_URL = `https://raw.githubusercontent.com/brunoborges/ghx/${GHX_COMMIT_SHA}/install.ps1`;
export const INSTALL_SH_URL = `https://raw.githubusercontent.com/brunoborges/ghx/${GHX_COMMIT_SHA}/install.sh`;

/**
 * SHA-256 of the installer scripts at GHX_COMMIT_SHA, vendored so the
 * download-verify-execute pipeline below can refuse to run tampered bytes.
 * Matches `.github/workflows/ci.yml` env.GHX_INSTALL_SH_SHA256 /
 * GHX_INSTALL_PS1_SHA256 (#1070 / #1328) — keep both in lockstep (#2178).
 */
export const GHX_INSTALL_SH_SHA256 =
  "08c768feb6d2bc485079898f7e76c2b07576cbb1188a356acf99dac0fc55d1cb";
export const GHX_INSTALL_PS1_SHA256 =
  "5f67eab68970ecc55bb0fc1b8399ba6f3ce4b2aadeee39255d628e96d187a5ed";

export type SetupGhxHost = "windows" | "darwin" | "linux" | string;

/** Downloads a URL and resolves to its raw bytes. Injectable so tests never hit the network. */
export type GhxDownloadFn = (url: string) => Promise<Buffer>;

async function defaultGhxDownload(url: string): Promise<Buffer> {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`download failed: HTTP ${res.status} ${res.statusText} for ${url}`);
  }
  return Buffer.from(await res.arrayBuffer());
}

/** True when `buf`'s SHA-256 (hex) matches `expectedHex`, case- and whitespace-insensitive. */
export function verifyGhxSha256(buf: Buffer, expectedHex: string): boolean {
  const actual = createHash("sha256").update(buf).digest("hex");
  return actual.toLowerCase() === expectedHex.trim().toLowerCase();
}

export interface GhxInstallerAsset {
  url: string;
  sha256: string;
  fileExt: "sh" | "ps1";
}

export function resolveGhxInstallerAsset(host: SetupGhxHost): GhxInstallerAsset {
  if (host === "windows") {
    return { url: INSTALL_PS1_URL, sha256: GHX_INSTALL_PS1_SHA256, fileExt: "ps1" };
  }
  if (host === "darwin" || host === "linux") {
    return { url: INSTALL_SH_URL, sha256: GHX_INSTALL_SH_SHA256, fileExt: "sh" };
  }
  throw new Error(
    `no upstream ghx installer available for host '${host}'; ` +
      "see https://github.com/brunoborges/ghx#install for manual options",
  );
}

export interface SetupGhxDeps {
  whichFn?: WhichFn;
  readConsentLine?: () => string;
  runInstall?: (host: SetupGhxHost) => number | Promise<number>;
  downloadFn?: GhxDownloadFn;
  runner?: typeof spawnSync;
}

interface SetupGhxArgs {
  yes: boolean;
  check: boolean;
  error?: string;
}

function parseSetupGhxArgs(argv: readonly string[]): SetupGhxArgs {
  let yes = false;
  let check = false;
  for (const arg of argv) {
    if (arg === "--yes") {
      yes = true;
    } else if (arg === "--check") {
      check = true;
    } else {
      return { yes, check, error: `unrecognized argument: ${arg}` };
    }
  }
  return { yes, check };
}

export function ghxPresent(whichFn: WhichFn = defaultWhich): boolean {
  return whichFn("ghx") !== null;
}

export function detectSetupGhxHost(): SetupGhxHost {
  if (process.platform === "win32") return "windows";
  if (process.platform === "darwin") return "darwin";
  if (process.platform === "linux") return "linux";
  return process.platform;
}

function readConsentLineFromStdin(): string {
  const buf = Buffer.alloc(256);
  try {
    const n = readSync(0, buf, 0, 256, null);
    if (n === null || n <= 0) return "";
    return buf.toString("utf8", 0, n);
  } catch {
    return "";
  }
}

export function promptSetupGhxConsent(
  io: DispatchIo,
  readLine: () => string = readConsentLineFromStdin,
): boolean {
  io.writeOut(
    "\n[setup_ghx] ghx is the recommended GitHub CLI cache proxy for deft " +
      "maintainers (prevents rate-limiting in multi-agent swarms; speeds up " +
      "scm:* calls). Consumer projects only require gh.\n",
  );
  io.writeOut(`[setup_ghx] Upstream: https://github.com/brunoborges/ghx (${GHX_VERSION})\n`);
  io.writeOut("[setup_ghx] Install ghx via the upstream installer? [y/N]: ");
  const answer = readLine().trim().toLowerCase();
  return answer === "y" || answer === "yes";
}

function ghxTempFileName(fileExt: "sh" | "ps1"): string {
  return `ghx-install-${GHX_VERSION}.${fileExt}`;
}

/**
 * Downloads `asset`, verifies it against its vendored SHA-256, and writes it
 * to a private local temp file. Returns the local path, ready for direct
 * local-file execution (never piped into a shell). Throws -- without
 * writing or executing anything -- on a hash mismatch (#2178). Split out
 * from `fetchAndVerifyGhxInstaller` so tests can exercise the download ->
 * verify -> write pipeline against a synthetic asset/hash without depending
 * on the real vendored constants or the network.
 */
export async function fetchAndVerifyGhxInstallerAsset(
  asset: GhxInstallerAsset,
  downloadFn: GhxDownloadFn = defaultGhxDownload,
): Promise<string> {
  const bytes = await downloadFn(asset.url);
  if (!verifyGhxSha256(bytes, asset.sha256)) {
    const actual = createHash("sha256").update(bytes).digest("hex");
    throw new Error(
      `ghx installer SHA-256 mismatch for ${asset.url} ` +
        `(expected ${asset.sha256}, got ${actual}); refusing to execute. ` +
        "The pinned commit's bytes may have changed, or the download was tampered with.",
    );
  }
  const dir = mkdtempSync(join(tmpdir(), "deft-ghx-"));
  const installerPath = join(dir, ghxTempFileName(asset.fileExt));
  writeFileSync(installerPath, bytes, { mode: 0o700 });
  return installerPath;
}

/**
 * Downloads the pinned installer for `host`, verifies it against the
 * vendored SHA-256, and writes it to a private local temp file. Returns the
 * local path, ready for direct local-file execution (never piped into a
 * shell). Throws -- without writing or executing anything -- on a hash
 * mismatch (#2178).
 */
export async function fetchAndVerifyGhxInstaller(
  host: SetupGhxHost,
  downloadFn: GhxDownloadFn = defaultGhxDownload,
): Promise<string> {
  return fetchAndVerifyGhxInstallerAsset(resolveGhxInstallerAsset(host), downloadFn);
}

/**
 * Executes an already-downloaded, hash-verified installer from its local
 * temp path. No live pipe (`curl | bash` / `irm | iex`) and no
 * `-ExecutionPolicy Bypass` -- the file is written by Node, so it never
 * carries a Windows Mark-of-the-Web zone identifier the way a browser or
 * `Invoke-WebRequest` download would; `RemoteSigned` treats it as a local,
 * unsigned-but-trusted script (#2178).
 */
export function executeVerifiedGhxInstaller(
  host: SetupGhxHost,
  installerPath: string,
  whichFn: WhichFn = defaultWhich,
  runner: typeof spawnSync = spawnSync,
): number {
  const cmd =
    host === "windows"
      ? [
          whichFn("pwsh") ?? whichFn("powershell") ?? "powershell",
          "-NoProfile",
          "-ExecutionPolicy",
          "RemoteSigned",
          "-File",
          installerPath,
        ]
      : ["bash", installerPath];
  const proc = runner(cmd[0] ?? "", cmd.slice(1), {
    env: { ...process.env, GHX_VERSION },
    stdio: "inherit",
  });
  return proc.status ?? 1;
}

/**
 * Downloads, hash-verifies, and executes `asset` for `host`. Cleans up the
 * temp file (and its containing directory) regardless of outcome. Split out
 * from `installSetupGhx` so tests can exercise the full download -> verify
 * -> execute -> cleanup pipeline against a synthetic asset without depending
 * on the real vendored constants or the network (#2178).
 */
export async function installVerifiedGhxAsset(
  asset: GhxInstallerAsset,
  host: SetupGhxHost,
  whichFn: WhichFn = defaultWhich,
  runner: typeof spawnSync = spawnSync,
  downloadFn: GhxDownloadFn = defaultGhxDownload,
): Promise<number> {
  const installerPath = await fetchAndVerifyGhxInstallerAsset(asset, downloadFn);
  try {
    return executeVerifiedGhxInstaller(host, installerPath, whichFn, runner);
  } finally {
    try {
      rmSync(dirname(installerPath), { recursive: true, force: true });
    } catch {
      // Best-effort cleanup; a leftover temp file is not fatal.
    }
  }
}

/**
 * Downloads, hash-verifies, and executes the ghx installer for `host`.
 * Cleans up the temp file (and its containing directory) regardless of
 * outcome (#2178).
 */
export async function installSetupGhx(
  host: SetupGhxHost,
  whichFn: WhichFn = defaultWhich,
  runner: typeof spawnSync = spawnSync,
  downloadFn: GhxDownloadFn = defaultGhxDownload,
): Promise<number> {
  return installVerifiedGhxAsset(resolveGhxInstallerAsset(host), host, whichFn, runner, downloadFn);
}

/** Native `setup:ghx` handler (replaces scripts/setup_ghx.py shell-out, #2022 Phase 1). */
export async function runSetupGhx(
  argv: string[],
  io: DispatchIo,
  deps: SetupGhxDeps = {},
): Promise<number> {
  const args = parseSetupGhxArgs(argv);
  if (args.error !== undefined) {
    io.writeErr(`setup-ghx: ${args.error}\n`);
    return 2;
  }

  if (args.yes && args.check) {
    io.writeErr("[setup_ghx] error: --yes and --check are mutually exclusive.\n");
    return 2;
  }

  const whichFn = deps.whichFn ?? defaultWhich;

  if (ghxPresent(whichFn)) {
    io.writeOut("[setup_ghx] ghx already on PATH -- skipping install.\n");
    return 0;
  }

  if (args.check) {
    if (whichFn("gh") !== null) {
      io.writeOut(
        "[setup_ghx] gh is on PATH but ghx is not; ghx is the recommended GitHub CLI " +
          "cache proxy. Install with `directive setup:ghx` (or `task setup:ghx`). Refs #884.\n",
      );
    } else {
      io.writeOut(
        "[setup_ghx] ghx not on PATH; recommended for speed -- run `directive setup:ghx` " +
          "to opt in. Consumer projects only require gh. Refs #884.\n",
      );
    }
    return 0;
  }

  let consent: boolean;
  if (args.yes) {
    consent = true;
    io.writeOut("[setup_ghx] --yes provided; skipping interactive consent prompt.\n");
  } else {
    const skip = (process.env.DEFT_SETUP_GHX_SKIP ?? "").trim();
    if (skip === "1" || skip.toLowerCase() === "true" || skip.toLowerCase() === "yes") {
      io.writeOut("[setup_ghx] DEFT_SETUP_GHX_SKIP set; skipping ghx install. Refs #884.\n");
      return 0;
    }
    const readLine = deps.readConsentLine ?? readConsentLineFromStdin;
    consent = promptSetupGhxConsent(io, readLine);
  }

  if (!consent) {
    io.writeOut(
      "[setup_ghx] Skipping ghx install. ghx is recommended for speed for maintainers and " +
        "swarm runs; consumer projects only require gh " +
        "(see https://github.com/brunoborges/ghx, #884).\n",
    );
    return 0;
  }

  const host = detectSetupGhxHost();
  const runInstall =
    deps.runInstall ??
    ((h: SetupGhxHost) => installSetupGhx(h, whichFn, deps.runner, deps.downloadFn));
  try {
    const rc = await runInstall(host);
    if (rc !== 0) {
      io.writeErr(
        `[setup_ghx] error: upstream installer exited ${rc}. ` +
          "See https://github.com/brunoborges/ghx#install for manual options.\n",
      );
      return 1;
    }
    io.writeOut(
      "[setup_ghx] ghx installed. Open a fresh shell so the updated PATH takes effect, " +
        "then re-run `task setup` to verify.\n",
    );
    return 0;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    io.writeErr(`[setup_ghx] error: ${message}\n`);
    return 1;
  }
}

// ===========================================================================
// Native directive bootstrap launcher (#2022 Phase 4).
//
// Thin operator entry: deposit-if-absent, carry phase intent + deliberate
// re-entry signal, then hand off to deft-directive-setup (agent-driven).
// ===========================================================================

export const SETUP_SKILL_REL_PATH = ".deft/core/skills/deft-directive-setup/SKILL.md";

export type BootstrapPhaseLabel = "user" | "project" | "spec";
export type BootstrapReEntry = "none" | "prompt" | "reconfigure" | "force";

export interface DirectiveBootstrapArgs {
  projectRoot: string;
  jumpProject: boolean;
  strategy: string | null;
  reconfigure: boolean;
  force: boolean;
  json: boolean;
  error?: string;
}

export interface DirectiveBootstrapPlan {
  phase: 1 | 2 | 3;
  phaseLabel: BootstrapPhaseLabel;
  reEntry: BootstrapReEntry;
  strategy: string | null;
}

export interface DirectiveBootstrapHandoff {
  handoff: "deft-directive-setup";
  skill_path: string;
  project_root: string;
  deposited: boolean;
  phase: 1 | 2 | 3;
  phase_label: BootstrapPhaseLabel;
  re_entry: BootstrapReEntry;
  strategy: string | null;
}

export interface DirectiveBootstrapDeps {
  deftCorePresent?: (projectRoot: string) => boolean;
  userMdPresent?: (projectRoot: string) => boolean;
  projectDefPresent?: (projectRoot: string) => boolean;
  runInitDeposit?: (projectRoot: string, io: DispatchIo) => Promise<number>;
}

function bootstrapPhaseLabel(phase: 1 | 2 | 3): BootstrapPhaseLabel {
  if (phase === 1) return "user";
  if (phase === 2) return "project";
  return "spec";
}

/**
 * Bootstrap USER.md path resolver (#2271). Delegates to the shared first-hit-
 * wins resolver so the CLI bootstrap, session-start, and doctor share one
 * source of truth. DEFT_USER_PATH precedence is preserved by the shared
 * resolver (rung 1). `projectRoot` scopes the workspace-local rung so a bridged
 * `<projectRoot>/.deft/USER.md` resolves without a manual DEFT_USER_PATH.
 */
function resolveBootstrapUserMdPath(projectRoot?: string): string {
  return userConfig.resolveUserMdPath(projectRoot !== undefined ? { projectRoot } : {}).path;
}

function defaultBootstrapDeps(): Required<DirectiveBootstrapDeps> {
  return {
    deftCorePresent: (projectRoot) => isDirSafe(join(resolve(projectRoot), ".deft", "core")),
    userMdPresent: (projectRoot) => isFileSafe(resolveBootstrapUserMdPath(projectRoot)),
    projectDefPresent: (projectRoot) => isFileSafe(projectDefinitionPath(projectRoot)),
    runInitDeposit: async (projectRoot, io) => {
      const initArgs = parseInitArgv(["--yes", "--repo-root", projectRoot, "--json"], []);
      return runInitDepositCli({
        ...initArgs,
        writeOut: io.writeOut,
        writeErr: io.writeErr,
      });
    },
  };
}

/** Parse `directive bootstrap` argv (#2022 Phase 4). */
export function parseDirectiveBootstrapArgs(argv: readonly string[]): DirectiveBootstrapArgs {
  let projectRoot = ".";
  let jumpProject = false;
  let strategy: string | null = null;
  let reconfigure = false;
  let force = false;
  let json = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--project") {
      jumpProject = true;
    } else if (arg === "--reconfigure") {
      reconfigure = true;
    } else if (arg === "--force") {
      force = true;
    } else if (arg === "--json") {
      json = true;
    } else if (arg === "--project-root") {
      const value = argv[i + 1];
      if (value === undefined) {
        return {
          projectRoot,
          jumpProject,
          strategy,
          reconfigure,
          force,
          json,
          error: "argument --project-root: expected one argument",
        };
      }
      projectRoot = value;
      i += 1;
    } else if (arg?.startsWith("--project-root=")) {
      projectRoot = arg.slice("--project-root=".length);
    } else if (arg === "--strategy") {
      const value = argv[i + 1];
      if (value === undefined) {
        return {
          projectRoot,
          jumpProject,
          strategy,
          reconfigure,
          force,
          json,
          error: "argument --strategy: expected one argument",
        };
      }
      strategy = value;
      i += 1;
    } else if (arg?.startsWith("--strategy=")) {
      strategy = arg.slice("--strategy=".length);
    } else if (arg === "--help" || arg === "-h") {
      return {
        projectRoot,
        jumpProject,
        strategy,
        reconfigure,
        force,
        json,
        error: "__help__",
      };
    } else {
      return {
        projectRoot,
        jumpProject,
        strategy,
        reconfigure,
        force,
        json,
        error: `unrecognized argument: ${arg}`,
      };
    }
  }

  return {
    projectRoot: resolve(projectRoot),
    jumpProject,
    strategy,
    reconfigure,
    force,
    json,
  };
}

/** Resolve phase intent and deliberate re-entry signal from parsed args + on-disk state. */
export function resolveDirectiveBootstrapPlan(
  args: DirectiveBootstrapArgs,
  deps: Required<DirectiveBootstrapDeps>,
): DirectiveBootstrapPlan {
  let phase: 1 | 2 | 3;
  if (args.jumpProject) {
    phase = 2;
  } else if (args.strategy !== null) {
    phase = 3;
  } else if (!deps.userMdPresent(args.projectRoot)) {
    phase = 1;
  } else if (!deps.projectDefPresent(args.projectRoot)) {
    phase = 2;
  } else {
    phase = 3;
  }

  let reEntry: BootstrapReEntry = "none";
  if (args.force) {
    reEntry = "force";
  } else if (args.reconfigure) {
    reEntry = "reconfigure";
  } else {
    const artifactExists =
      phase === 1
        ? deps.userMdPresent(args.projectRoot)
        : phase === 2
          ? deps.projectDefPresent(args.projectRoot)
          : deps.projectDefPresent(args.projectRoot);
    if (artifactExists) {
      reEntry = "prompt";
    }
  }

  return {
    phase,
    phaseLabel: bootstrapPhaseLabel(phase),
    reEntry,
    strategy: args.strategy,
  };
}

function printDirectiveBootstrapHelp(io: DispatchIo): void {
  io.writeOut(
    "Usage: directive bootstrap [--project-root <path>] [--project] [--strategy <name>] [--reconfigure] [--force] [--json]\n\n" +
      "Deposit the framework when absent, then hand off to deft-directive-setup.\n\n" +
      "  --project       Jump to Phase 2 (project configuration)\n" +
      "  --strategy      Jump to Phase 3 (scope vBRIEF / spec interview)\n" +
      "  --reconfigure   Deliberate re-entry — agent should reconfigure existing artifacts\n" +
      "  --force         Skip reconfigure-or-keep prompt; overwrite allowed\n" +
      "  --json          Emit structured handoff JSON on stdout\n",
  );
}

function emitBootstrapHandoff(
  handoff: DirectiveBootstrapHandoff,
  io: DispatchIo,
  json: boolean,
): void {
  if (json) {
    io.writeOut(`${JSON.stringify(handoff, null, 2)}\n`);
    return;
  }
  io.writeOut("[directive bootstrap] Setup launcher — hand off to deft-directive-setup\n\n");
  io.writeOut(`project_root: ${handoff.project_root}\n`);
  io.writeOut(`deposited: ${handoff.deposited}\n`);
  io.writeOut(`phase: ${handoff.phase} (${handoff.phase_label})\n`);
  io.writeOut(`re_entry: ${handoff.re_entry}\n`);
  if (handoff.strategy !== null) {
    io.writeOut(`strategy: ${handoff.strategy}\n`);
  }
  io.writeOut(`\nNext: Read and follow ${handoff.skill_path}\n`);
}

/** Native `directive bootstrap` handler (#2022 Phase 4). */
export async function runDirectiveBootstrap(
  argv: string[],
  io: DispatchIo,
  deps: DirectiveBootstrapDeps = {},
): Promise<number> {
  const merged = { ...defaultBootstrapDeps(), ...deps };
  const args = parseDirectiveBootstrapArgs(argv);

  if (args.error === "__help__") {
    printDirectiveBootstrapHelp(io);
    return 0;
  }
  if (args.error !== undefined) {
    io.writeErr(`directive bootstrap: ${args.error}\n`);
    return 2;
  }

  const plan = resolveDirectiveBootstrapPlan(args, merged);

  let deposited = false;
  if (!merged.deftCorePresent(args.projectRoot)) {
    const initCode = await merged.runInitDeposit(args.projectRoot, io);
    if (initCode !== 0) {
      return initCode;
    }
    deposited = true;
  }

  const handoff: DirectiveBootstrapHandoff = {
    handoff: "deft-directive-setup",
    skill_path: SETUP_SKILL_REL_PATH,
    project_root: args.projectRoot,
    deposited,
    phase: plan.phase,
    phase_label: plan.phaseLabel,
    re_entry: plan.reEntry,
    strategy: plan.strategy,
  };

  emitBootstrapHandoff(handoff, io, args.json);
  return 0;
}

// ===========================================================================
// Native policy-set handler (#2022 Phase 1).
//
// Port of scripts/policy_set.py to native TypeScript so the typed-policy write
// path (enforce-branches / allow-direct-commits / wip-cap / subagent-backend)
// and the subagent-backends probe surface no longer shell into bundled Python.
// Behaviour parity with the Python script is preserved: the audit row appended
// to meta/policy-changes.log, the json.dumps(..., indent=2, ensure_ascii=False)
// + "\n" serialization, the disclosure text, and the exit codes
// (0 success / 1 refusal / 2 config-or-parse error).
// ===========================================================================

const POLICY_CAPABILITY_COST_DISCLOSURE =
  "\u26a0 Capability-cost disclosure -- enabling direct commits to the default " +
  "branch turns OFF the deft branch-protection policy.\n" +
  "  \u2022 Pre-commit + pre-push hooks will no longer block default-branch " +
  "commits.\n" +
  "  \u2022 verify:branch will pass on the default branch.\n" +
  "  \u2022 The CI sanity check (head_ref != base_ref) is still independent and " +
  "will continue to flag master->master PRs.\n" +
  "  \u2022 This change is reversible: run `" +
  policyColonInvocation("enforce-branches") +
  "` to " +
  "re-enable the gate.\n" +
  "  \u2022 The change is recorded to meta/policy-changes.log for auditability.";

const POLICY_WIP_CAP_DISCLOSURE =
  "\u26a0 Capability-cost disclosure -- changing plan.policy.wipCap " +
  "alters the refusal threshold on task scope:promote (#1124 / D4 of #1119).\n" +
  "  \u2022 Raising the cap lets more vBRIEFs sit in pending/+active/ " +
  "before promotion is refused.\n" +
  "  \u2022 Lowering the cap may put the project over cap immediately; " +
  "use `task scope:demote` / `task scope:demote --batch --older-than-days 30` " +
  "to drain.\n" +
  "  \u2022 cap=0 freezes promotion entirely (useful for code-freeze " +
  "windows; restore by setting a positive value).\n" +
  "  \u2022 This change is reversible and recorded to " +
  "meta/policy-changes.log for auditability.";

type PolicySetCmd =
  | "enforce-branches"
  | "allow-direct-commits"
  | "wip-cap"
  | "subagent-backend"
  | "subagent-backends";

const POLICY_SET_COMMANDS: readonly PolicySetCmd[] = [
  "enforce-branches",
  "allow-direct-commits",
  "wip-cap",
  "subagent-backend",
  "subagent-backends",
] as const;

/** Flags each subcommand accepts (mirrors the policy_set.py argparse subparsers). */
const POLICY_SET_ALLOWED_FLAGS: Readonly<Record<PolicySetCmd, ReadonlySet<string>>> = {
  "enforce-branches": new Set(["--actor", "--note", "--project-root"]),
  "allow-direct-commits": new Set(["--confirm", "--actor", "--note", "--project-root"]),
  "wip-cap": new Set(["--set", "--confirm", "--actor", "--note", "--project-root"]),
  "subagent-backend": new Set(["--set", "--actor", "--note", "--project-root"]),
  "subagent-backends": new Set(["--format", "--project-root"]),
};

interface PolicySetArgs {
  cmd: PolicySetCmd;
  confirm: boolean;
  actor: string;
  note: string;
  projectRoot: string;
  cap?: number;
  backendId?: string;
  format: "text" | "json";
  error?: string;
}

/** Custom error so write helpers can distinguish a missing file from a config fault. */
class PolicySetError extends Error {
  readonly kind: "not-found" | "config";
  constructor(message: string, kind: "not-found" | "config") {
    super(message);
    this.name = "PolicySetError";
    this.kind = kind;
  }
}

/** Python repr() for the audit-trail `previous=` field (None / 'str' / int / bool). */
function pyRepr(value: unknown): string {
  if (value === undefined || value === null) return "None";
  if (typeof value === "string") return `'${value}'`;
  if (typeof value === "boolean") return value ? "True" : "False";
  return String(value);
}

/** Strip newlines so an audit note stays a single log line (mirrors policy_set.py). */
function sanitizeNote(note: string): string {
  return note.replace(/\n/g, " ").replace(/\r/g, " ");
}

function defaultPolicySetActor(cmd: PolicySetCmd): string {
  switch (cmd) {
    case "enforce-branches":
      return policyColonInvocation("enforce-branches");
    case "allow-direct-commits":
      return policyColonInvocation("allow-direct-commits");
    case "wip-cap":
      return policySetInvocation("wip-cap");
    case "subagent-backend":
      return policySetInvocation("subagent-backend");
    case "subagent-backends":
      return policySetInvocation("subagent-backends");
  }
}

/** Mirror Python `Path(...).expanduser()` for a leading `~` / `~/` segment. */
function expandUser(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/") || p.startsWith("~\\")) {
    return join(homedir(), p.slice(2));
  }
  return p;
}

function policySetError(message: string): PolicySetArgs {
  return {
    cmd: "enforce-branches",
    confirm: false,
    actor: "",
    note: "",
    projectRoot: ".",
    format: "text",
    error: message,
  };
}

/** Parse `policy-set <cmd> [flags]` (mirrors the policy_set.py argparse surface). */
function parsePolicySetArgs(argv: readonly string[]): PolicySetArgs {
  const cmd = argv[0];
  if (cmd === undefined) {
    return policySetError("the following arguments are required: cmd");
  }
  if (!(POLICY_SET_COMMANDS as readonly string[]).includes(cmd)) {
    return policySetError(`argument cmd: invalid choice: '${cmd}'`);
  }
  const command = cmd as PolicySetCmd;
  const allowed = POLICY_SET_ALLOWED_FLAGS[command];
  const args: PolicySetArgs = {
    cmd: command,
    confirm: false,
    actor: defaultPolicySetActor(command),
    note: "",
    projectRoot: ".",
    format: "text",
  };

  const rest = argv.slice(1);
  for (let i = 0; i < rest.length; i += 1) {
    const token = rest[i];
    if (token === undefined) continue;
    let flag = token;
    let inlineValue: string | undefined;
    if (token.startsWith("--") && token.includes("=")) {
      const eq = token.indexOf("=");
      flag = token.slice(0, eq);
      inlineValue = token.slice(eq + 1);
    }
    if (!allowed.has(flag)) {
      return policySetError(`unrecognized arguments: ${token}`);
    }
    const takeValue = (): string | undefined => {
      if (inlineValue !== undefined) return inlineValue;
      i += 1;
      return rest[i];
    };

    if (flag === "--confirm") {
      args.confirm = true;
      continue;
    }
    const value = takeValue();
    if (value === undefined) {
      return policySetError(`argument ${flag}: expected one argument`);
    }
    if (flag === "--actor") {
      args.actor = value;
    } else if (flag === "--note") {
      args.note = value;
    } else if (flag === "--project-root") {
      args.projectRoot = expandUser(value);
    } else if (flag === "--format") {
      if (value !== "text" && value !== "json") {
        return policySetError(`argument --format: invalid choice: '${value}'`);
      }
      args.format = value;
    } else if (flag === "--set") {
      if (command === "wip-cap") {
        // Python int() strips surrounding whitespace, so "--set ' 5'" parsed
        // cleanly; trim before the integer check to preserve that contract.
        const capText = value.trim();
        if (!/^[+-]?\d+$/.test(capText)) {
          return policySetError(`argument --set: invalid int value: '${value}'`);
        }
        args.cap = Number.parseInt(capText, 10);
      } else {
        // subagent-backend --set <choice>
        if (!KNOWN_SUBAGENT_BACKEND_IDS.has(value)) {
          const choices = [...KNOWN_SUBAGENT_BACKEND_IDS].sort().join(", ");
          return policySetError(
            `argument --set: invalid choice: '${value}' (choose from ${choices})`,
          );
        }
        args.backendId = value;
      }
    }
  }

  if (command === "wip-cap" && args.cap === undefined) {
    return policySetError("the following arguments are required: --set");
  }
  if (command === "subagent-backend" && args.backendId === undefined) {
    return policySetError("the following arguments are required: --set");
  }
  return args;
}

interface PdWriteContext {
  path: string;
  data: Record<string, unknown>;
  policyBlock: Record<string, unknown>;
}

/** Load PROJECT-DEFINITION for an in-place typed-field write (mirrors the .setdefault chain). */
function loadProjectDefinitionForWrite(projectRoot: string): PdWriteContext {
  const path = projectDefinitionPath(projectRoot);
  if (!existsSync(path)) {
    throw new PolicySetError(`PROJECT-DEFINITION not found at ${path}`, "not-found");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    throw new PolicySetError(
      `PROJECT-DEFINITION at ${path} is not valid JSON: ${String(err)}`,
      "config",
    );
  }
  // JSON.parse can yield a non-object top level (null / array / scalar) without
  // throwing; reject it before the .plan/.policy property chain dereferences it.
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new PolicySetError(`PROJECT-DEFINITION at ${path} is not a JSON object`, "config");
  }
  const data = parsed as Record<string, unknown>;
  let plan = data.plan;
  if (plan === undefined) {
    plan = {};
    data.plan = plan;
  }
  if (typeof plan !== "object" || plan === null || Array.isArray(plan)) {
    throw new PolicySetError("PROJECT-DEFINITION 'plan' is not an object", "config");
  }
  const planObj = plan as Record<string, unknown>;
  migrateLegacyPolicyKey(planObj);
  let policy = planObj[PLAN_POLICY_KEY];
  if (policy === undefined) {
    policy = {};
    planObj[PLAN_POLICY_KEY] = policy;
  }
  if (typeof policy !== "object" || policy === null || Array.isArray(policy)) {
    throw new PolicySetError("plan.policy is not an object", "config");
  }
  return { path, data, policyBlock: policy as Record<string, unknown> };
}

/** Write plan.policy.wipCap in place + append the audit row (mirrors set_wip_cap). */
function writeWipCap(
  projectRoot: string,
  cap: number,
  actor: string,
  note: string,
): { changed: boolean; auditEntry: string } {
  const { path, data, policyBlock } = loadProjectDefinitionForWrite(projectRoot);
  const previous = policyBlock.wipCap;
  policyBlock.wipCap = cap;
  assertWriteTargetSafe(projectRoot, path);
  atomicWriteProjectDefinition(path, data);
  const changed = previous !== cap;
  const parts = [`actor=${actor}`, `wipCap=${cap}`, `previous=${pyRepr(previous)}`];
  if (note) parts.push(`note=${sanitizeNote(note)}`);
  const auditEntry = parts.join(" ");
  appendAuditLog(projectRoot, auditEntry);
  return { changed, auditEntry };
}

/** Write plan.policy.swarmSubagentBackend in place + append the audit row. */
function writeSubagentBackend(
  projectRoot: string,
  backendId: string,
  actor: string,
  note: string,
): { changed: boolean; auditEntry: string } {
  const { path, data, policyBlock } = loadProjectDefinitionForWrite(projectRoot);
  const previous = policyBlock.swarmSubagentBackend;
  policyBlock.swarmSubagentBackend = backendId;
  assertWriteTargetSafe(projectRoot, path);
  atomicWriteProjectDefinition(path, data);
  const changed = previous !== backendId;
  const parts = [
    `actor=${actor}`,
    `swarmSubagentBackend=${backendId}`,
    `previous=${pyRepr(previous)}`,
  ];
  if (note) parts.push(`note=${sanitizeNote(note)}`);
  const auditEntry = parts.join(" ");
  appendAuditLog(projectRoot, auditEntry);
  return { changed, auditEntry };
}

/** Serialise the probe output for `subagent-backends --format json`. */
function subagentBackendsToJson(backends: readonly SubagentBackendDescriptor[]): string {
  const payload = {
    backends: backends.map((entry) => ({
      id: entry.backend_id,
      display_name: entry.display_name,
      roles: [...entry.roles],
      available: entry.available,
    })),
  };
  return JSON.stringify(payload, null, 2);
}

/** Map a write-path error to its fail-closed message + exit code (mirrors the except blocks). */
function reportPolicyWriteError(err: unknown, io: DispatchIo): number {
  const message = err instanceof Error ? err.message : String(err);
  if (err instanceof PolicySetError && err.kind === "not-found") {
    io.writeErr(`\u274c ${message}\n`);
    io.writeErr(
      "  Recovery: run `task setup` to generate vbrief/PROJECT-DEFINITION.vbrief.json.\n",
    );
    return 2;
  }
  io.writeErr(`\u274c Config error: ${message}\n`);
  return 2;
}

function applyBranchPolicy(args: PolicySetArgs, io: DispatchIo): number {
  let target: boolean;
  if (args.cmd === "enforce-branches") {
    target = false;
  } else {
    if (!args.confirm) {
      io.writeOut(`${POLICY_CAPABILITY_COST_DISCLOSURE}\n`);
      io.writeOut("\n");
      io.writeOut(
        `Re-run with --confirm to apply: ${policyColonInvocation("allow-direct-commits", " -- --confirm")}\n`,
      );
      return 1;
    }
    target = true;
  }

  let result: { changed: boolean; auditEntry: string };
  try {
    result = setPolicy(args.projectRoot, {
      allowDirectCommits: target,
      actor: args.actor,
      note: args.note,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes("PROJECT-DEFINITION not found")) {
      io.writeErr(`\u274c ${message}\n`);
      io.writeErr(
        "  Recovery: run `task setup` to generate vbrief/PROJECT-DEFINITION.vbrief.json.\n",
      );
      return 2;
    }
    io.writeErr(`\u274c Config error: ${message}\n`);
    return 2;
  }

  const state = target ? "OFF" : "ON";
  io.writeOut(
    `\u2713 plan.policy.allowDirectCommitsToMaster=${target ? "true" : "false"} ` +
      `(branch-protection ${state}).\n`,
  );
  if (result.changed) {
    io.writeOut(`  audit: meta/policy-changes.log :: ${result.auditEntry}\n`);
  } else {
    io.writeOut("  no-op: value already matched (audit entry still appended for trail).\n");
  }
  io.writeOut(`${disclosureLine(resolvePolicy(args.projectRoot))}\n`);
  return 0;
}

function applyWipCap(args: PolicySetArgs, io: DispatchIo): number {
  const cap = args.cap ?? 0;
  if (cap < 0) {
    io.writeErr(`\u274c --set must be >= 0; got ${cap}.\n`);
    return 1;
  }
  if (!args.confirm) {
    io.writeOut(`${POLICY_WIP_CAP_DISCLOSURE}\n`);
    io.writeOut("\n");
    io.writeOut(
      `Re-run with --confirm to apply: ${policySetInvocation("wip-cap", ` -- --set ${cap} --confirm`)}\n`,
    );
    return 1;
  }
  let res: { changed: boolean; auditEntry: string };
  try {
    res = writeWipCap(args.projectRoot, cap, args.actor, args.note);
  } catch (err) {
    return reportPolicyWriteError(err, io);
  }
  io.writeOut(`\u2713 plan.policy.wipCap=${cap}.\n`);
  if (res.changed) {
    io.writeOut(`  audit: meta/policy-changes.log :: ${res.auditEntry}\n`);
  } else {
    io.writeOut("  no-op: value already matched (audit entry still appended for trail).\n");
  }
  const result = resolveWipCap(args.projectRoot);
  io.writeOut(`[deft policy] plan.policy.wipCap=${result.cap} (source: ${result.source}).\n`);
  return 0;
}

function applySubagentBackend(args: PolicySetArgs, io: DispatchIo): number {
  const backendId = args.backendId ?? "";
  let res: { changed: boolean; auditEntry: string };
  try {
    res = writeSubagentBackend(args.projectRoot, backendId, args.actor, args.note);
  } catch (err) {
    return reportPolicyWriteError(err, io);
  }
  io.writeOut(`\u2713 plan.policy.swarmSubagentBackend=${backendId}.\n`);
  if (res.changed) {
    io.writeOut(`  audit: meta/policy-changes.log :: ${res.auditEntry}\n`);
  } else {
    io.writeOut("  no-op: value already matched (audit entry still appended for trail).\n");
  }
  const result = resolveSwarmSubagentBackend(args.projectRoot);
  io.writeOut(
    `[deft policy] plan.policy.swarmSubagentBackend=${pyRepr(result.backend_id)} ` +
      `(source: ${result.source}).\n`,
  );
  return 0;
}

function applySubagentBackends(args: PolicySetArgs, io: DispatchIo): number {
  const entries = probeSubagentBackends();
  if (args.format === "json") {
    io.writeOut(`${subagentBackendsToJson(entries)}\n`);
    return 0;
  }
  for (const entry of entries) {
    const roles = entry.roles.join(", ");
    const avail = entry.available ? "available" : "unavailable";
    io.writeOut(`${entry.backend_id}\t${entry.display_name}\troles=[${roles}]\t${avail}\n`);
  }
  return 0;
}

/** Native `policy-set` dispatcher (replaces the policy_set.py shell-out, #2022 Phase 1). */
export function runPolicySet(argv: string[], io: DispatchIo): number {
  const args = parsePolicySetArgs(argv);
  if (args.error !== undefined) {
    io.writeErr(`policy-set: ${args.error}\n`);
    return 2;
  }
  switch (args.cmd) {
    case "enforce-branches":
    case "allow-direct-commits":
      return applyBranchPolicy(args, io);
    case "wip-cap":
      return applyWipCap(args, io);
    case "subagent-backend":
      return applySubagentBackend(args, io);
    case "subagent-backends":
      return applySubagentBackends(args, io);
  }
}

async function loadCoreModuleHandler(verb: string, io: DispatchIo): Promise<CommandHandler> {
  switch (verb) {
    case "scm": {
      const { main } = await import("@deftai/directive-core/dist/scm/main.js");
      return (argv) => main(argv);
    }
    case "scm-readiness": {
      const { mainEntry } = await import("@deftai/directive-core/dist/scm/readiness-cli.js");
      return mainEntry;
    }
    case "github-auth-modes": {
      const { mainEntry } = await import(
        "@deftai/directive-core/dist/intake/github-auth-modes-cli.js"
      );
      return mainEntry;
    }
    case "github-body": {
      const { mainEntry } = await import("@deftai/directive-core/dist/intake/github-body-cli.js");
      return mainEntry;
    }
    case "issue-emit": {
      const { mainEntry } = await import("@deftai/directive-core/dist/intake/issue-emit-cli.js");
      return mainEntry;
    }
    case "issue-ingest": {
      const { mainEntry } = await import("@deftai/directive-core/dist/intake/issue-ingest-cli.js");
      return mainEntry;
    }
    case "issue-sync-from-xbrief": {
      const { mainEntry } = await import(
        "@deftai/directive-core/dist/issue-sync/sync-from-xbrief-cli.js"
      );
      return mainEntry;
    }
    case "reconcile-issues": {
      const { mainEntry } = await import(
        "@deftai/directive-core/dist/intake/reconcile-issues-cli.js"
      );
      return mainEntry;
    }
    case "swarm-launch": {
      const { launchMain } = await import("@deftai/directive-core/dist/swarm/launch-cli.js");
      return launchMain;
    }
    case "swarm-complete-cohort": {
      const { completeCohortMain } = await import(
        "@deftai/directive-core/dist/swarm/complete-cohort-cli.js"
      );
      return completeCohortMain;
    }
    case "swarm-finalize-cohort": {
      const { finalizeCohortMain } = await import(
        "@deftai/directive-core/dist/swarm/finalize-cohort-cli.js"
      );
      return finalizeCohortMain;
    }
    case "swarm-readiness": {
      const { readinessMain } = await import("@deftai/directive-core/dist/swarm/readiness-cli.js");
      return readinessMain;
    }
    case "swarm-routing-verify": {
      const { routingVerifyMain } = await import(
        "@deftai/directive-core/dist/swarm/routing-verify-cli.js"
      );
      return routingVerifyMain;
    }
    case "swarm-routing-set": {
      const { routingSetMain } = await import(
        "@deftai/directive-core/dist/swarm/routing-set-cli.js"
      );
      return routingSetMain;
    }
    case "swarm-verify-review-clean": {
      const { verifyReviewCleanMain } = await import(
        "@deftai/directive-core/dist/swarm/verify-review-clean-cli.js"
      );
      return verifyReviewCleanMain;
    }
    case "swarm-worktrees": {
      const { worktreesMain } = await import("@deftai/directive-core/dist/swarm/worktrees-cli.js");
      return worktreesMain;
    }
    case "framework-commands": {
      const { frameworkCommandsMain } = await import("@deftai/directive-core/render");
      return (argv) => frameworkCommandsMain(argv);
    }
    case "pack-render": {
      const { main } = await import("@deftai/directive-core/dist/packs/pack-render.js");
      return (argv) => main([...argv]);
    }
    case "packs-slice": {
      const { main } = await import("@deftai/directive-core/dist/packs/packs-slice.js");
      return (argv) => main([...argv]);
    }
    case "roadmap-render": {
      const { main } = await import("@deftai/directive-core/dist/render/roadmap-render.js");
      return (argv) => main(argv);
    }
    case "spec-validate": {
      const { runSpecValidateCli } = await import("./render-cli/spec-validate-cli.js");
      return (argv) => runSpecValidateCli(argv);
    }
    case "spec-render": {
      const { runSpecRenderCli } = await import("./render-cli/spec-render-cli.js");
      return (argv) => runSpecRenderCli(argv);
    }
    case "prd-render": {
      const { runPrdRenderCli } = await import("./render-cli/prd-render-cli.js");
      return (argv) => runPrdRenderCli(argv);
    }
    case "project-render": {
      const { runProjectRenderCli } = await import("./render-cli/project-render-cli.js");
      return (argv) => runProjectRenderCli(argv);
    }
    case "rule-map": {
      const { runRuleMapCli } = await import("./render-cli/rule-map-cli.js");
      return (argv) => runRuleMapCli(argv);
    }
    case "export-spec": {
      const { runExportSpecCli } = await import("./render-cli/export-spec-cli.js");
      return (argv) => runExportSpecCli(argv);
    }
    case "code-structure-validate": {
      const { evaluateCodeStructure } = await import("@deftai/directive-core/verify-source");
      return (argv) => {
        const parsed = parseCodeStructureArgs(argv);
        if (parsed.error !== undefined) {
          io.writeErr(`code_structure_validate: ${parsed.error}\n`);
          return 2;
        }
        const result = evaluateCodeStructure(parsed.projectRoot, {
          paths: parsed.paths.length > 0 ? parsed.paths : undefined,
          json: parsed.json,
          strict: parsed.strict,
        });
        if (result.stdout) io.writeOut(result.stdout);
        if (result.stderr) io.writeErr(result.stderr);
        return result.code;
      };
    }
    case "pack-migrate-skills":
      return (argv) => runPackMigrateSkills(argv, io);
    case "pack-migrate-rules":
      return (argv) => runPackMigrateRules(argv, io);
    case "pack-migrate-strategies":
      return (argv) => runPackMigrateStrategies(argv, io);
    case "pack-migrate-patterns":
      return (argv) => runPackMigratePatterns(argv, io);
    case "pack-migrate-swarm-spec":
      return (argv) => runPackMigrateSwarmSpec(argv, io);
    case "policy-set":
      return (argv) => runPolicySet(argv, io);
    case "setup-ghx":
      return (argv) => runSetupGhx(argv, io);
    case "scope-undo": {
      const { undoMain } = await import("@deftai/directive-core/dist/scope/main.js");
      return undoMain;
    }
    case "scope-demote": {
      const { demoteMain } = await import("@deftai/directive-core/dist/scope/main.js");
      return demoteMain;
    }
    case "scope-decompose": {
      const { decomposeMain } = await import("@deftai/directive-core/dist/scope/decompose.js");
      return decomposeMain;
    }
    case "changelog-resolve-unreleased": {
      const { changelogResolveUnreleasedMain } = await import(
        "@deftai/directive-core/dist/platform/changelog-cli.js"
      );
      return changelogResolveUnreleasedMain;
    }
    case "architecture-preflight-sor": {
      const { architecturePreflightSorMain } = await import(
        "@deftai/directive-core/dist/architecture/sor-preflight.js"
      );
      return architecturePreflightSorMain;
    }
    case "feedback-file": {
      const { mainEntry } = await import("@deftai/directive-core/dist/value/feedback-file.js");
      return mainEntry;
    }
    case "value-readback": {
      const { mainEntry } = await import("@deftai/directive-core/dist/value/readback.js");
      return mainEntry;
    }
    case "product-signal": {
      const { mainEntry } = await import("@deftai/directive-core/dist/product-signal/submit.js");
      return mainEntry;
    }
    case "freshness-report": {
      const { mainEntry } = await import("@deftai/directive-core/dist/freshness/cli.js");
      return mainEntry;
    }
    case "decision-write": {
      const { writeMainEntry } = await import("@deftai/directive-core/dist/decision/index.js");
      return writeMainEntry;
    }
    case "decision-list": {
      const { listMainEntry } = await import("@deftai/directive-core/dist/decision/index.js");
      return listMainEntry;
    }
    default:
      throw new Error(`unknown core verb: ${verb}`);
  }
}

const handlerCache = new Map<string, Promise<CommandHandler>>();

function loadHandler(canonical: string, io: DispatchIo): Promise<CommandHandler> {
  let pending = handlerCache.get(canonical);
  if (pending === undefined) {
    pending = (CLI_MODULE_VERBS as readonly string[]).includes(canonical)
      ? loadCliModuleHandler(canonical, io)
      : loadCoreModuleHandler(canonical, io);
    handlerCache.set(canonical, pending);
  }
  return pending;
}

function defaultIo(): DispatchIo {
  return {
    writeOut: (text) => {
      process.stdout.write(text);
    },
    writeErr: (text) => {
      process.stderr.write(text);
    },
  };
}

/** Resolve a user-facing verb to its canonical handler key. */
export function resolveCanonicalVerb(verb: string): string | null {
  if ((CLI_MODULE_VERBS as readonly string[]).includes(verb)) return verb;
  if ((CORE_MODULE_VERBS as readonly string[]).includes(verb)) return verb;
  const alias = VERB_ALIASES[verb];
  if (alias !== undefined) return alias;
  return null;
}

/** Sorted list of all registered verb names (canonical + aliases). */
export function registeredVerbs(): readonly string[] {
  const names = new Set<string>([
    ...CLI_MODULE_VERBS,
    ...CORE_MODULE_VERBS,
    ...Object.keys(VERB_ALIASES),
  ]);
  return [...names].sort();
}

/** Top-level UX commands routed before the flat dispatcher (#1670). */
const TOP_LEVEL_COMMAND_NAMES = [
  "init",
  "update",
  "migrate",
  "bootstrap",
  "doctor",
  "check",
] as const;

/** Scope lifecycle verbs exposed as scope:<verb> in help (#2172). */
const SCOPE_COMMAND_NAMES = [
  "scope:promote",
  "scope:activate",
  "scope:complete",
  "scope:demote",
  "scope:undo",
  "scope:record-approved-scope",
] as const;

/**
 * Deduplicated command names for `directive commands`, preferring colon-style
 * task verbs over dash-style canonical stems when both exist (#2172).
 */
export function preferredCommandNames(): readonly string[] {
  const aliasKeys = Object.keys(VERB_ALIASES);
  const aliasedCanonicals = new Set(Object.values(VERB_ALIASES));
  const unaliasedCanonicals = [...CLI_MODULE_VERBS, ...CORE_MODULE_VERBS].filter(
    (verb) => !aliasedCanonicals.has(verb),
  );
  return [
    ...new Set([
      ...TOP_LEVEL_COMMAND_NAMES,
      ...SCOPE_COMMAND_NAMES,
      ...aliasKeys,
      ...unaliasedCanonicals,
    ]),
  ].sort();
}

/** Major.minor label for the curated help title (#2172). */
export function helpVersionLabel(): string {
  const version = engineInfo().version;
  const match = /^(\d+\.\d+)/.exec(version);
  return match ? `v${match[1]}` : `v${version}`;
}

interface HelpCommand {
  name: string;
  summary: string;
}

interface HelpGroup {
  title: string;
  commands: readonly HelpCommand[];
}

const CURATED_HELP_GROUPS: readonly HelpGroup[] = [
  {
    title: "Getting started",
    commands: [
      { name: "init", summary: "Set up Directive in the current project (first-time setup)" },
      { name: "update", summary: "Refresh an existing install and self-heal the engine" },
      { name: "doctor", summary: "Diagnose the install and print the one next step" },
    ],
  },
  {
    title: "Session & ritual",
    commands: [
      { name: "session:start", summary: "Record session-start ritual state" },
      {
        name: "session:ready",
        summary: "One-shot recovery to gated write-ready (session + ritual + cache)",
      },
      {
        name: "freshness:report",
        summary: "Bound vs live deposit generation (current|stale_soft|stale_hard)",
      },
      {
        name: "freshness:bind",
        summary: "Bind live deposit generation into this session (no host restart)",
      },
      {
        name: "scm:status",
        summary: "Probe gh/ghx + auth readiness in this execution env (#2275)",
      },
      {
        name: "lifecycle:event",
        summary: "Record review-cycle plan:approved approval events",
      },
      {
        name: "lifecycle:stats",
        summary: "Local xBRIEF lifecycle folder counts for process rollups",
      },
    ],
  },
  {
    title: "Quality & gates",
    commands: [{ name: "check", summary: "Run install and lifecycle quality gates" }],
  },
  {
    title: "Work queue & triage",
    commands: [
      { name: "triage:welcome", summary: "Session orientation and triage one-liner" },
      { name: "triage:queue", summary: "Ranked work queue for what to do next" },
    ],
  },
  {
    title: "Scope lifecycle",
    commands: [{ name: "scope:promote", summary: "Promote a scope xBRIEF to pending" }],
  },
  {
    title: "xBRIEF create/verify (not lifecycle)",
    commands: [
      {
        name: "xbrief:create",
        summary: "Write a dense xBRIEF artifact at --out (requires --format); not scope:*",
      },
      {
        name: "xbrief:verify",
        summary: "Verify a dense xBRIEF artifact at --out (requires --format); not scope:*",
      },
    ],
  },
  {
    title: "Project artifacts",
    commands: [
      { name: "project:render", summary: "Render PROJECT-DEFINITION projection" },
      { name: "spec:render", summary: "Render specification projection" },
    ],
  },
];

function formatHelpCommand(command: HelpCommand): string {
  const padding = " ".repeat(Math.max(1, 22 - command.name.length));
  return `  ${command.name}${padding}${command.summary}\n`;
}

/**
 * Print the exhaustive registered-command list for `directive commands` (#2172).
 * Lists deduplicated preferred names (colon-style when available).
 */
export function printCommandsList(io: DispatchIo = defaultIo()): void {
  io.writeOut("Registered commands:\n");
  for (const name of preferredCommandNames()) {
    io.writeOut(`  ${name}\n`);
  }
}

/**
 * Print curated top-level help: title/version, usage, common options, grouped
 * common commands, and a pointer to `directive commands` for the full list
 * (#2172). Preserves the init/update/doctor first-run guidance from #2273.
 */
export function printHelp(io: DispatchIo = defaultIo()): void {
  io.writeOut(`Directive ${helpVersionLabel()}\n`);
  io.writeOut("AI development framework CLI for project lifecycle, scope, and quality gates.\n\n");

  io.writeOut("Usage:\n");
  io.writeOut("  directive <command> [options]\n");
  io.writeOut("  directive help\n");
  io.writeOut("  directive commands          List every registered command\n\n");

  io.writeOut("Options:\n");
  io.writeOut("  -h, --help                  Show this help\n");
  io.writeOut("  -V, --version               Print version information\n\n");

  for (const group of CURATED_HELP_GROUPS) {
    io.writeOut(`${group.title}:\n`);
    for (const command of group.commands) {
      io.writeOut(formatHelpCommand(command));
    }
    io.writeOut("\n");
  }

  io.writeOut(
    "Commands use colon style (e.g. triage:queue); dash-style aliases remain supported.\n" +
      "Run `directive commands` for the full registered-command list.\n\n" +
      "First run? From the project root:\n" +
      "  1. npm i -g @deftai/directive   (Node >= 20)\n" +
      "     (pnpm: pnpm add -g @deftai/directive -- ensure PNPM_HOME is on PATH, run `pnpm setup` if needed)\n" +
      "  2. directive init\n" +
      "  3. directive doctor\n" +
      "New clone where `directive` will not run? Read the Cold-start bootstrap block at the top of README.md.\n",
  );
}

async function invokeHandler(handler: CommandHandler, argv: string[]): Promise<number> {
  const code = await handler(argv);
  return typeof code === "number" ? code : 0;
}

const CLI_PACKAGE = "@deftai/directive" as const;

function versionBanner(): string {
  const info = engineInfo();
  return `${CLI_PACKAGE} (engine: ${info.name}@${info.version})\n`;
}

/** Dispatch argv to a registered verb; returns the handler exit code. */
export async function dispatch(argv: string[], io: DispatchIo = defaultIo()): Promise<number> {
  if (argv[0] === "--version" || argv[0] === "-V") {
    io.writeOut(versionBanner());
    return 0;
  }

  if (argv.length === 0 || argv[0] === "--help" || argv[0] === "-h" || argv[0] === "help") {
    printHelp(io);
    return 0;
  }

  const [verb, ...rest] = argv;

  if (verb === "commands") {
    printCommandsList(io);
    return 0;
  }
  const canonical = resolveCanonicalVerb(verb ?? "");
  if (canonical === null) {
    io.writeErr(`directive: unknown verb '${verb}'\n`);
    if (verb?.includes(":")) {
      io.writeErr(
        `hint: prefer \`task ${verb}\` (Taskfile) or the hyphen stem ` +
          `(e.g. pr:watch → pr-watch / \`task pr:watch\`)\n`,
      );
    }
    return 1;
  }

  try {
    const handler = await loadHandler(canonical, io);
    const triageSubcommand = verb !== undefined ? TRIAGE_ACTION_ALIAS_SUBCOMMANDS[verb] : undefined;
    const policySubcommand = verb !== undefined ? POLICY_ACTION_ALIAS_SUBCOMMANDS[verb] : undefined;
    const authzSubcommand = verb !== undefined ? AUTHZ_ACTION_ALIAS_SUBCOMMANDS[verb] : undefined;
    const escalationSubcommand =
      verb !== undefined ? ESCALATION_ACTION_ALIAS_SUBCOMMANDS[verb] : undefined;
    const planSequenceSubcommand =
      verb !== undefined ? PLAN_SEQUENCE_ALIAS_SUBCOMMANDS[verb] : undefined;
    const productSignalSubcommand =
      verb !== undefined ? PRODUCT_SIGNAL_ALIAS_SUBCOMMANDS[verb] : undefined;
    const freshnessSubcommand = verb !== undefined ? FRESHNESS_ALIAS_SUBCOMMANDS[verb] : undefined;
    const handlerArgv =
      canonical === "framework-commands" && verb !== undefined && verb !== canonical
        ? [verb, ...rest]
        : triageSubcommand !== undefined && canonical === "triage-actions"
          ? [triageSubcommand, ...rest]
          : policySubcommand !== undefined && canonical === "policy"
            ? [policySubcommand, ...rest]
            : authzSubcommand !== undefined && canonical === "authz"
              ? [authzSubcommand, ...rest]
              : escalationSubcommand !== undefined && canonical === "escalation-cli"
                ? [escalationSubcommand, ...rest]
                : planSequenceSubcommand !== undefined && canonical === "plan-sequence"
                  ? [planSequenceSubcommand, ...rest]
                  : productSignalSubcommand !== undefined && canonical === "product-signal"
                    ? [productSignalSubcommand, ...rest]
                    : freshnessSubcommand !== undefined && canonical === "freshness-report"
                      ? [freshnessSubcommand, ...rest]
                      : rest;
    return await invokeHandler(handler, handlerArgv);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    io.writeErr(`directive: ${message}\n`);
    return 2;
  }
}

/** Test seam: reset lazy handler cache between cases. */
export function resetHandlerCacheForTests(): void {
  handlerCache.clear();
}
