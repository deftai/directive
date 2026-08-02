import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { VBRIEF_VERSION } from "@deftai/directive-types";
import { evaluate as evaluateAgentsMdAdvisory } from "../agents-md-advisory/evaluate.js";
import { contentRoot } from "../content-root.js";
import { resolveProjectDefinitionPath } from "../layout/resolve.js";
import {
  DEFT_DIRECTIVE_DISABLE_FLAG_NAME,
  DEFT_DIRECTIVE_DISABLE_STATUS,
  DEFT_DIRECTIVE_DISABLE_TRACKED_WARNING,
  detectDeftDirectiveDisable,
  formatDeftDirectiveDisableMessage,
} from "../policy/deft-directive-disable.js";
import {
  detectNoDeftDirective,
  NO_DEFT_DIRECTIVE_DISABLED_MESSAGE,
  NO_DEFT_DIRECTIVE_FLAG_NAME,
  NO_DEFT_DIRECTIVE_INCONSISTENT_MESSAGE,
  NO_DEFT_DIRECTIVE_INCONSISTENT_POLICY,
} from "../policy/no-deft-directive.js";
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
import { classifyXbriefSchemaDistance } from "../staleness-tickler/probe-xbrief.js";
import { type ResolveUserMdResult, resolveUserMdPath } from "../user-config/resolve-user-md.js";
import { evaluateAgentHooks } from "../verify-env/agent-hooks.js";
import { probeAgentHooksLive } from "../verify-env/agent-hooks-live-probe.js";
import { readDeclaredArtifactVersion } from "../xbrief-migrate/transforms.js";
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
import { runNpmRegistryMirrorCheck } from "./npm-registry.js";
import { runOpenClawSkillPinsCheck } from "./openclaw-skills.js";
import { createPlainSink } from "./output.js";
import {
  readTextSafe,
  resolveFrameworkRootForProject,
  resolvePath,
  resolveVersion,
  runningInsideDeftRepo,
} from "./paths.js";
import { runPayloadStalenessCheck } from "./payload-staleness.js";
import { runLocalSignpostChecks } from "./signpost-checks.js";
import {
  classifyTaskfileInclude,
  formatGatesSurfaceDualRemediation,
  formatMissingIncludeSnippet,
  GATES_SURFACE_DEFT_REMEDIATION,
  includesBlockHasDeftTaskfile,
  resolveConsumerTaskfile,
} from "./taskfile.js";
import type { DoctorSeams, Finding, ResolutionSummary } from "./types.js";
import { defaultWhich } from "./which.js";

const DEFAULT_RESOLUTION_PLATFORMS = ["linux", "darwin", "win32"] as const;

