import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { contentRoot } from "../content-root.js";
import { agentsRefreshPlan, hasV3ManagedMarker } from "./agents-md.js";
import { runChecks } from "./checks.js";
import {
  EXPECTED_CONTENT_DIRS,
  EXPECTED_FRAMEWORK_DIRS,
  TASKFILE_INCLUDE_SNIPPET,
  UV_INSTALL_URL,
} from "./constants.js";
import {
  decideThrottle,
  formatIsoZ,
  readState,
  renderDoctorStatusLine,
  writeState,
} from "./doctor-state.js";
import { formatAllowedFlagsHint, formatUnknownFlagsError, parseDoctorFlags } from "./flags.js";
import { pythonJsonDump } from "./json.js";
import { createPlainSink } from "./output.js";
import {
  resolveDefaultFrameworkRoot,
  resolvePath,
  resolveVersion,
  runningInsideDeftRepo,
} from "./paths.js";
import { runPayloadStalenessCheck } from "./payload-staleness.js";
import {
  classifyTaskfileInclude,
  formatMissingIncludeSnippet,
  resolveConsumerTaskfile,
} from "./taskfile.js";
import type { DoctorSeams, Finding } from "./types.js";
import { defaultWhich } from "./which.js";

export function cmdDoctor(args: readonly string[], seams: DoctorSeams = {}): number {
  const flags = parseDoctorFlags(args);
  if (flags.unknown.length > 0) {
    const sink = createPlainSink();
    sink.error(formatUnknownFlagsError(flags.unknown));
    sink.info(formatAllowedFlagsHint());
    return 2;
  }

  const sessionMode = flags.session;
  const fixMode = flags.fix && !sessionMode;
  const jsonMode = flags.json;
  const quietMode = flags.quiet;
  const fullMode = flags.full;
  const projectRoot = resolvePath(flags.projectRoot ?? process.cwd());
  const frameworkRoot = seams.frameworkRoot ?? resolveDefaultFrameworkRoot();
  const whichFn = seams.whichFn ?? defaultWhich;
  const nowFn = seams.now ?? (() => new Date());

  if (!fullMode) {
    const state = (seams.readState ?? readState)(projectRoot);
    const decision = decideThrottle(state, nowFn());
    if (decision.skip) {
      const hint = decision.dirty
        ? "run `deft doctor --full` to re-probe or address findings"
        : "--full forces";
      if (jsonMode) {
        const payload = {
          status: "throttle-skipped",
          last_run_at: formatIsoZ(decision.lastRunAt),
          last_exit_code: decision.lastExitCode,
          last_finding_count: decision.lastFindingCount,
          last_error_count: decision.lastErrorCount,
          next_eligible_at: formatIsoZ(decision.nextEligibleAt),
          hint,
        };
        process.stdout.write(`${pythonJsonDump(payload)}\n`);
      } else {
        process.stdout.write(`${renderDoctorStatusLine(decision, nowFn())}\n`);
      }
      return decision.dirty ? 1 : 0;
    }
  }

  const findings: Finding[] = [];
  const addFinding = (finding: Finding) => {
    findings.push(finding);
  };
  const sink = createPlainSink({ jsonMode, quietMode });

  if (!jsonMode) {
    sink.header(`Deft CLI v${resolveVersion(frameworkRoot)} - Doctor`);
    sink.blank();
  }
  sink.info("Checking system dependencies...");
  if (!jsonMode) {
    sink.blank();
  }

  const checkCommand = (cmd: string, name: string, required = false, installUrl = ""): void => {
    if (whichFn(cmd)) {
      sink.success(`${name} is installed`);
      return;
    }
    const urlHint = installUrl ? ` - install: ${installUrl}` : "";
    if (required) {
      const message = `${name} not found - required${urlHint}`;
      sink.error(message);
      addFinding({
        severity: "error",
        message,
        check: "dependency",
        tool: cmd,
        suggestion: installUrl || null,
      });
      return;
    }
    const message =
      cmd === "task"
        ? `${name} not found - install from https://taskfile.dev`
        : `${name} not found${urlHint}`;
    sink.warn(message);
    addFinding({
      severity: "warning",
      message,
      check: "dependency",
      tool: cmd,
      suggestion: installUrl || null,
    });
  };

  checkCommand("uv", "uv (Astral Python runner)", true, UV_INSTALL_URL);
  checkCommand("git", "git", true);
  checkCommand("python3", "python3");
  checkCommand("go", "go");
  checkCommand("node", "node");

  if (!jsonMode) {
    sink.blank();
  }
  sink.info("Checking install integrity...");
  runInstallIntegrityChecks(projectRoot, sink, addFinding, seams);

  if (!jsonMode) {
    sink.blank();
  }
  sink.info("Checking AGENTS.md managed-section freshness...");
  runAgentsMdFreshnessCheck(projectRoot, sink, addFinding, seams);

  if (!jsonMode) {
    sink.blank();
  }
  sink.info("Checking payload staleness from install manifest...");
  runPayloadStalenessCheck(projectRoot, sink, addFinding, {
    frameworkRoot,
    readText: seams.readText,
    isFile: seams.isFile,
    runGitLsRemote: seams.runGitLsRemote,
  });

  if (!jsonMode) {
    sink.blank();
  }
  sink.info("Checking Deft structure...");
  const isDir =
    seams.isDir ??
    ((p: string) => {
      try {
        return statSync(p).isDirectory();
      } catch {
        return false;
      }
    });
  // #1875: shippable-content dirs resolve under content/ in a source checkout
  // and at the root in a flattened consumer deposit; engine/lifecycle dirs stay
  // at the framework root in both layouts.
  const contentBase = contentRoot(frameworkRoot);
  const layoutChecks: Array<[dirName: string, base: string]> = [
    ...EXPECTED_CONTENT_DIRS.map((d) => [d, contentBase] as [string, string]),
    ...EXPECTED_FRAMEWORK_DIRS.map((d) => [d, frameworkRoot] as [string, string]),
  ];
  for (const [dirName, base] of layoutChecks) {
    const dirPath = join(base, dirName);
    if (isDir(dirPath)) {
      sink.success(`Directory: ${dirName}/`);
    } else {
      const message = `Missing directory: ${dirName}/`;
      sink.warn(message);
      addFinding({
        severity: "warning",
        message,
        check: "framework-layout",
        directory: dirName,
      });
    }
  }

  if (!jsonMode) {
    sink.blank();
  }
  sink.info("Checking optional root Taskfile.yml include...");
  runTaskfileIncludeCheck(projectRoot, fixMode, jsonMode, sink, addFinding, seams);

  const errorCount = findings.filter((f) => f.severity === "error").length;
  const warningCount = findings.filter((f) => f.severity === "warning").length;
  const exitCode = errorCount > 0 ? 1 : 0;

  const persist = seams.writeState ?? writeState;
  persist(projectRoot, {
    exitCode,
    findingCount: findings.filter((f) => f.severity !== "skip").length,
    errorCount,
    now: nowFn(),
  });

  if (jsonMode) {
    const payload = {
      status: "completed",
      ok: exitCode === 0,
      findings,
      summary: { errors: errorCount, warnings: warningCount },
      project_root: projectRoot,
    };
    process.stdout.write(`${pythonJsonDump(payload)}\n`);
    return exitCode;
  }

  sink.blank();
  if (errorCount === 0 && warningCount === 0) {
    sink.finalSuccess("System check passed!");
    return 0;
  }
  if (errorCount) {
    sink.finalError(
      `System check failed with ${errorCount} error(s)` +
        (warningCount ? ` and ${warningCount} warning(s)` : "") +
        ".",
    );
    return 1;
  }
  sink.finalWarn(`System check completed with ${warningCount} warning(s).`);
  return 0;
}

