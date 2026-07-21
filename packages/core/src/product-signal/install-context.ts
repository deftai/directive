import { release } from "node:os";
import { readCorePackageVersion } from "../engine-version.js";
import { resolveInstallId } from "../events/attribution-enrichment.js";
import { detectEnvironmentContext } from "../platform/shell-context.js";

export type ProductSignalHarness = "cursor" | "cli" | "codex" | "opencode" | "other";

export interface InstallContext {
  readonly installId: string;
  readonly directiveVersion: string;
  readonly os: string;
  readonly osVersion: string;
  readonly shell: string;
  readonly harness: ProductSignalHarness;
  readonly harnessVersion: string | null;
}

function detectHarness(env: NodeJS.ProcessEnv = process.env): ProductSignalHarness {
  const explicit = env.DEFT_HARNESS?.trim().toLowerCase();
  if (
    explicit === "cursor" ||
    explicit === "cli" ||
    explicit === "codex" ||
    explicit === "opencode" ||
    explicit === "other"
  ) {
    return explicit;
  }
  if (env.CURSOR_SESSION_ID || env.CURSOR_TRACE_ID) {
    return "cursor";
  }
  if (env.CODEX_HOME || env.CODEX_SESSION) {
    return "codex";
  }
  if (env.OPENCODE) {
    return "opencode";
  }
  return "cli";
}

/** Collect shared install context for product-signal payloads (#2693 D7). */
export function collectInstallContext(projectRoot: string): InstallContext {
  const envCtx = detectEnvironmentContext();
  const installId = resolveInstallId(projectRoot) ?? "unknown";
  const harness = detectHarness();
  const harnessVersion =
    process.env.DEFT_HARNESS_VERSION?.trim() || process.env.CURSOR_VERSION?.trim() || null;
  return {
    installId,
    directiveVersion: readCorePackageVersion(),
    os: envCtx.hostPlatform,
    osVersion: release(),
    shell: envCtx.shell.name,
    harness,
    harnessVersion,
  };
}
