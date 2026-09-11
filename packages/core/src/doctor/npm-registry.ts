import { spawnSync } from "node:child_process";
import { NPM_REGISTRY_MIRROR_DOC_URL, PUBLIC_NPM_REGISTRY } from "./constants.js";
import type { OutputSink } from "./output.js";
import type { Finding, NpmConfigGet, NpmConfigGetResult } from "./types.js";

const CHECK_NAME = "npm-registry-mirror";
const DEFT_SCOPE_REGISTRY_KEY = "@deftai:registry";
const DEFAULT_REGISTRY_KEY = "registry";
const UNSET_NPM_VALUES = new Set(["", "null", "undefined"]);

/** Seams for the read-only npm registry routing diagnostic. */
export interface NpmRegistryMirrorSeams {
  readonly runNpmConfigGet?: NpmConfigGet;
}

interface EffectiveRegistry {
  readonly source: "scoped" | "default";
  readonly value: string;
}

/**
 * Read one npm configuration key without a shell.
 *
 * `npm config get` reads local/user configuration only; it does not resolve a
 * package or contact a registry. Failures are returned explicitly so doctor can
 * skip this advisory without turning a missing npm binary into a hard error.
 */
export function defaultNpmConfigGet(key: string, cwd: string): NpmConfigGetResult {
  try {
    const proc = spawnSync("npm", ["config", "get", key], {
      cwd,
      encoding: "utf8",
      shell: false,
      timeout: 5_000,
      windowsHide: true,
    });
    return {
      ok: proc.status === 0,
      value: typeof proc.stdout === "string" ? proc.stdout.trim() : "",
    };
  } catch {
    return { ok: false, value: "" };
  }
}

function configuredValue(value: string): string | null {
  const trimmed = value.trim();
  return UNSET_NPM_VALUES.has(trimmed.toLowerCase()) ? null : trimmed;
}

function effectiveRegistry(
  runConfigGet: NpmConfigGet,
  projectRoot: string,
): EffectiveRegistry | null {
  let scoped: NpmConfigGetResult;
  try {
    scoped = runConfigGet(DEFT_SCOPE_REGISTRY_KEY, projectRoot);
  } catch {
    return null;
  }
  if (!scoped.ok) {
    return null;
  }
  const scopedValue = configuredValue(scoped.value);
  if (scopedValue !== null) {
    return { source: "scoped", value: scopedValue };
  }

  let fallback: NpmConfigGetResult;
  try {
    fallback = runConfigGet(DEFAULT_REGISTRY_KEY, projectRoot);
  } catch {
    return null;
  }
  if (!fallback.ok) {
    return null;
  }
  const fallbackValue = configuredValue(fallback.value);
  return fallbackValue === null ? null : { source: "default", value: fallbackValue };
}

function isValidRegistryUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return (parsed.protocol === "https:" || parsed.protocol === "http:") && parsed.hostname !== "";
  } catch {
    return false;
  }
}

function isCanonicalPublicRegistry(value: string): boolean {
  try {
    const parsed = new URL(value);
    return (
      parsed.protocol === "https:" &&
      parsed.hostname === "registry.npmjs.org" &&
      parsed.port === "" &&
      (parsed.pathname === "" || parsed.pathname === "/") &&
      parsed.username === "" &&
      parsed.password === "" &&
      parsed.search === "" &&
      parsed.hash === ""
    );
  } catch {
    return false;
  }
}

function skipFinding(addFinding: (finding: Finding) => void): void {
  addFinding({
    severity: "skip",
    message: `${CHECK_NAME}: skip -- npm registry configuration is unavailable or invalid`,
    check: CHECK_NAME,
    status: "skip",
  });
}

/**
 * Warn when `@deftai/*` resolves through a non-public npm registry.
 *
 * The finding intentionally records only whether the scoped or default key won
 * precedence. It never includes the configured URL, which may contain internal
 * hostnames or credentials.
 */
export function runNpmRegistryMirrorCheck(
  projectRoot: string,
  sink: OutputSink,
  addFinding: (finding: Finding) => void,
  seams: NpmRegistryMirrorSeams = {},
): void {
  const selected = effectiveRegistry(seams.runNpmConfigGet ?? defaultNpmConfigGet, projectRoot);
  if (selected === null || !isValidRegistryUrl(selected.value)) {
    skipFinding(addFinding);
    return;
  }
  if (isCanonicalPublicRegistry(selected.value)) {
    return;
  }

  const message =
    `${CHECK_NAME}: @deftai packages resolve through a non-public npm registry. ` +
    "Corporate mirrors can return E404/ETARGET or silently serve stale @latest metadata. " +
    "`--registry` does not beat `@deftai:registry`. " +
    "Where organization policy permits, retry from a directory that does not load the project `.npmrc` (for example `$HOME`), " +
    `or pass \`--userconfig\` to a file that sets \`@deftai:registry=${PUBLIC_NPM_REGISTRY}\`, ` +
    `or add \`@deftai:registry=${PUBLIC_NPM_REGISTRY}\` to \`.npmrc\`. ` +
    `Otherwise ask your registry administrator to sync the @deftai packages. See ${NPM_REGISTRY_MIRROR_DOC_URL}.`;
  sink.warn(message);
  addFinding({
    severity: "warning",
    message,
    check: CHECK_NAME,
    status: "non-public",
    registry_source: selected.source,
    suggestion: NPM_REGISTRY_MIRROR_DOC_URL,
  });
}