/** Next-action command for project-envelope behind-major (#2971). */
const XBRIEF_ENVELOPE_MIGRATE_COMMAND = "deft migrate:xbrief";

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
  const frameworkRoot = seams.frameworkRoot ?? resolveFrameworkRootForProject(projectRoot);
  const consumerContext = resolve(projectRoot) !== resolve(frameworkRoot);
  const whichFn = seams.whichFn ?? defaultWhich;
  const nowFn = seams.now ?? (() => new Date());

  // #3039: temporary test kill-switch. Active (untracked) → disabled short-circuit.
  // Tracked/committed flag → warn only and continue normal doctor (no enforcement bypass).
  const killSwitch = detectDeftDirectiveDisable(projectRoot, { skipTrackedCache: true });
  if (killSwitch.present && killSwitch.trackedByGit && !killSwitch.active) {
    if (jsonMode) {
      // Fall through to normal doctor after optional surface; emit warning finding
      // by writing once then continuing — use stderr path for human mode below.
    } else if (!quietMode) {
      process.stderr.write(`${DEFT_DIRECTIVE_DISABLE_TRACKED_WARNING}\n`);
    }
    // Continue into full doctor; do not short-circuit.
  } else if (killSwitch.active) {
    const optOutAlso = detectNoDeftDirective(projectRoot);
    const message = formatDeftDirectiveDisableMessage({
      permanentOptOutAlsoPresent: optOutAlso.present,
      trackedByGit: false,
    });
    if (jsonMode) {
      const payload = {
        status: DEFT_DIRECTIVE_DISABLE_STATUS,
        disabled: true,
        disabled_via: DEFT_DIRECTIVE_DISABLE_FLAG_NAME,
        kill_switch: true,
        inconsistent: false,
        deposit_present: killSwitch.depositPresent,
        tracked_by_git: false,
        permanent_opt_out_also_present: optOutAlso.present,
        message,
      };
      process.stdout.write(`${pythonJsonDump(payload)}\n`);
    } else if (!quietMode) {
      process.stdout.write(`${message}\n`);
    }
    return 0;
  }

  // #2926: official root opt-out — short-circuit Directive doctor when clean;
  // diagnose flag+deposit inconsistency (warn; exit dirty).
  const optOut = detectNoDeftDirective(projectRoot);
  if (optOut.present) {
    if (optOut.inconsistent) {
      const message = `${NO_DEFT_DIRECTIVE_INCONSISTENT_MESSAGE} (${NO_DEFT_DIRECTIVE_DISABLED_MESSAGE})`;
      if (jsonMode) {
        const payload = {
          status: "disabled-inconsistent",
          disabled: true,
          disabled_via: NO_DEFT_DIRECTIVE_FLAG_NAME,
          inconsistent: true,
          inconsistent_policy: NO_DEFT_DIRECTIVE_INCONSISTENT_POLICY,
          deposit_present: true,
          message,
          findings: [
            {
              severity: "warning",
              message,
              check: "no-deft-directive",
              policy: NO_DEFT_DIRECTIVE_INCONSISTENT_POLICY,
            },
          ],
        };
        process.stdout.write(`${pythonJsonDump(payload)}\n`);
      } else if (!quietMode) {
        process.stderr.write(`${message} [policy=${NO_DEFT_DIRECTIVE_INCONSISTENT_POLICY}]\n`);
      }
      return 1;
    }
    if (jsonMode) {
      const payload = {
        status: "disabled",
        disabled: true,
        disabled_via: NO_DEFT_DIRECTIVE_FLAG_NAME,
        inconsistent: false,
        deposit_present: false,
        message: NO_DEFT_DIRECTIVE_DISABLED_MESSAGE,
      };
      process.stdout.write(`${pythonJsonDump(payload)}\n`);
    } else if (!quietMode) {
      process.stdout.write(`${NO_DEFT_DIRECTIVE_DISABLED_MESSAGE}\n`);
    }
    return 0;
  }

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
          `Signpost advisory: ${signpostWarnings} local configuration / layout note(s) above (throttle-skipped full probe).`,
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
  sink.info("Checking agent-host hook registration...");
  const findingCountBeforeHooks = findings.length;
  const hooksHealthy = runAgentHooksHealthCheck(
    projectRoot,
    consumerContext,
    sink,
    addFinding,
    seams,
  );
  if (fullMode && hooksHealthy) {
    const lastFinding = findings[findings.length - 1];
    if (
      findings.length > findingCountBeforeHooks &&
      lastFinding?.check === "agent-hooks-registration" &&
      lastFinding?.status === "registered"
    ) {
      findings.pop();
    }
    runAgentHooksLiveProbeCheck(projectRoot, sink, addFinding, seams);
  }

  if (consumerContext) {
    if (!jsonMode) {
      sink.blank();
    }
    sink.info("Checking npm registry routing...");
    runNpmRegistryMirrorCheck(projectRoot, sink, addFinding, seams);
  }

  if (!jsonMode) {
    sink.blank();
  }
  // #2182: payload-staleness is the only doctor check that can reach a network
  // endpoint (git verifies the pin; npm compares stable release availability).
  // The baseline #2808 registry-routing diagnostic above is an offline
  // `npm config get` read. Payload-staleness stays in the OFFLINE
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
  sink.info("Checking gates-surface readiness (Taskfile include for deep-think agent gates)...");
  runTaskfileIncludeCheck(projectRoot, fixMode, jsonMode, sink, addFinding, seams);

  if (!jsonMode) {
    sink.blank();
  }
  sink.info("Checking OpenClaw always-pin skills...");
  runOpenClawSkillPinsCheck(sink, addFinding, {
    frameworkRoot,
    fixMode,
    jsonMode,
    force: flags.force,
    allAgents: flags.openclawAllAgents,
    seams: {
      ...seams,
      env: seams.openclawEnv,
      homeDir: seams.openclawHomeDir,
      contentRootFor: seams.openclawContentRootFor,
      isDir: seams.isDir,
      isFile: seams.isFile,
      isTty: seams.isTty,
      readYn: seams.readYn,
    },
  });

  if (!jsonMode) {
    sink.blank();
  }
  sink.info("Checking xBRIEF project envelope version...");
  runXbriefEnvelopeVersionCheck(projectRoot, sink, addFinding, seams);

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