function runInstallIntegrityChecks(
  projectRoot: string,
  sink: ReturnType<typeof createPlainSink>,
  addFinding: (f: Finding) => void,
  seams: DoctorSeams,
): void {
  if (runningInsideDeftRepo(projectRoot, seams)) {
    sink.info(
      "Skipping install-integrity checks -- running inside the deft framework repo (no install manifest in the source checkout).",
    );
    return;
  }
  try {
    const isDir =
      seams.isDir ??
      ((p: string) => {
        try {
          return statSync(p).isDirectory();
        } catch {
          return false;
        }
      });
    const isFile = seams.isFile ?? ((p: string) => existsSync(p));
    const readText =
      seams.readText ??
      ((p: string) => {
        try {
          if (!existsSync(p)) return null;
          return readFileSync(p, "utf8");
        } catch {
          return null;
        }
      });
    const result = runChecks(projectRoot, { isDir, isFile, readText });
    for (const entry of (result.checks as Array<Record<string, unknown>>) ?? []) {
      const name = String(entry.name ?? "install-integrity");
      const status = String(entry.status ?? "");
      const detail = String(entry.detail ?? "");
      if (status === "pass") {
        sink.success(`${name}: pass`);
        continue;
      }
      if (status === "skip") {
        sink.info(`${name}: skip -- ${detail}`);
        continue;
      }
      if (status === "error") {
        sink.error(`${name}: error -- ${detail}`);
      } else {
        sink.error(`${name}: fail -- ${detail}`);
      }
      addFinding({
        severity: "error",
        message: detail || `${name} ${status}`,
        check: `install-integrity:${name}`,
        install_check: name,
        status,
        data: (entry.data as Record<string, unknown>) ?? {},
      });
    }
    for (const err of (result.errors as string[]) ?? []) {
      sink.error(String(err));
      addFinding({
        severity: "error",
        message: String(err),
        check: "install-integrity",
      });
    }
  } catch (exc) {
    const message = `Install-integrity probe unavailable: ${exc instanceof Error ? exc.name : "Error"}: ${exc}`;
    sink.warn(message);
    addFinding({ severity: "warning", message, check: "install-integrity" });
  }
}

