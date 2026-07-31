import type { AdvisoryEvaluateResult } from "../agents-md-advisory/evaluate.js";
import type { ShadowedPlanExtension } from "../policy/plan-extensions.js";
import type { EngineProbeResult } from "../resolution/classify.js";
import type { ResolutionMode } from "../resolution/index.js";
import type { ResolveUserMdResult } from "../user-config/resolve-user-md.js";
import type { AgentHookHealthResult } from "../verify-env/agent-hooks.js";
import type { AgentHookLiveProbeResult } from "../verify-env/agent-hooks-live-probe.js";

export const EXIT_CLEAN = 0;
export const EXIT_DRIFT = 1;
export const EXIT_CONFIG_ERROR = 2;

export type CheckStatus = "pass" | "fail" | "skip" | "error";

export interface CheckResult {
  readonly name: string;
  readonly status: CheckStatus;
  readonly detail: string;
  readonly data?: Readonly<Record<string, unknown>>;
}

export interface DoctorResult {
  readonly projectRoot: string;
  readonly installRoot: string | null;
  readonly exitCode: number;
  readonly checks: readonly CheckResult[];
  readonly errors: readonly string[];
}

export interface Finding {
  readonly severity: "error" | "warning" | "skip";
  readonly message: string;
  readonly check?: string;
  readonly tool?: string;
  readonly suggestion?: string | null;
  readonly status?: string;
  readonly [key: string]: unknown;
}

/** Result of an offline `npm config get` query. */
export interface NpmConfigGetResult {
  readonly ok: boolean;
  readonly value: string;
}

/** Injectable npm-config reader used by doctor and its throttle-safe signposts. */
export type NpmConfigGet = (key: string, cwd: string) => NpmConfigGetResult;

/**
 * The single read-only decision surface derived from the shared keystone
 * `plan()` (#2267 / epic #2203). `plan()` is the ONE classifier: doctor never
 * re-derives the mode here, it only renders the mode + the single ordered next
 * action plus the operating-mode / reconciliation / cross-platform-skew context.
 */
export interface ResolutionSummary {
  /** Human-facing operating mode (hybrid / vendored / greenfield / ...). */
  readonly operatingMode: string;
  /** engine/pin/VERSION reconciliation verdict line. */
  readonly reconciliation: string;
  /** Cross-platform `.deft/.cli/<platform>` engine presence + skew line. */
  readonly platformSkew: string;
  /** True when the platform installs diverge (present/partial/absent mix). */
  readonly platformSkewDetected: boolean;
  /** Resolved mode from `plan()` (the single classifier). */
  readonly mode: ResolutionMode;
  /** True when the resolved mode requires operator action (mode !== "proceed"). */
  readonly actionRequired: boolean;
  /** The ONE primary next command, directive-surfaced; null for manual actions. */
  readonly nextCommand: string | null;
  /** Why the primary action is recommended. */
  readonly rootCause: string;
  /** What the remediation does + why it is safe. */
  readonly remediation: string;
  /** Ordered secondary warnings from `plan()` (informational, not directives). */
  readonly warnings: readonly string[];
}

export interface DoctorFlags {
  readonly session: boolean;
  readonly fix: boolean;
  readonly json: boolean;
  readonly quiet: boolean;
  readonly full: boolean;
  readonly network: boolean;
  readonly help: boolean;
  readonly projectRoot: string | null;
  /** Replace divergent OpenClaw pin dirs during doctor --fix (#3001). */
  readonly force: boolean;
  /** Wire always-pins into main + every workspace-* seat (#3001). */
  readonly openclawAllAgents: boolean;
  readonly unknown: readonly string[];
}

export interface ThrottleDecision {
  readonly skip: boolean;
  readonly dirty: boolean;
  readonly lastRunAt: Date | null;
  readonly lastExitCode: number;
  readonly lastFindingCount: number;
  readonly lastErrorCount: number;
  readonly nextEligibleAt: Date | null;
  readonly ageHours: number;
}