export function runAgentHooksHealthCheck(
  projectRoot: string,
  consumerContext: boolean,
  sink: ReturnType<typeof createPlainSink>,
  addFinding: (finding: Finding) => void,
  seams: DoctorSeams,
): boolean {
  const checkName = "agent-hooks-registration";
  if (!consumerContext) {
    const reason = "maintainer source checkout; project hook deposit is consumer-only";
    sink.info(`${checkName}: skip -- ${reason}`);
    addFinding({ severity: "skip", message: reason, check: checkName, status: "skip" });
    return false;
  }
  try {
    const result = (seams.evaluateAgentHooks ?? evaluateAgentHooks)(projectRoot);
    if (result.code !== 0) {
      const message = `${checkName}: ${result.message.replace(/\s+/g, " ").trim()}`;
      sink.warn(message);
      addFinding({
        severity: "warning",
        message,
        check: checkName,
        status: result.code === 2 ? "unavailable" : "incomplete",
        registrations: result.registrations,
        suggestion: "deft update",
      });
      return false;
    }

    const message =
      `${checkName}: registered and structurally valid; ` +
      "Codex runtime trust is user-controlled and must be reviewed with `/hooks`";
    sink.success(message);
    addFinding({
      severity: "skip",
      message,
      check: checkName,
      status: "registered",
      registrations: result.registrations,
      trust_status: "not-verifiable",
      trust_review: "Open `/hooks` in Codex and review the project hook commands.",
    });
    return true;
  } catch (cause) {
    const message = `${checkName}: probe failed -- ${String(cause)}`;
    sink.warn(message);
    addFinding({ severity: "warning", message, check: checkName, suggestion: "deft update" });
    return false;
  }
}

