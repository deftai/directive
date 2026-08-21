#!/usr/bin/env node
/**
 * Policy CLI (#1722): `policy:show` and `policy:allow-direct-commits` surfaces,
 * mirroring scripts/_policy_show_cli.py and scripts/policy_set.py.
 */
import { existsSync } from "node:fs";
import { resolve as pathResolve, relative } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ALLOW_BOT_MERGE_CAPABILITY_COST,
  CEREMONY_DEPTHS,
  type CeremonyDepth,
  clearValueFeedback,
  createNoDeftDirectiveFlag,
  describeShadowedPlanExtension,
  detectNoDeftDirective,
  detectShadowedPlanExtensions,
  disableHostHooks,
  disclosureLine,
  enableValueFeedback,
  FIELD_VALUE_FEEDBACK,
  FIELD_VALUE_FEEDBACK_CLI_ALIAS,
  formatValueFeedbackStatusLine,
  type HookHost,
  humanMergeDisclosureLine,
  inspectAllPolicies,
  inspectOnePolicy,
  loadProjectDefinition,
  NO_DEFT_DIRECTIVE_DISABLED_MESSAGE,
  NO_DEFT_DIRECTIVE_FLAG_NAME,
  NO_DEFT_DIRECTIVE_INCONSISTENT_MESSAGE,
  POLICY_AUDIT_NOOP_STDOUT,
  parseHookHost,
  policyColonInvocation,
  projectDefinitionPath,
  pythonListRepr,
  pythonStringRepr,
  registeredPolicyNames,
  removeNoDeftDirectiveFlag,
  renderJson,
  renderText,
  resolveHumanMergePolicy,
  resolvePolicy,
  resolveValueFeedback,
  setCeremonyDial,
  setPolicy,
  setRequireHumanMerge,
} from "@deftai/directive-core/policy";

const CAPABILITY_COST_DISCLOSURE =
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

interface ShowArgs {
  format: "text" | "json";
  changedOnly: boolean;
  field: string | null;
  projectRoot: string;
  error?: string;
}

interface SetArgs {
  cmd:
    | "show"
    | "enforce-branches"
    | "allow-direct-commits"
    | "allow-bot-merge"
    | "enable-value-feedback"
    | "clear-value-feedback"
    | "set-ceremony-dial"
    | "disable-host-hooks"
    | "disable-directive"
    | "enable-directive"
    | "resolve";
  confirm: boolean;
  actor: string;
  note: string;
  host?: HookHost;
  projectRoot: string;
  format: "text" | "json";
  changedOnly: boolean;
  field: string | null;
  /** #3214 ceremony dial override depth for set-ceremony-dial. */
  ceremonyOverride?: CeremonyDepth | null;
  /** #3214 ceremony dial enabled flag for set-ceremony-dial. */
  ceremonyEnabled?: boolean;
  error?: string;
}

function makeSetError(message: string): SetArgs {
  return {
    cmd: "show",
    confirm: false,
    actor: "",
    note: "",
    projectRoot: ".",
    format: "text",
    changedOnly: false,
    field: null,
    error: message,
  };
}

function parseProjectRoot(argv: string[]): { projectRoot: string; error?: string } {
  let projectRoot = ".";
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--project-root") {
      const v = argv[i + 1];
      if (v === undefined) {
        return { projectRoot: ".", error: "argument --project-root: expected one argument" };
      }
      projectRoot = v;
      i += 1;
    } else if (arg?.startsWith("--project-root=")) {
      projectRoot = arg.slice("--project-root=".length);
    } else {
      return { projectRoot: ".", error: `unrecognized argument: ${arg}` };
    }
  }
  return { projectRoot };
}

