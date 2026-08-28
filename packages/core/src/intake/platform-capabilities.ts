/** Minimal runtime capability probe for github_auth_modes (#1557a / #1784). */

import {
  hasExplicitHostGhSelection,
  type ManagedRuntimeProbe,
  probeManagedRuntime,
  RUNTIME_REASON_CI_MARKER,
  RUNTIME_REASON_CURSOR_MARKER_AMBIGUOUS,
  RUNTIME_REASON_CURSOR_SANDBOX_MARKER,
  RUNTIME_REASON_EXPLICIT_HOST_GH,
  RUNTIME_REASON_MANAGED_RUNTIME_PROBE,
  RUNTIME_REASON_NO_RUNTIME_MARKER,
} from "../platform/cursor-managed-runtime.js";

export const RUNTIME_MODE_LOCAL_UNSANDBOXED = "local-unsandboxed";
export const RUNTIME_MODE_CURSOR_NATIVE_SANDBOX = "cursor-native-sandbox";
export const RUNTIME_MODE_CLOUD_HEADLESS = "cloud-headless";

export const KNOWN_RUNTIME_MODES = new Set<string>([
  RUNTIME_MODE_LOCAL_UNSANDBOXED,
  RUNTIME_MODE_CURSOR_NATIVE_SANDBOX,
  RUNTIME_MODE_CLOUD_HEADLESS,
]);

export interface RuntimeCapabilityReport {
  readonly runtimeMode: string;
  /** Stable id naming why `runtimeMode` was chosen; surfaced by scm:status (#3859). */
  readonly runtimeModeReason?: string;
}

export interface ProbeRuntimeCapabilityOptions {
  /** Injectable managed-runtime probe (#3859). Defaults to the metadata read. */
  readonly managedRuntimeProbe?: ManagedRuntimeProbe;
}

interface RuntimeClassification {
  readonly mode: string;
  readonly reason: string;
}

const TRUTHY = new Set(["1", "true", "yes", "on"]);

function isTruthy(value: string | undefined): boolean {
  return value !== undefined && TRUTHY.has(value.trim().toLowerCase());
}

/**
 * Classify the execution runtime.
 *
 * Ordering is load-bearing (#3859):
 *   1. CI markers, so a CI runner is never reclassified by a Cursor signal.
 *   2. A positive Cursor managed-runtime read, above every other Cursor signal.
 *   3. Cursor native sandbox.
 *   4. A Cursor marker with no managed read leaves the runtime AMBIGUOUS. Only
 *      an explicit operator/dispatcher selection resolves it to local; absent
 *      that, the verdict is unchanged from before #3859.
 */
function classifyRuntimeMode(
  environ: NodeJS.ProcessEnv = process.env,
  options: ProbeRuntimeCapabilityOptions = {},
): RuntimeClassification {
  for (const key of ["GROK_BUILD", "GITHUB_ACTIONS", "CI", "BUILDKITE", "DEFT_AGENT_RUNTIME"]) {
    if (isTruthy(environ[key])) {
      return { mode: RUNTIME_MODE_CLOUD_HEADLESS, reason: RUNTIME_REASON_CI_MARKER };
    }
  }
  const managedProbe = options.managedRuntimeProbe ?? probeManagedRuntime;
  if (managedProbe(environ).verdict === "managed") {
    return {
      mode: RUNTIME_MODE_CLOUD_HEADLESS,
      reason: RUNTIME_REASON_MANAGED_RUNTIME_PROBE,
    };
  }
  if (isTruthy(environ.CURSOR_SANDBOX) || isTruthy(environ.CURSOR_SANDBOX_LANDLOCK_STATUS)) {
    return {
      mode: RUNTIME_MODE_CURSOR_NATIVE_SANDBOX,
      reason: RUNTIME_REASON_CURSOR_SANDBOX_MARKER,
    };
  }
  if (isTruthy(environ.CURSOR_AGENT) || isTruthy(environ.CURSOR_COMPOSER)) {
    if (hasExplicitHostGhSelection(environ)) {
      return { mode: RUNTIME_MODE_LOCAL_UNSANDBOXED, reason: RUNTIME_REASON_EXPLICIT_HOST_GH };
    }
    return {
      mode: RUNTIME_MODE_CLOUD_HEADLESS,
      reason: RUNTIME_REASON_CURSOR_MARKER_AMBIGUOUS,
    };
  }
  return { mode: RUNTIME_MODE_LOCAL_UNSANDBOXED, reason: RUNTIME_REASON_NO_RUNTIME_MARKER };
}

export function probeRuntimeCapabilities(
  environ: NodeJS.ProcessEnv = process.env,
  options: ProbeRuntimeCapabilityOptions = {},
): RuntimeCapabilityReport {
  const { mode, reason } = classifyRuntimeMode(environ, options);
  return { runtimeMode: mode, runtimeModeReason: reason };
}

export function getPlatformCapabilities(
  options: ProbeRuntimeCapabilityOptions = {},
): RuntimeCapabilityReport {
  return probeRuntimeCapabilities(process.env, options);
}
