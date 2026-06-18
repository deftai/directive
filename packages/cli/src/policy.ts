#!/usr/bin/env node
/**
 * Policy CLI (#1722): `policy:show` and `policy:allow-direct-commits` surfaces,
 * mirroring scripts/_policy_show_cli.py and scripts/policy_set.py.
 */
import { existsSync } from "node:fs";
import { join, resolve as pathResolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  disclosureLine,
  inspectAllPolicies,
  inspectOnePolicy,
  PROJECT_DEFINITION_REL_PATH,
  pythonListRepr,
  pythonStringRepr,
  registeredPolicyNames,
  renderJson,
  renderText,
  resolvePolicy,
  setPolicy,
} from "../../core/dist/policy/index.js";

const CAPABILITY_COST_DISCLOSURE =
  "\u26a0 Capability-cost disclosure -- enabling direct commits to the default " +
  "branch turns OFF the deft branch-protection policy.\n" +
  "  \u2022 Pre-commit + pre-push hooks will no longer block default-branch " +
  "commits.\n" +
  "  \u2022 verify:branch will pass on the default branch.\n" +
  "  \u2022 The CI sanity check (head_ref != base_ref) is still independent and " +
  "will continue to flag master->master PRs.\n" +
  "  \u2022 This change is reversible: run `task policy:enforce-branches` to " +
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
  cmd: "show" | "enforce-branches" | "allow-direct-commits" | "resolve";
  confirm: boolean;
  actor: string;
  note: string;
  projectRoot: string;
  format: "text" | "json";
  changedOnly: boolean;
  field: string | null;
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
    return makeSetError("usage: policy [show|enforce-branches|allow-direct-commits|resolve] ...");
  }

  const cmd = argv[0];
  if (cmd === "show") {
    const show = parseShowArgs(argv.slice(1));
    return {
      cmd: "show",
      confirm: false,
      actor: "task policy:show",
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

  if (cmd === "enforce-branches" || cmd === "allow-direct-commits") {
    let confirm = false;
    let actor =
      cmd === "enforce-branches"
        ? "task policy:enforce-branches"
        : "task policy:allow-direct-commits";
    let note = "";
    let projectRoot = ".";
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
      } else {
        return makeSetError(`unrecognized argument: ${arg}`);
      }
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
    };
  }

  return makeSetError(`unknown subcommand: ${cmd}`);
}

function runShow(args: ShowArgs): number {
  const projectRoot = pathResolve(args.projectRoot);
  const pdPath = join(projectRoot, PROJECT_DEFINITION_REL_PATH);
  if (!existsSync(pdPath)) {
    process.stderr.write(
      `[policy:show] PROJECT-DEFINITION not found at ${pdPath}; ` +
        "rendering framework defaults.\n",
    );
  }

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

function runSet(args: SetArgs): number {
  const projectRoot = pathResolve(args.projectRoot);
  if (args.cmd === "allow-direct-commits" && !args.confirm) {
    process.stdout.write(`${CAPABILITY_COST_DISCLOSURE}\n\n`);
    process.stdout.write(
      "Re-run with --confirm to apply: task policy:allow-direct-commits -- --confirm\n",
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
      process.stdout.write(
        "  no-op: value already matched (audit entry still appended for trail).\n",
      );
    }
    process.stdout.write(`${disclosureLine(resolvePolicy(projectRoot))}\n`);
    return 0;
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes("PROJECT-DEFINITION not found")) {
      process.stderr.write(`\u274c ${message}\n`);
      process.stderr.write(
        "  Recovery: run `task setup` to generate vbrief/PROJECT-DEFINITION.vbrief.json.\n",
      );
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
  return 2;
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exit(run(process.argv.slice(2)));
}
