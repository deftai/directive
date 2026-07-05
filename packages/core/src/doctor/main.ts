import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { evaluate as evaluateAgentsMdAdvisory } from "../agents-md-advisory/evaluate.js";
import { contentRoot } from "../content-root.js";
import {
  describeShadowedPlanExtension,
  detectShadowedPlanExtensions,
} from "../policy/plan-extensions.js";
import { loadProjectDefinition } from "../policy/resolve.js";
import {
  checkLocalEngineIntegrity,
  classify,
  detectPackageManager,
  evaluateSkew,
  type ResolutionFacts,
  reconcileVersions,
  plan as resolvePlan,
} from "../resolution/index.js";
import { type ResolveUserMdResult, resolveUserMdPath } from "../user-config/resolve-user-md.js";
import { agentsRefreshPlan, hasV3ManagedMarker } from "./agents-md.js";
import { runChecks } from "./checks.js";
import {
  CONSUMER_FRAMEWORK_DIRS,
  EXPECTED_CONTENT_DIRS,
  EXPECTED_FRAMEWORK_DIRS,
  NETWORK_DISCLOSURE_LINE,
  PAYLOAD_STALENESS_OFFLINE_SKIP_MESSAGE,
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
import { parseInstallRootFromAgentsMd } from "./manifest.js";
import { createPlainSink } from "./output.js";
import {
  readTextSafe,
  resolveDefaultFrameworkRoot,
  resolvePath,
  resolveVersion,
  runningInsideDeftRepo,
} from "./paths.js";
import { runPayloadStalenessCheck } from "./payload-staleness.js";
import { runLocalSignpostChecks } from "./signpost-checks.js";
import {
  classifyTaskfileInclude,
  formatMissingIncludeSnippet,
  includesBlockHasDeftTaskfile,
  resolveConsumerTaskfile,
} from "./taskfile.js";
import type { DoctorSeams, Finding, ResolutionSummary } from "./types.js";
import { defaultWhich } from "./which.js";

const DEFAULT_RESOLUTION_PLATFORMS = ["linux", "darwin", "win32"] as const;

/**
 * Read the `packageManager` field (Corepack) from a project package.json, or
 * null when absent/unreadable. Lets the doctor detect a pnpm project that has
 * no `pnpm-lock.yaml` yet (fresh Corepack clone) for the #2197 upgrade hint.
 */
function readPackageManagerField(
  packageJsonPath: string,
  readTextFn: (path: string) => string | null,
): string | null {
  const raw = readTextFn(packageJsonPath);
  if (raw === null) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const field = (parsed as Record<string, unknown>).packageManager;
      return typeof field === "string" ? field : null;
    }
  } catch {
    // Malformed package.json -- fall through to null (npm default).
  }
  return null;
}

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
  const consumerContext = resolve(projectRoot) !== resolve(frameworkRoot);
  const whichFn = seams.whichFn ?? defaultWhich;
  const nowFn = seams.now ?? (() => new Date());

  if (!fullMode) {
    const state = (seams.readState ?? readState)(projectRoot);
    const decision = decideThrottle(state, nowFn());
    if (decision.skip) {
      const throttleFindings: Finding[] = [];
      const throttleSink = createPlainSink({ jsonMode, quietMode });
      runLocalSignpostChecks(
        projectRoot,
        throttleSink,
        (finding) => {
          throttleFindings.push(finding);
        },
        seams,
      );
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
          ...(throttleFindings.length > 0 ? { signpost_findings: throttleFindings } : {}),
        };
        process.stdout.write(`${pythonJsonDump(payload)}\n`);
      } else {
        process.stdout.write(`${renderDoctorStatusLine(decision, nowFn())}\n`);
      }
      const signpostWarnings = throttleFindings.filter((f) => f.severity === "warning").length;
      if (signpostWarnings > 0 && !jsonMode) {
        throttleSink.finalWarn(
          `Signpost advisory: ${signpostWarnings} local layout / npm-migration note(s) above (throttle-skipped full probe).`,
        );
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

  if (!consumerContext) {
    checkCommand("uv", "uv (Astral Python runner)", true, UV_INSTALL_URL);
    checkCommand("python3", "python3");
    checkCommand("go", "go");
  }
  checkCommand("git", "git", true);
  checkCommand("node", "node", consumerContext);

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
  sink.info("Checking AGENTS.md legibility (advisory)...");
  runAgentsMdAdvisoryCheck(projectRoot, sink, addFinding, seams);

  if (!jsonMode) {
    sink.blank();
  }
  // #2182: payload-staleness is the only doctor check that can reach a
  // registry (git remote, then npm as a fallback). It stays in the OFFLINE
  // tier (skipped) unless the operator explicitly opts into the NETWORK tier
  // via `--network`, and the tool + registry class is disclosed BEFORE the
  // check runs -- never silently, never as a side effect of a read-only
  // `deft doctor` invocation (e.g. from the gated session-ritual step).
  if (flags.network) {
    sink.info(NETWORK_DISCLOSURE_LINE);
    sink.info("Checking payload staleness from install manifest...");
    // Detect the package manager for the upgrade recommendation from signals
    // that are meaningful for a globally-installed CLI: the explicit
    // DEFT_PACKAGE_MANAGER override, the project's `packageManager` field
    // (Corepack), and the project's pnpm-lock.yaml. We deliberately do NOT
    // consult the ambient npm_config_user_agent here (it is set by whatever
    // shell/script spawned the process, not by the consumer's project) so the
    // recommendation is a stable property of the project (#2197).
    const readTextForPm = seams.readText ?? readTextSafe;
    const isFileForPm = seams.isFile ?? ((p: string) => existsSync(p));
    const packageManager = detectPackageManager({
      env: { DEFT_PACKAGE_MANAGER: process.env.DEFT_PACKAGE_MANAGER },
      packageManagerField: readPackageManagerField(
        join(projectRoot, "package.json"),
        readTextForPm,
      ),
      pnpmLockPresent: isFileForPm(join(projectRoot, "pnpm-lock.yaml")),
    });
    runPayloadStalenessCheck(projectRoot, sink, addFinding, {
      frameworkRoot,
      readText: seams.readText,
      isFile: seams.isFile,
      runGitLsRemote: seams.runGitLsRemote,
      runNpmViewVersion: seams.runNpmViewVersion,
      packageManager,
    });
  } else {
    sink.info(`payload-staleness: ${PAYLOAD_STALENESS_OFFLINE_SKIP_MESSAGE}`);
    addFinding({
      severity: "skip",
      message: PAYLOAD_STALENESS_OFFLINE_SKIP_MESSAGE,
      check: "payload-staleness",
      status: "skip",
      reason: "offline-tier",
    });
  }

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
  let agentsMdText = "";
  try {
    agentsMdText = readFileSync(join(projectRoot, "AGENTS.md"), "utf8");
  } catch {
    agentsMdText = "";
  }
  const installRootRel = parseInstallRootFromAgentsMd(agentsMdText) ?? ".deft/core";
  const depositRoot = consumerContext ? join(projectRoot, installRootRel) : frameworkRoot;
  const contentBase = contentRoot(depositRoot);
  const frameworkDirs = consumerContext ? CONSUMER_FRAMEWORK_DIRS : EXPECTED_FRAMEWORK_DIRS;
  const layoutChecks: Array<[dirName: string, base: string]> = [
    ...EXPECTED_CONTENT_DIRS.map((d) => [d, contentBase] as [string, string]),
    ...frameworkDirs.map((d) => [d, depositRoot] as [string, string]),
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
  sink.info("Checking USER.md resolution...");
  const userMd = runUserMdResolutionCheck(projectRoot, sink, addFinding, seams);

  if (!jsonMode) {
    sink.blank();
  }
  sink.info("Checking plan.policy namespacing (shadowed bare keys)...");
  runPlanExtensionShadowCheck(projectRoot, sink, addFinding, seams);

  if (!jsonMode) {
    sink.blank();
  }
  sink.info("Checking optional root Taskfile.yml include...");
  runTaskfileIncludeCheck(projectRoot, fixMode, jsonMode, sink, addFinding, seams);

  let resolution: ResolutionSummary | null = null;
  if (!runningInsideDeftRepo(projectRoot, seams)) {
    if (!jsonMode) {
      sink.blank();
      sink.info("Resolution -- operating mode + single next action (from shared plan())...");
    }
    resolution = runResolutionDecision(projectRoot, jsonMode, sink, addFinding, seams);
  }

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
      user_md: {
        path: userMd.path,
        rung: userMd.rung,
        found: userMd.found,
        diagnostic: userMd.diagnostic,
      },
      ...(resolution
        ? {
            resolution: {
              mode: resolution.mode,
              operating_mode: resolution.operatingMode,
              reconciliation: resolution.reconciliation,
              platform_skew: resolution.platformSkew,
              platform_skew_detected: resolution.platformSkewDetected,
              action_required: resolution.actionRequired,
              next_command: resolution.nextCommand,
              root_cause: resolution.rootCause,
              remediation: resolution.remediation,
              warnings: resolution.warnings,
            },
          }
        : {}),
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
      if (
        (name === "legacy-layout" ||
          name === "canonical-vendored-npm-signpost" ||
          name === "manifest-version-reportable") &&
        status === "fail"
      ) {
        sink.warn(`${name}: ${detail}`);
        addFinding({
          severity: "warning",
          message: detail || `${name} ${status}`,
          check: `install-integrity:${name}`,
          install_check: name,
          status,
          data: (entry.data as Record<string, unknown>) ?? {},
        });
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

/**
 * Advisory (never-failing) consumer AGENTS.md legibility signal (#2155).
 *
 * Reports the unmanaged (project-authored) region size against the soft budget
 * (`plan.policy.agentsMdAdvisory.unmanagedSoftMaxLines`, generous by default).
 * The managed section is EXCLUDED. This is the consumer companion to the
 * maintainer-only #645 ratchet and follows the advise -> observe -> enforce
 * posture (#1419): it emits at most a `warning` finding, NEVER an `error`, so
 * `deft doctor` (and the `check:consumer` aggregate that depends on it) can
 * never fail-close on a judgment call about the consumer's own file.
 */
function runAgentsMdAdvisoryCheck(
  projectRoot: string,
  sink: ReturnType<typeof createPlainSink>,
  addFinding: (f: Finding) => void,
  seams: DoctorSeams,
): void {
  const checkName = "agents-md-advisory";
  // Only meaningful for consumer installs (managed markers present). In the
  // maintainer repo the #645 ratchet owns this file, so skip -- mirrors the
  // freshness check's guard above.
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
    const evalFn =
      seams.agentsMdAdvisoryEvaluate ?? ((root: string) => evaluateAgentsMdAdvisory(root));
    const result = evalFn(projectRoot);
    if (result.over && result.counts !== null) {
      const message =
        `AGENTS.md unmanaged (project-authored) region is ${result.counts.unmanaged} lines, ` +
        `over the soft budget of ${result.softMaxLines} (advisory only -- your build is NOT ` +
        "affected). AGENTS.md is a map, not a manual (#1882): push detail into a reference doc " +
        "and leave a pointer (see content/docs/good-agents-md.md). Raise " +
        "plan.policy.agentsMdAdvisory.unmanagedSoftMaxLines to accept the growth and silence this.";
      sink.warn(message);
      addFinding({
        severity: "warning",
        message,
        check: checkName,
        status: "over-soft-budget",
        suggestion: "content/docs/good-agents-md.md",
      });
      return;
    }
    if (result.counts !== null) {
      sink.success(
        `${checkName}: unmanaged region ${result.counts.unmanaged}/${result.softMaxLines} lines (within soft budget)`,
      );
      return;
    }
    // No counts (missing / unreadable / malformed AGENTS.md): advisory stays
    // silent-but-informational; never a doctor error.
    sink.info(`${checkName}: skip -- AGENTS.md not measurable`);
    addFinding({
      severity: "skip",
      message: "AGENTS.md not measurable",
      check: checkName,
      status: "skip",
    });
  } catch (exc) {
    // Sanitize newlines so an error string can't break out of the markdown
    // bullet when findings are rendered (CWE-116).
    const detail = `${exc instanceof Error ? exc.name : "Error"}: ${exc}`.replace(/\r?\n/g, " ");
    const message = `${checkName}: probe failed -- ${detail}`;
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

/**
 * Surface the resolved USER.md path + which search rung matched (#2271) so the
 * resolution boundary is visible in doctor output. Uses the shared first-hit-
 * wins resolver, which never throws: an absent USER.md degrades to a `no
 * USER.md found; using defaults` diagnostic. This check never fails the doctor
 * — it emits a `skip`-severity finding (informational) in both states.
 */
function runUserMdResolutionCheck(
  projectRoot: string,
  sink: ReturnType<typeof createPlainSink>,
  addFinding: (f: Finding) => void,
  seams: DoctorSeams,
): ResolveUserMdResult {
  const resolveFn =
    seams.resolveUserMd ?? ((root: string) => resolveUserMdPath({ projectRoot: root }));
  const result = resolveFn(projectRoot);
  // Sanitize newlines on the data-derived path/diagnostic before it lands in a
  // rendered bullet (CWE-116).
  const safePath = result.path.replace(/\r?\n/g, " ");
  const safeDiagnostic = result.diagnostic.replace(/\r?\n/g, " ");
  if (result.found) {
    sink.success(`USER.md resolved (${result.rung}): ${safePath}`);
  } else {
    sink.info(`USER.md: ${safeDiagnostic}`);
  }
  addFinding({
    severity: "skip",
    message: result.found ? `USER.md resolved (${result.rung}): ${safePath}` : safeDiagnostic,
    check: "user-md-resolution",
    status: result.found ? "resolved" : "defaulted",
    path: safePath,
    rung: result.rung,
    found: result.found,
  });
  return result;
}

/**
 * Loud shadow diagnostic (#2301): flag every plan-extension key whose bare form
 * (e.g. `plan.policy`) coexists with the namespaced form (`plan.x-directive/policy`).
 * Because the reader is namespace-first, the bare block is silently ignored --
 * the exact "edit takes no effect, no warning" trap behind #2295. Emits a
 * `warning` finding per shadowed key; never an `error`, so `deft doctor` stays
 * green on a merely-legibility issue. A clean project reports a `skip` finding.
 */
function runPlanExtensionShadowCheck(
  projectRoot: string,
  sink: ReturnType<typeof createPlainSink>,
  addFinding: (f: Finding) => void,
  seams: DoctorSeams,
): void {
  const checkName = "plan-extension-shadow";
  const detect =
    seams.detectPlanExtensionShadows ??
    ((root: string) => {
      const [data] = loadProjectDefinition(root);
      return data === null ? [] : detectShadowedPlanExtensions(data.plan);
    });
  try {
    const shadows = detect(projectRoot);
    if (shadows.length === 0) {
      const cleanMessage = `${checkName}: no shadowed bare plan keys`;
      sink.success(cleanMessage);
      addFinding({ severity: "skip", message: cleanMessage, check: checkName, status: "clean" });
      return;
    }
    for (const shadow of shadows) {
      const message = `plan.policy shadow -- ${describeShadowedPlanExtension(shadow)}`.replace(
        /\r?\n/g,
        " ",
      );
      sink.warn(message);
      addFinding({
        severity: "warning",
        message,
        check: checkName,
        status: "shadowed",
        namespaced_key: shadow.namespacedKey,
        legacy_key: shadow.legacyKey,
        shadowed_sub_keys: [...shadow.shadowedSubKeys],
      });
    }
  } catch (exc) {
    const detail = `${exc instanceof Error ? exc.name : "Error"}: ${exc}`.replace(/\r?\n/g, " ");
    const message = `${checkName}: probe failed -- ${detail}`;
    sink.warn(message);
    addFinding({ severity: "warning", message, check: checkName });
  }
}

/**
 * Never emit a bare `task ...` remediation in a project without Taskfile wiring
 * (#2267). The `directive` surface always works; `task deft:X` is optional and
 * only present when the consumer wired the include. `plan()` already emits the
 * `directive` / `npx` / `npm` surface, so this guard is a defensive invariant:
 * any `task`-prefixed command is rewritten to the `directive` surface unless the
 * project actually has the include.
 */
/**
 * Detect Taskfile wiring through the injected seam (#2267). Mirrors
 * `classifyTaskfileInclude` but routes the filesystem read through
 * `seams.readText` so the resolution decision stays deterministic + injectable
 * in tests -- unlike a direct `classifyTaskfileInclude(projectRoot)` call, which
 * bypasses every other seam-flowed probe in `runResolutionDecision`.
 */
export function resolveTaskfileWiring(projectRoot: string, seams: DoctorSeams): boolean {
  const readText =
    seams.readText ??
    ((path: string): string | null => {
      try {
        return readFileSync(path, "utf8");
      } catch {
        return null;
      }
    });
  for (const name of ["Taskfile.yml", "Taskfile.yaml"]) {
    const text = readText(join(projectRoot, name));
    if (text !== null) {
      return includesBlockHasDeftTaskfile(text.replace(/^\uFEFF/, ""));
    }
  }
  return false;
}

export function enforceDirectiveSurface(
  command: string | null,
  hasTaskfileWiring: boolean,
): string | null {
  if (command === null) {
    return null;
  }
  if (!hasTaskfileWiring && /^\s*task\s+/.test(command)) {
    return command.replace(/^\s*task\s+/, "directive ");
  }
  return command;
}

/** Human-facing operating mode derived from the orthogonal fact-set. */
export function resolveOperatingMode(facts: ResolutionFacts): string {
  if (facts.preCutoverArtifacts) {
    return "pre-cutover (pre-v0.20 document model -- migrate first)";
  }
  if (!facts.hasDeftCore) {
    if (facts.hasManagedSection) {
      return "hybrid (managed AGENTS.md present; .deft/core/ payload not reconstituted)";
    }
    return facts.hasAppCode || facts.hasGit
      ? "brownfield (existing project, no Deft deposit)"
      : "greenfield (no Deft deposit)";
  }
  return facts.hasManagedSection
    ? "hybrid (vendored .deft/core/ + managed AGENTS.md)"
    : "vendored (.deft/core/ deposit, no managed AGENTS.md section)";
}

/**
 * Single engine/pin/VERSION reconciliation line. `reconcileVersions` flags
 * content-behind/ahead and engine-behind; engine-ahead skew is folded in here so
 * the line is the one version-state summary the operator reads.
 */
export function resolveReconciliationLine(facts: ResolutionFacts): string {
  const engine = facts.engineVersion ?? "unreachable";
  const content = facts.deftCorePayloadVersion ?? "none";
  const pin = facts.pinVersion ?? "none";
  const recon = reconcileVersions({
    pinVersion: facts.pinVersion,
    engineVersion: facts.engineVersion,
    contentVersion: facts.deftCorePayloadVersion,
    managedSectionSha: facts.managedSectionSha,
  });
  const notes: string[] = [...recon.mismatches];
  if (facts.engineVersion !== null && facts.pinVersion !== null) {
    const skew = evaluateSkew(facts.engineVersion, facts.pinVersion, {});
    if (skew.band === "within-window" || skew.band === "beyond-window") {
      notes.push(skew.message ?? `engine ${facts.engineVersion} ahead of pin ${facts.pinVersion}`);
    }
  }
  // Without a committed pin there is nothing to reconcile against, so never
  // claim "aligned" — that would contradict a Next command that tells the
  // operator to init / commit a pin (Greptile #2283 display-accuracy).
  let rawVerdict: string;
  if (facts.pinVersion === null) {
    rawVerdict =
      facts.engineVersion === null && facts.deftCorePayloadVersion === null
        ? "nothing to reconcile yet (no engine, pin, or deposited content)"
        : "no committed package.json pin to reconcile against";
  } else {
    rawVerdict = notes.length === 0 ? "current (engine/pin/content aligned)" : notes.join("; ");
  }
  // Sanitize newlines so a data-derived version/mismatch string can't break out
  // of the rendered bullet (CWE-116).
  const verdict = rawVerdict.replace(/\r?\n/g, " ");
  return `engine ${engine}, content ${content}, pin ${pin} -- ${verdict}`;
}

/**
 * Probe `.deft/.cli/<platform>` across platforms and report presence + skew. A
 * partial install, or a mix of present + absent platforms, is engine skew: a
 * gate can pass on one platform and fail on another. Read-only.
 */
export function resolvePlatformSkew(
  projectRoot: string,
  seams: DoctorSeams,
): { line: string; skewDetected: boolean; findings: Finding[] } {
  const platforms = seams.resolutionPlatforms ?? DEFAULT_RESOLUTION_PLATFORMS;
  const isFile = seams.isFile ?? ((p: string) => existsSync(p));
  const isDir =
    seams.isDir ??
    ((p: string) => {
      try {
        return statSync(p).isDirectory();
      } catch {
        return false;
      }
    });
  const states: string[] = [];
  let anyPresent = false;
  let anyAbsent = false;
  let anyPartial = false;
  for (const platform of platforms) {
    const result = checkLocalEngineIntegrity(projectRoot, { platform, isFile, isDir });
    if (result.usable) {
      states.push(`${platform} intact`);
      anyPresent = true;
    } else if (result.partial) {
      states.push(`${platform} partial (missing ${result.missingMarkers.join(", ")})`);
      anyPresent = true;
      anyPartial = true;
    } else {
      states.push(`${platform} absent`);
      anyAbsent = true;
    }
  }
  const skewDetected = anyPartial || (anyPresent && anyAbsent);
  const findings: Finding[] = [];
  if (!anyPresent) {
    return {
      line: "no sandbox-local engines (.deft/.cli/<platform> absent on all probed platforms)",
      skewDetected: false,
      findings,
    };
  }
  let line = `.deft/.cli -> ${states.join("; ")}`;
  if (skewDetected) {
    line += " -- cross-platform engine skew detected";
    findings.push({
      severity: "warning",
      message: `Cross-platform .deft/.cli engine skew: ${states.join("; ")}. A partial or platform-divergent local engine can make gates pass on one platform and fail on another; reconcile with a clean per-platform install.`,
      check: "resolution:platform-skew",
      status: "skew",
      platforms: [...platforms],
    });
  }
  return { line, skewDetected, findings };
}

/**
 * The single read-only decision surface (#2267). Reuses the shared keystone
 * `classify()` + `plan()` (the ONE classifier) to emit the operating mode, the
 * engine/pin/VERSION reconciliation, cross-platform skew, and exactly ONE
 * primary `Next command:` with a root-cause + remediation rationale. Secondary
 * migration advice (`plan()` warnings) is suppressed until the primary blocker
 * clears. Mutates nothing.
 */
export function runResolutionDecision(
  projectRoot: string,
  jsonMode: boolean,
  sink: ReturnType<typeof createPlainSink>,
  addFinding: (f: Finding) => void,
  seams: DoctorSeams,
): ResolutionSummary {
  const facts = classify(projectRoot, {
    ...(seams.isFile ? { isFile: seams.isFile } : {}),
    ...(seams.isDir ? { isDir: seams.isDir } : {}),
    ...(seams.readText ? { readText: seams.readText } : {}),
    ...(seams.engineProbe ? { engineProbe: seams.engineProbe } : {}),
  });
  const plan = resolvePlan(facts, {}, { platform: process.platform, interactive: false });
  const operatingMode = resolveOperatingMode(facts);
  const reconciliation = resolveReconciliationLine(facts);
  const skew = resolvePlatformSkew(projectRoot, seams);
  const hasTaskfileWiring = resolveTaskfileWiring(projectRoot, seams);
  const nextCommand = enforceDirectiveSurface(plan.nextAction.command, hasTaskfileWiring);
  const actionRequired = plan.mode !== "proceed";
  // Sanitize newlines on data-derived strings before they land in a rendered
  // bullet (CWE-116); root cause / remediation can carry version substrings.
  const rootCauseLine = plan.nextAction.rootCause.replace(/\r?\n/g, " ");
  const remediationLine = plan.nextAction.remediation.replace(/\r?\n/g, " ");

  if (!jsonMode) {
    sink.raw(`Operating mode: ${operatingMode}`);
    sink.raw(`Version reconciliation: ${reconciliation}`);
    sink.raw(`Cross-platform engine: ${skew.line}`);
    if (actionRequired) {
      sink.blank();
      sink.warn(
        "Primary next action (resolve this first; secondary migration advice is deferred until it clears):",
      );
      sink.raw(`  Root cause: ${rootCauseLine}`);
      sink.raw(
        nextCommand
          ? `Next command: ${nextCommand}`
          : "Next command: (manual -- no single command)",
      );
      sink.raw(`  Does / why safe: ${remediationLine}`);
    } else {
      // Derive the proceed line from plan() so it never over-claims "aligned"
      // in the no-pin case (Greptile #2283).
      sink.success(`Resolution: proceed -- ${rootCauseLine}.`);
      // Only once the primary blocker has cleared do we surface the ordered
      // secondary notes (legacy vbrief migrate, no-pin advisory, ...).
      for (const warning of plan.warnings) {
        sink.info(`note: ${warning.replace(/\r?\n/g, " ")}`);
      }
    }
  }

  for (const finding of skew.findings) {
    addFinding(finding);
  }

  if (actionRequired) {
    addFinding({
      severity: "warning",
      message: `Next command: ${nextCommand ?? "(manual)"} -- ${rootCauseLine}`,
      check: "resolution",
      status: plan.mode,
      mode: plan.mode,
      next_command: nextCommand,
      root_cause: rootCauseLine,
      remediation: remediationLine,
      operating_mode: operatingMode,
    });
  } else {
    addFinding({
      severity: "skip",
      message: "resolution: proceed -- no primary action required",
      check: "resolution",
      status: "proceed",
    });
  }

  return {
    operatingMode,
    reconciliation,
    platformSkew: skew.line,
    platformSkewDetected: skew.skewDetected,
    mode: plan.mode,
    actionRequired,
    nextCommand,
    rootCause: plan.nextAction.rootCause,
    remediation: plan.nextAction.remediation,
    warnings: plan.warnings,
  };
}
