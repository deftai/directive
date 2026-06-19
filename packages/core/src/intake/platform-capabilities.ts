/** Minimal runtime capability probe for github_auth_modes (#1557a / #1784). */

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
}

const TRUTHY = new Set(["1", "true", "yes", "on"]);

function isTruthy(value: string | undefined): boolean {
  return value !== undefined && TRUTHY.has(value.trim().toLowerCase());
}

function classifyRuntimeMode(environ: NodeJS.ProcessEnv = process.env): string {
  for (const key of ["GROK_BUILD", "GITHUB_ACTIONS", "CI", "BUILDKITE", "DEFT_AGENT_RUNTIME"]) {
    if (isTruthy(environ[key])) {
      return RUNTIME_MODE_CLOUD_HEADLESS;
    }
  }
  if (isTruthy(environ.CURSOR_SANDBOX) || isTruthy(environ.CURSOR_SANDBOX_LANDLOCK_STATUS)) {
    return RUNTIME_MODE_CURSOR_NATIVE_SANDBOX;
  }
  if (isTruthy(environ.CURSOR_AGENT) || isTruthy(environ.CURSOR_COMPOSER)) {
    return RUNTIME_MODE_CLOUD_HEADLESS;
  }
  return RUNTIME_MODE_LOCAL_UNSANDBOXED;
}

export function probeRuntimeCapabilities(
  environ: NodeJS.ProcessEnv = process.env,
): RuntimeCapabilityReport {
  return { runtimeMode: classifyRuntimeMode(environ) };
}

export function getPlatformCapabilities(): RuntimeCapabilityReport {
  return probeRuntimeCapabilities();
}