export interface DoctorState {
  readonly lastRunAt: Date;
  readonly lastExitCode: number;
  readonly lastFindingCount: number;
  readonly lastErrorCount: number;
}

export interface DoctorSeams {
  readonly whichFn?: (cmd: string) => string | null;
  readonly frameworkRoot?: string;
  readonly readText?: (path: string) => string | null;
  readonly isDir?: (path: string) => boolean;
  readonly isFile?: (path: string) => boolean;
  readonly runGitLsRemote?: (deftDir: string, ref: string) => { ok: boolean; stdout: string };
  readonly runNpmViewVersion?: () => { ok: boolean; version: string };
  /** Offline npm configuration reader for effective-registry diagnostics (#2808). */
  readonly runNpmConfigGet?: NpmConfigGet;
  readonly agentsRefreshPlan?: (projectRoot: string) => Record<string, unknown>;
  readonly agentsMdAdvisoryEvaluate?: (projectRoot: string) => AdvisoryEvaluateResult;
  readonly readState?: (projectRoot: string) => DoctorState | null;
  readonly writeState?: (
    projectRoot: string,
    payload: {
      exitCode: number;
      findingCount: number;
      errorCount: number;
      now?: Date;
    },
  ) => string | null;
  readonly isTty?: () => boolean;
  readonly readYn?: (prompt: string, defaultYes: boolean) => boolean;
  readonly writeText?: (path: string, content: string) => void;
  readonly now?: () => Date;
  /**
   * Engine-reachability probe threaded into the shared `classify()`. Injected so
   * the resolution decision stays deterministic + offline in tests; the default
   * shells out to `directive --version` / `deft --version`.
   */
  readonly engineProbe?: () => EngineProbeResult;
  /**
   * Platform ids probed for cross-platform `.deft/.cli/<platform>` engine skew.
   * Defaults to `["linux", "darwin", "win32"]`.
   */
  readonly resolutionPlatforms?: readonly string[];
  /**
   * USER.md resolver seam (#2271). Injected so the doctor USER.md-resolution
   * surface stays deterministic + offline in tests. Defaults to the shared
   * first-hit-wins resolver scoped to the project root.
   */
  readonly resolveUserMd?: (projectRoot: string) => ResolveUserMdResult;
  /**
   * Plan-extension shadow detector seam (#2301). Injected so the doctor
   * shadow-diagnostic surface stays deterministic + offline in tests. Defaults
   * to loading PROJECT-DEFINITION and running `detectShadowedPlanExtensions` on
   * its `plan` object; returns [] when no project definition is present.
   */
  readonly detectPlanExtensionShadows?: (projectRoot: string) => readonly ShadowedPlanExtension[];
  /** Read-only agent-host hook registration probe (#2438). */
  readonly evaluateAgentHooks?: (projectRoot: string) => AgentHookHealthResult;
  /** Live hook spawn probe for doctor --full (#2852). */
  readonly probeAgentHooksLive?: (projectRoot: string) => AgentHookLiveProbeResult;
  /**
   * xBRIEF project-envelope staleness probe (#2971). Injected so doctor can
   * fail closed on 0.6 project JSON under an xbrief/ layout without re-deriving
   * the shared `probeXbriefStaleness` path in tests.
   */
  readonly probeXbriefEnvelope?: (projectRoot: string) => {
    readonly declaredVersion: string | null;
    readonly targetVersion: string;
    readonly distance: "current" | "behind-minor" | "behind-major";
    readonly stale: boolean;
  };
  /**
   * OpenClaw skill-pin seams (#3001). Injected so detect/fix stays offline +
   * deterministic in tests (fake HOME / env / fs).
   */
  readonly openclawEnv?: NodeJS.ProcessEnv;
  readonly openclawHomeDir?: () => string;
  readonly openclawContentRootFor?: (frameworkRoot: string) => string;
}