/** Parse policy:show flags (mirrors _policy_show_cli.py). */
export function parseShowArgs(argv: string[]): ShowArgs {
  const parsed: ShowArgs = {
    format: "text",
    changedOnly: false,
    field: null,
    projectRoot: ".",
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--format") {
      const v = argv[i + 1];
      if (v !== "text" && v !== "json") {
        return {
          ...parsed,
          error:
            v === undefined ? "argument --format: expected one argument" : `invalid choice: '${v}'`,
        };
      }
      parsed.format = v;
      i += 1;
    } else if (arg?.startsWith("--format=")) {
      const v = arg.slice("--format=".length);
      if (v !== "text" && v !== "json") {
        return { ...parsed, error: `invalid choice: '${v}'` };
      }
      parsed.format = v;
    } else if (arg === "--changed-only") {
      parsed.changedOnly = true;
    } else if (arg === "--field") {
      const v = argv[i + 1];
      if (v === undefined) return { ...parsed, error: "argument --field: expected one argument" };
      parsed.field = v;
      i += 1;
    } else if (arg?.startsWith("--field=")) {
      parsed.field = arg.slice("--field=".length);
    } else if (arg === "--project-root") {
      const v = argv[i + 1];
      if (v === undefined) {
        return { ...parsed, error: "argument --project-root: expected one argument" };
      }
      parsed.projectRoot = v;
      i += 1;
    } else if (arg?.startsWith("--project-root=")) {
      parsed.projectRoot = arg.slice("--project-root=".length);
    } else {
      return { ...parsed, error: `unrecognized argument: ${arg}` };
    }
  }
  return parsed;
}