export function runAgentHooksLiveProbeCheck(
  projectRoot: string,
  sink: ReturnType<typeof createPlainSink>,
  addFinding: (finding: Finding) => void,
  seams: DoctorSeams,
): void {
  const checkName = "agent-hooks-registration";
  const liveCheckName = "agent-hooks-live-probe";
  try {
    const result = (seams.evaluateAgentHooks ?? evaluateAgentHooks)(projectRoot);
    const liveResult = (seams.probeAgentHooksLive ?? probeAgentHooksLive)(projectRoot);
    if (liveResult.code !== 0) {
      const message = `${liveCheckName}: ${liveResult.message.replace(/\s+/g, " ").trim()}`;
      sink.warn(message);
      addFinding({
        severity: "warning",
        message,
        check: liveCheckName,
        status: liveResult.code === 2 ? "unavailable" : "non-functional",
        cases: liveResult.cases,
        suggestion: "npm i -g @deftai/directive@latest && deft update",
      });
      return;
    }
    const message =
      `${checkName}: registered, structurally valid, and live probe passed; ` +
      "Codex runtime trust is user-controlled and must be reviewed with `/hooks`";
    sink.success(message);
    addFinding({
      severity: "skip",
      message,
      check: liveCheckName,
      status: "registered-and-functional",
      registrations: result.registrations,
      trust_status: "not-verifiable",
      trust_review: "Open `/hooks` in Codex and review the project hook commands.",
      live_probe: "passed",
    });
  } catch (cause) {
    const message = `${liveCheckName}: probe failed -- ${String(cause)}`;
    sink.warn(message);
    addFinding({ severity: "warning", message, check: liveCheckName, suggestion: "deft update" });
  }
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
          name === "manifest-version-reportable" ||
          name === "gitignore-coverage" ||
          name === "stale-xbrief-schema-deposit" ||
          name === "typescript-7-side-by-side") &&
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
    sink.success(
      "Gates-surface ready: root Taskfile.yml includes the deft framework (`task deft:<verb>`)",
    );
    return;
  }
  if (includeStatus === "missing-file") {
    let includeMissing = true;
    const target = join(projectRoot, "Taskfile.yml");
    // #2893: elevate to warning — deep-think agent gates need a working invoke path.
    // Dual remediations: (1) deft CLI primary (2) Taskfile include for task deft: verbs.
    const message =
      "Gates-surface readiness: root Taskfile.yml missing. Deep-think agent gates " +
      "(`pr:watch`, `review-monitor:*`) need a working invoke path — not optional convenience. " +
      "1. " +
      GATES_SURFACE_DEFT_REMEDIATION +
      ` 2. Create ${target} with the canonical include so go-task exposes \`task deft:<verb>\` ` +
      "(include key `deft:` → namespaced tasks; bare `task pr:watch` is not the consumer form):";
    sink.warn(message);
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
        sink.info(
          "Skipped Taskfile.yml creation -- use `deft <verb>` now, or paste the include snippet when ready.",
        );
      }
    }
    if (includeMissing) {
      addFinding({
        severity: "warning",
        message:
          "Gates-surface: root Taskfile.yml missing — deep-think gates need `deft` CLI or `task deft:` include",
        check: "taskfile-include",
        file: target,
        suggestion: formatGatesSurfaceDualRemediation("missing-file"),
      });
    }
    return;
  }
  if (includeStatus === "missing-include") {
    const message =
      "Gates-surface readiness: root Taskfile.yml exists but does not include the deft framework. " +
      "Deep-think agent gates (`pr:watch`, `review-monitor:*`) need a working invoke path. " +
      "1. " +
      GATES_SURFACE_DEFT_REMEDIATION +
      " 2. Add this to the Taskfile `includes:` block so go-task exposes `task deft:<verb>` " +
      "(doctor NEVER mutates an existing user-owned Taskfile; bare `task pr:watch` is not the consumer form when the include key is `deft:`):";
    sink.warn(message);
    if (!jsonMode) {
      sink.blank();
      sink.raw(formatMissingIncludeSnippet());
    }
    const tf = resolveConsumerTaskfile(projectRoot);
    addFinding({
      severity: "warning",
      message:
        "Gates-surface: root Taskfile.yml does not include the deft framework — deep-think gates need `deft` CLI or `task deft:` include",
      check: "taskfile-include",
      file: tf,
      suggestion: formatGatesSurfaceDualRemediation("missing-include"),
    });
    return;
  }
  const taskfilePath = resolveConsumerTaskfile(projectRoot) ?? join(projectRoot, "Taskfile.yml");
  const message =
    `Gates-surface readiness: root Taskfile.yml at ${taskfilePath} exists but could not be read — ` +
    "check file permissions. Deep-think gates still work via `deft <verb>` until the include is readable.";
  sink.warn(message);
  addFinding({
    severity: "warning",
    message,
    check: "taskfile-include",
    file: taskfilePath,
    suggestion: GATES_SURFACE_DEFT_REMEDIATION,
  });
}

/**
 * Fail closed when PROJECT-DEFINITION under an xbrief/ layout still declares
 * envelope 0.6 while the framework schema is 0.8 (#2971). Greenfield (no
 * project definition yet) and current 0.8 envelopes pass. Unreadable paths
 * (test seams / permission) skip rather than false-positive fail. Behind-major
 * records `deft migrate:xbrief` as the next action — layout rename alone is not
 * enough. Distinct from deposited-schema (`stale-xbrief-schema-deposit`) which
 * must NOT route to migrate:xbrief when only framework schema files are stale.
 */