function runAgentsMdFreshnessCheck(
  projectRoot: string,
  sink: ReturnType<typeof createPlainSink>,
  addFinding: (f: Finding) => void,
  seams: DoctorSeams,
): void {
  const checkName = "agents-md-managed-section-fresh";
  if (
    runningInsideDeftRepo(projectRoot, seams) ||
    !hasV3ManagedMarker(projectRoot, seams.readText)
  ) {
    const skipReason = "no managed-section markers (likely maintainer repo)";
    sink.info(`${checkName}: skip -- ${skipReason}`);
    addFinding({ severity: "skip", message: skipReason, check: checkName, status: "skip" });
    return;
  }
  try {
    const planFn = seams.agentsRefreshPlan ?? ((root: string) => agentsRefreshPlan(root));
    const plan = planFn(projectRoot);
    const state = String(plan.state ?? "");
    if (state === "current") {
      sink.success(`${checkName}: current`);
      return;
    }
    if (state === "stale" || state === "missing" || state === "absent") {
      const message = `AGENTS.md managed section is ${state} -- run \`deft agents:refresh\` to bring it to the current template.`;
      sink.warn(message);
      addFinding({
        severity: "warning",
        message,
        check: checkName,
        status: state,
        suggestion: "deft agents:refresh",
      });
      return;
    }
    const message = `AGENTS.md freshness check could not run (state='${state}'). Inspect the framework template or AGENTS.md file permissions.`;
    sink.warn(message);
    addFinding({ severity: "warning", message, check: checkName, status: state });
  } catch (exc) {
    const message = `${checkName}: probe failed -- ${exc instanceof Error ? exc.name : "Error"}: ${exc}`;
    sink.warn(message);
    addFinding({ severity: "warning", message, check: checkName });
  }
}

function runTaskfileIncludeCheck(
  projectRoot: string,
  fixMode: boolean,
  jsonMode: boolean,
  sink: ReturnType<typeof createPlainSink>,
  addFinding: (f: Finding) => void,
  seams: DoctorSeams,
): void {
  if (runningInsideDeftRepo(projectRoot, seams)) {
    sink.info(
      "Skipping Taskfile include check -- running inside the deft framework repo (the repo's own Taskfile.yml is the surface).",
    );
    return;
  }
  const includeStatus = classifyTaskfileInclude(projectRoot);
  if (includeStatus === "ok") {
    sink.success("Root Taskfile.yml includes the deft framework");
    return;
  }
  if (includeStatus === "missing-file") {
    let includeMissing = true;
    const target = join(projectRoot, "Taskfile.yml");
    const message =
      "Root Taskfile.yml missing. This is OK for package-manager installs that use the `deft X` surface directly. To also enable the optional `task deft:X` surface, paste this into " +
      `${target}:`;
    sink.info(message);
    if (!jsonMode) {
      sink.blank();
      sink.raw(TASKFILE_INCLUDE_SNIPPET);
    }
    const isTty = seams.isTty ?? (() => process.stdin.isTTY === true);
    const readYn = seams.readYn ?? (() => false);
    const writeText =
      seams.writeText ?? ((p: string, c: string) => writeFileSync(p, c, { encoding: "utf8" }));
    if (fixMode && !jsonMode && isTty()) {
      if (readYn(`Create ${target} with the canonical include now?`, false)) {
        try {
          writeText(target, TASKFILE_INCLUDE_SNIPPET);
          sink.success(`Wrote ${target}`);
          includeMissing = false;
        } catch (exc) {
          sink.error(`Failed to write ${target}: ${exc}`);
        }
      } else {
        sink.info("Skipped Taskfile.yml creation -- paste the snippet above when you are ready.");
      }
    }
    if (includeMissing) {
      addFinding({
        severity: "warning",
        message: "Root Taskfile.yml missing; optional Taskfile include unavailable",
        check: "taskfile-include",
        file: target,
        suggestion: TASKFILE_INCLUDE_SNIPPET,
      });
    }
    return;
  }
  if (includeStatus === "missing-include") {
    const message =
      "Root Taskfile.yml exists but does not include the deft framework. The `deft X` surface still works; add this to the Taskfile `includes:` block only if you want the optional `task deft:X` surface (doctor NEVER mutates an existing user-owned Taskfile):";
    sink.warn(message);
    if (!jsonMode) {
      sink.blank();
      sink.raw(formatMissingIncludeSnippet());
    }
    const tf = resolveConsumerTaskfile(projectRoot);
    addFinding({
      severity: "warning",
      message: "Root Taskfile.yml does not include the deft framework",
      check: "taskfile-include",
      file: tf,
      suggestion: formatMissingIncludeSnippet(),
    });
    return;
  }
  const taskfilePath = resolveConsumerTaskfile(projectRoot) ?? join(projectRoot, "Taskfile.yml");
  const message = `Root Taskfile.yml at ${taskfilePath} exists but could not be read -- check file permissions.`;
  sink.warn(message);
  addFinding({
    severity: "warning",
    message,
    check: "taskfile-include",
    file: taskfilePath,
  });
}