/** Parse argv for the policy CLI (show + set subcommands). */
export function parseArgs(argv: string[]): SetArgs {
  if (argv.length === 0) {
    const usage =
      "usage: policy [show|enforce-branches|allow-direct-commits|allow-bot-merge|enable-value-feedback|clear-value-feedback|set-ceremony-dial|disable-host-hooks|disable-directive|enable-directive|resolve] ...";
    return makeSetError(usage);
  }

  const cmd = argv[0];
  if (cmd === "show") {
    const show = parseShowArgs(argv.slice(1));
    return {
      cmd: "show",
      confirm: false,
      actor: policyColonInvocation("show"),
      note: "",
      projectRoot: show.projectRoot,
      format: show.format,
      changedOnly: show.changedOnly,
      field: show.field,
      error: show.error,
    };
  }

  if (cmd === "resolve") {
    const root = parseProjectRoot(argv.slice(1));
    return {
      cmd: "resolve",
      confirm: false,
      actor: "agent",
      note: "",
      projectRoot: root.projectRoot,
      format: "text",
      changedOnly: false,
      field: null,
      error: root.error,
    };
  }

  if (
    cmd === "enforce-branches" ||
    cmd === "allow-direct-commits" ||
    cmd === "allow-bot-merge" ||
    cmd === "enable-value-feedback" ||
    cmd === "clear-value-feedback" ||
    cmd === "set-ceremony-dial" ||
    cmd === "disable-host-hooks" ||
    cmd === "disable-directive" ||
    cmd === "enable-directive"
  ) {
    let confirm = false;
    let actor =
      cmd === "enforce-branches"
        ? policyColonInvocation("enforce-branches")
        : cmd === "allow-direct-commits"
          ? policyColonInvocation("allow-direct-commits")
          : cmd === "allow-bot-merge"
            ? policyColonInvocation("allow-bot-merge")
            : cmd === "enable-value-feedback"
              ? policyColonInvocation("enable-value-feedback")
              : cmd === "clear-value-feedback"
                ? policyColonInvocation("clear-value-feedback")
                : cmd === "set-ceremony-dial"
                  ? policyColonInvocation("set-ceremony-dial")
                  : cmd === "disable-host-hooks"
                    ? policyColonInvocation("disable-host-hooks")
                    : cmd === "disable-directive"
                      ? policyColonInvocation("disable-directive")
                      : policyColonInvocation("enable-directive");
    let note = "";
    let projectRoot = ".";
    let host: HookHost | undefined;
    let ceremonyOverride: CeremonyDepth | null | undefined;
    let ceremonyEnabled: boolean | undefined;
    for (let i = 1; i < argv.length; i += 1) {
      const arg = argv[i];
      if (arg === "--confirm") {
        confirm = true;
      } else if (arg === "--actor") {
        const v = argv[i + 1];
        if (v === undefined) return makeSetError("argument --actor: expected one argument");
        actor = v;
        i += 1;
      } else if (arg?.startsWith("--actor=")) {
        actor = arg.slice("--actor=".length);
      } else if (arg === "--note") {
        const v = argv[i + 1];
        if (v === undefined) return makeSetError("argument --note: expected one argument");
        note = v;
        i += 1;
      } else if (arg?.startsWith("--note=")) {
        note = arg.slice("--note=".length);
      } else if (arg === "--project-root") {
        const v = argv[i + 1];
        if (v === undefined) return makeSetError("argument --project-root: expected one argument");
        projectRoot = v;
        i += 1;
      } else if (arg?.startsWith("--project-root=")) {
        projectRoot = arg.slice("--project-root=".length);
      } else if (cmd === "set-ceremony-dial" && (arg === "--override" || arg === "--depth")) {
        const v = argv[i + 1];
        if (v === undefined) {
          return makeSetError(
            `argument ${arg}: expected one argument (minimal|rapid|standard|elevated|null)`,
          );
        }
        if (v === "null" || v === "none" || v === "clear") {
          ceremonyOverride = null;
        } else if ((CEREMONY_DEPTHS as readonly string[]).includes(v)) {
          ceremonyOverride = v as CeremonyDepth;
        } else {
          return makeSetError(
            `argument ${arg}: expected minimal|rapid|standard|elevated|null, got ${JSON.stringify(v)}`,
          );
        }
        i += 1;
      } else if (
        cmd === "set-ceremony-dial" &&
        (arg?.startsWith("--override=") || arg?.startsWith("--depth="))
      ) {
        const v = arg.slice(arg.indexOf("=") + 1);
        if (v === "null" || v === "none" || v === "clear") {
          ceremonyOverride = null;
        } else if ((CEREMONY_DEPTHS as readonly string[]).includes(v)) {
          ceremonyOverride = v as CeremonyDepth;
        } else {
          return makeSetError(
            `argument --override: expected minimal|rapid|standard|elevated|null, got ${JSON.stringify(v)}`,
          );
        }
      } else if (cmd === "set-ceremony-dial" && arg === "--enabled") {
        const v = argv[i + 1];
        if (v === undefined || (v !== "true" && v !== "false")) {
          return makeSetError("argument --enabled: expected true|false");
        }
        ceremonyEnabled = v === "true";
        i += 1;
      } else if (cmd === "set-ceremony-dial" && arg?.startsWith("--enabled=")) {
        const v = arg.slice("--enabled=".length);
        if (v !== "true" && v !== "false") {
          return makeSetError("argument --enabled: expected true|false");
        }
        ceremonyEnabled = v === "true";
      } else if (cmd === "disable-host-hooks" && arg === "--host") {
        const v = argv[i + 1];
        const parsedHost = parseHookHost(v);
        if (parsedHost === null) {
          return makeSetError("argument --host: expected claude|cursor|grok|codex");
        }
        host = parsedHost;
        i += 1;
      } else if (cmd === "disable-host-hooks" && arg?.startsWith("--host=")) {
        const parsedHost = parseHookHost(arg.slice("--host=".length));
        if (parsedHost === null) {
          return makeSetError("argument --host: expected claude|cursor|grok|codex");
        }
        host = parsedHost;
      } else {
        return makeSetError(`unrecognized argument: ${arg}`);
      }
    }
    if (cmd === "disable-host-hooks" && host === undefined) {
      return makeSetError("disable-host-hooks requires --host claude|cursor|grok|codex");
    }
    return {
      cmd,
      confirm,
      actor,
      note,
      projectRoot,
      format: "text",
      changedOnly: false,
      field: null,
      host,
      ceremonyOverride,
      ceremonyEnabled,
    };
  }

  return makeSetError(`unknown subcommand: ${cmd}`);
}