export function runXbriefEnvelopeVersionCheck(
  projectRoot: string,
  sink: ReturnType<typeof createPlainSink>,
  addFinding: (f: Finding) => void,
  seams: DoctorSeams,
): void {
  const checkName = "xbrief-envelope-version";
  const isFile = seams.isFile ?? ((p: string) => existsSync(p));
  const readText = seams.readText ?? readTextSafe;
  const targetVersion = VBRIEF_VERSION;

  if (seams.probeXbriefEnvelope) {
    const probe = seams.probeXbriefEnvelope(projectRoot);
    emitXbriefEnvelopeFinding(checkName, probe, sink, addFinding);
    return;
  }

  let definitionPath: string;
  try {
    definitionPath = resolveProjectDefinitionPath(projectRoot);
  } catch {
    // Pure vbrief/-only trees are already covered by layout migrate signposts.
    const skipMessage = `${checkName}: skip -- legacy-only layout (use layout migrate first)`;
    sink.info(skipMessage);
    addFinding({
      severity: "skip",
      message: skipMessage,
      check: checkName,
      status: "skip",
      reason: "legacy-only-layout",
    });
    return;
  }

  if (!isFile(definitionPath)) {
    const skipMessage = `${checkName}: skip -- no PROJECT-DEFINITION yet (greenfield)`;
    sink.info(skipMessage);
    addFinding({
      severity: "skip",
      message: skipMessage,
      check: checkName,
      status: "skip",
      reason: "no-project-definition",
    });
    return;
  }

  const text = readText(definitionPath);
  if (text === null) {
    // Unreadable path (permissions or injectable seams) is not proof of 0.6.
    const skipMessage = `${checkName}: skip -- PROJECT-DEFINITION unreadable`;
    sink.info(skipMessage);
    addFinding({
      severity: "skip",
      message: skipMessage,
      check: checkName,
      status: "skip",
      reason: "unreadable",
    });
    return;
  }

  let declaredVersion: string | null = null;
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      declaredVersion = readDeclaredArtifactVersion(parsed as Record<string, unknown>);
    } else {
      const skipMessage = `${checkName}: skip -- PROJECT-DEFINITION is not a JSON object`;
      sink.info(skipMessage);
      addFinding({
        severity: "skip",
        message: skipMessage,
        check: checkName,
        status: "skip",
        reason: "invalid-json-shape",
      });
      return;
    }
  } catch {
    const skipMessage = `${checkName}: skip -- PROJECT-DEFINITION JSON parse failed`;
    sink.info(skipMessage);
    addFinding({
      severity: "skip",
      message: skipMessage,
      check: checkName,
      status: "skip",
      reason: "parse-error",
    });
    return;
  }

  const distance = classifyXbriefSchemaDistance(declaredVersion, targetVersion);
  emitXbriefEnvelopeFinding(
    checkName,
    {
      declaredVersion,
      targetVersion,
      distance,
      stale: distance !== "current",
    },
    sink,
    addFinding,
  );
}

function emitXbriefEnvelopeFinding(
  checkName: string,
  probe: {
    readonly declaredVersion: string | null;
    readonly targetVersion: string;
    readonly distance: "current" | "behind-minor" | "behind-major";
    readonly stale: boolean;
  },
  sink: ReturnType<typeof createPlainSink>,
  addFinding: (f: Finding) => void,
): void {
  if (probe.distance === "current") {
    const okMessage =
      `${checkName}: current -- xBRIEFInfo@${probe.declaredVersion ?? probe.targetVersion} ` +
      `(framework ${probe.targetVersion})`;
    sink.success(okMessage);
    addFinding({
      severity: "skip",
      message: okMessage,
      check: checkName,
      status: "current",
      declared_version: probe.declaredVersion,
      target_version: probe.targetVersion,
    });
    return;
  }

  if (probe.distance === "behind-minor") {
    const warnMessage =
      `${checkName}: behind-minor -- declared ${probe.declaredVersion ?? "unknown"}, ` +
      `framework ${probe.targetVersion}. Prefer \`deft migrate:xbrief\` when convenient.`;
    sink.warn(warnMessage);
    addFinding({
      severity: "warning",
      message: warnMessage,
      check: checkName,
      status: "behind-minor",
      suggestion: XBRIEF_ENVELOPE_MIGRATE_COMMAND,
      declared_version: probe.declaredVersion,
      target_version: probe.targetVersion,
      next_command: XBRIEF_ENVELOPE_MIGRATE_COMMAND,
    });
    return;
  }

  // behind-major (declared 0.6 vs framework 0.8, dual half-state, missing version)
  const nextCommand = XBRIEF_ENVELOPE_MIGRATE_COMMAND;
  const message =
    `${checkName}: behind-major -- declared ${probe.declaredVersion ?? "unknown"}, ` +
    `framework ${probe.targetVersion}. Next action: run \`${nextCommand}\` to bump project ` +
    `JSON envelopes to xBRIEFInfo@${probe.targetVersion} (layout rename alone is not enough).`;
  sink.error(message);
  addFinding({
    severity: "error",
    message,
    check: checkName,
    status: "behind-major",
    suggestion: nextCommand,
    declared_version: probe.declaredVersion,
    target_version: probe.targetVersion,
    next_command: nextCommand,
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
 * (#2267 / #2893). The `directive`/`deft` surface always works; `task deft:X` is
 * the go-task namespaced form only when the consumer wired the include (bare
 * `task pr:watch` is not the consumer form under include key `deft:`). `plan()`
 * already emits the `directive` / `npx` / `npm` surface, so this guard is a
 * defensive invariant: any `task`-prefixed command is rewritten to the
 * `directive` surface unless the project actually has the include.
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