/**
 * Emit a loud warning to stderr for every plan-extension key whose bare block
 * silently shadows the namespaced form (#2301). Never fails / throws: a missing
 * or malformed PROJECT-DEFINITION simply yields no warnings.
 */
function emitPlanExtensionShadowWarnings(projectRoot: string): void {
  const [data] = loadProjectDefinition(projectRoot);
  if (data === null) return;
  const shadows = detectShadowedPlanExtensions(data.plan);
  for (const shadow of shadows) {
    process.stderr.write(`[policy:show] WARNING: ${describeShadowedPlanExtension(shadow)}\n`);
  }
}

function valueFeedbackGateSummary(projectRoot: string): string {
  return formatValueFeedbackStatusLine(resolveValueFeedback(projectRoot));
}

function runShow(args: ShowArgs): number {
  const projectRoot = pathResolve(args.projectRoot);
  // Layout-aware (#2302): name the resolved PROJECT-DEFINITION path (xbrief on a
  // migrated tree, else vbrief) instead of the hardcoded vbrief/ literal.
  const pdPath = projectDefinitionPath(projectRoot);
  if (!existsSync(pdPath)) {
    process.stderr.write(
      `[policy:show] PROJECT-DEFINITION not found at ${pdPath}; ` +
        "rendering framework defaults.\n",
    );
  }
  emitPlanExtensionShadowWarnings(projectRoot);

  if (args.field !== null) {
    const field = inspectOnePolicy(args.field, projectRoot);
    if (field === null) {
      const known = registeredPolicyNames();
      process.stderr.write(
        `[policy:show] unknown --field=${pythonStringRepr(args.field)}; ` +
          `registered fields: ${pythonListRepr(known)}\n`,
      );
      return 2;
    }
    if (args.format === "json") {
      process.stdout.write(`${renderJson([field])}\n`);
    } else {
      process.stdout.write(`${renderText([field])}\n`);
      if (field.name === FIELD_VALUE_FEEDBACK || args.field === FIELD_VALUE_FEEDBACK_CLI_ALIAS) {
        process.stdout.write(`\n${valueFeedbackGateSummary(projectRoot)}\n`);
      }
    }
    return 0;
  }

  let fields = inspectAllPolicies(projectRoot);
  if (args.changedOnly) {
    fields = fields.filter((f) => f.source !== "default");
  }
  if (args.format === "json") {
    process.stdout.write(`${renderJson(fields)}\n`);
  } else {
    process.stdout.write(`${renderText(fields)}\n`);
  }
  return 0;
}

function runResolve(projectRoot: string): number {
  const result = resolvePolicy(projectRoot);
  process.stdout.write(
    `allowDirectCommitsToMaster=${String(result.allowDirectCommits).toLowerCase()}\n`,
  );
  process.stdout.write(`source=${result.source}\n`);
  if (result.deprecationWarning !== null) {
    process.stdout.write(`warning=${result.deprecationWarning}\n`);
  }
  if (result.error !== null) {
    process.stdout.write(`error=${result.error}\n`);
  }
  process.stdout.write(`${disclosureLine(result)}\n`);
  return 0;
}

function runEnableValueFeedback(args: SetArgs): number {
  const result = enableValueFeedback(pathResolve(args.projectRoot), {
    confirm: args.confirm,
    actor: args.actor,
    note: args.note,
  });
  process.stdout.write(result.stdout);
  return result.exitCode;
}

function runDisableHostHooks(args: SetArgs): number {
  const host = args.host;
  if (host === undefined) {
    process.stderr.write("policy: disable-host-hooks requires --host claude|cursor|grok|codex\n");
    return 2;
  }
  const result = disableHostHooks(pathResolve(args.projectRoot), {
    host,
    confirm: args.confirm,
    actor: args.actor,
    note: args.note,
  });
  process.stdout.write(result.stdout);
  return result.exitCode;
}

function runSet(args: SetArgs): number {
  const projectRoot = pathResolve(args.projectRoot);
  if (args.cmd === "allow-direct-commits" && !args.confirm) {
    process.stdout.write(`${CAPABILITY_COST_DISCLOSURE}\n\n`);
    process.stdout.write(
      `Re-run with --confirm to apply: ${policyColonInvocation("allow-direct-commits", " -- --confirm")}\n`,
    );
    return 1;
  }

  const target = args.cmd === "allow-direct-commits";
  try {
    const { changed, auditEntry } = setPolicy(projectRoot, {
      allowDirectCommits: target,
      actor: args.actor,
      note: args.note,
    });
    const state = target ? "OFF" : "ON";
    process.stdout.write(
      `\u2713 plan.policy.allowDirectCommitsToMaster=${target ? "true" : "false"} ` +
        `(branch-protection ${state}).\n`,
    );
    if (changed) {
      process.stdout.write(`  audit: meta/policy-changes.log :: ${auditEntry}\n`);
    } else {
      process.stdout.write(`${POLICY_AUDIT_NOOP_STDOUT}\n`);
    }
    process.stdout.write(`${disclosureLine(resolvePolicy(projectRoot))}\n`);
    return 0;
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes("PROJECT-DEFINITION not found")) {
      process.stderr.write(`\u274c ${message}\n`);
      const pdRel = relative(projectRoot, projectDefinitionPath(projectRoot));
      process.stderr.write(`  Recovery: run \`task setup\` to generate ${pdRel}.\n`);
      return 2;
    }
    process.stderr.write(`\u274c Config error: ${message}\n`);
    return 2;
  }
}

function runClearValueFeedback(args: SetArgs): number {
  const result = clearValueFeedback(pathResolve(args.projectRoot), {
    actor: args.actor,
    note: args.note,
  });
  process.stdout.write(result.stdout);
  return result.exitCode;
}

/** Create root `.no-deft-directive` opt-out flag (#2926). Does not delete deposits. */
function runDisableDirective(args: SetArgs): number {
  const projectRoot = pathResolve(args.projectRoot);
  const before = detectNoDeftDirective(projectRoot);
  if (before.present) {
    process.stdout.write(`${NO_DEFT_DIRECTIVE_DISABLED_MESSAGE} (already present)\n`);
    if (before.inconsistent) {
      process.stderr.write(`${NO_DEFT_DIRECTIVE_INCONSISTENT_MESSAGE}\n`);
      return 1;
    }
    return 0;
  }
  const path = createNoDeftDirectiveFlag(projectRoot, {
    rationale: args.note.trim().length > 0 ? args.note.trim() : undefined,
  });
  process.stdout.write(`Created ${NO_DEFT_DIRECTIVE_FLAG_NAME} at ${path}\n`);
  process.stdout.write(`${NO_DEFT_DIRECTIVE_DISABLED_MESSAGE}\n`);
  const after = detectNoDeftDirective(projectRoot);
  if (after.inconsistent) {
    process.stderr.write(`${NO_DEFT_DIRECTIVE_INCONSISTENT_MESSAGE}\n`);
    return 1;
  }
  return 0;
}

/** Remove root `.no-deft-directive` so Directive may be installed/used again (#2926). */
function runEnableDirective(args: SetArgs): number {
  const projectRoot = pathResolve(args.projectRoot);
  const removed = removeNoDeftDirectiveFlag(projectRoot);
  if (removed) {
    process.stdout.write(`Removed ${NO_DEFT_DIRECTIVE_FLAG_NAME}\n`);
  } else {
    process.stdout.write(`${NO_DEFT_DIRECTIVE_FLAG_NAME} was not present\n`);
  }
  process.stdout.write(
    "Directive opt-out cleared. Run `directive init` or `directive update` to ensure install.\n",
  );
  return 0;
}

/** Allow agent/bot merge by writing requireHumanMerge=false (#1193). */
function runAllowBotMerge(args: SetArgs): number {
  const projectRoot = pathResolve(args.projectRoot);
  if (!args.confirm) {
    process.stdout.write(`${ALLOW_BOT_MERGE_CAPABILITY_COST}\n\n`);
    process.stdout.write(
      `Re-run with --confirm to apply: ${policyColonInvocation("allow-bot-merge", " -- --confirm")}\n`,
    );
    return 1;
  }
  try {
    const { changed, auditEntry } = setRequireHumanMerge(projectRoot, {
      requireHumanMerge: false,
      actor: args.actor,
      note: args.note,
    });
    process.stdout.write(
      `\u2713 plan.policy.requireHumanMerge=false (human merge gate OFF; agent may merge).\n`,
    );
    if (changed) {
      process.stdout.write(`  audit: meta/policy-changes.log :: ${auditEntry}\n`);
    } else {
      process.stdout.write(`${POLICY_AUDIT_NOOP_STDOUT}\n`);
    }
    const line = humanMergeDisclosureLine(resolveHumanMergePolicy(projectRoot));
    if (line !== null) {
      process.stdout.write(`${line}\n`);
    } else {
      process.stdout.write(
        "[deft policy] Human merge gate is OFF; agent may merge when other gates allow.\n",
      );
    }
    return 0;
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes("PROJECT-DEFINITION not found")) {
      process.stderr.write(`\u274c ${message}\n`);
      const pdRel = relative(projectRoot, projectDefinitionPath(projectRoot));
      process.stderr.write(`  Recovery: run \`task setup\` to generate ${pdRel}.\n`);
      return 2;
    }
    process.stderr.write(`\u274c Config error: ${message}\n`);
    return 2;
  }
}

/** Run the policy CLI; returns process exit code. */
export function run(argv: string[]): number {
  const args = parseArgs(argv);
  if (args.error !== undefined) {
    process.stderr.write(`policy: ${args.error}\n`);
    return 2;
  }
  if (args.cmd === "show") {
    return runShow({
      format: args.format,
      changedOnly: args.changedOnly,
      field: args.field,
      projectRoot: args.projectRoot,
    });
  }
  if (args.cmd === "resolve") {
    return runResolve(pathResolve(args.projectRoot));
  }
  if (args.cmd === "enforce-branches" || args.cmd === "allow-direct-commits") {
    return runSet(args);
  }
  if (args.cmd === "allow-bot-merge") {
    return runAllowBotMerge(args);
  }
  if (args.cmd === "enable-value-feedback") {
    return runEnableValueFeedback(args);
  }
  if (args.cmd === "disable-host-hooks") {
    return runDisableHostHooks(args);
  }
  if (args.cmd === "clear-value-feedback") {
    return runClearValueFeedback(args);
  }
  if (args.cmd === "set-ceremony-dial") {
    return runSetCeremonyDial(args);
  }
  if (args.cmd === "disable-directive") {
    return runDisableDirective(args);
  }
  if (args.cmd === "enable-directive") {
    return runEnableDirective(args);
  }
  return 2;
}

/** Persist plan.policy.ceremonyDial override/enabled (#3214). */
function runSetCeremonyDial(args: SetArgs): number {
  const root = pathResolve(args.projectRoot);
  if (args.ceremonyOverride === undefined && args.ceremonyEnabled === undefined) {
    process.stdout.write(
      "usage: policy set-ceremony-dial -- --confirm [--override minimal|rapid|standard|elevated|null] [--enabled true|false] [--project-root PATH]\n" +
        `  Inspect: ${policyColonInvocation("show", " --field=ceremonyDial")}\n`,
    );
    return 1;
  }
  const result = setCeremonyDial(root, {
    confirm: args.confirm,
    actor: args.actor,
    note: args.note,
    ...(args.ceremonyOverride !== undefined ? { override: args.ceremonyOverride } : {}),
    ...(args.ceremonyEnabled !== undefined ? { enabled: args.ceremonyEnabled } : {}),
  });
  process.stdout.write(result.stdout);
  return result.exitCode;
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exit(run(process.argv.slice(2)));
}
