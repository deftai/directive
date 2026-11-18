import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { NPM_REGISTRY_MIRROR_DOC_URL, PUBLIC_NPM_REGISTRY } from "./constants.js";
import type { OutputSink } from "./output.js";
import type { Finding, NpmConfigGet, NpmConfigGetResult } from "./types.js";

const CHECK_NAME = "npm-registry-mirror";
const DEFT_SCOPE_REGISTRY_KEY = "@deftai:registry";
const DEFAULT_REGISTRY_KEY = "registry";
const UNSET_NPM_VALUES = new Set(["", "null", "undefined"]);
/** The only two packages Directive publishes (AC13.4). */
const DIRECTIVE_PUBLISHED_PACKAGES = new Set(["@deftai/directive", "@deftai/directive-runtime"]);
/** Retired Directive packages (public npm); old lockfiles may still list them. */
const DIRECTIVE_RETIRED_PACKAGES = new Set([
  "@deftai/directive-core",
  "@deftai/directive-content",
  "@deftai/directive-types",
]);
const LOCKFILES = ["package-lock.json", "npm-shrinkwrap.json", "pnpm-lock.yaml", "yarn.lock"];
const DIRECTIVE_PACKAGES_LABEL = "`@deftai/directive` and `@deftai/directive-runtime`";
const DEPENDENCY_MAPS = [
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies",
] as const;

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

/**
 * True when the root `package.json` or a lockfile names any `@deftai/*` package
 * other than Directive's own (#6141 split scope). Unreadable or malformed files
 * read as "no other packages" so today's advice stands.
 */
function projectUsesOtherDeftaiPackages(projectRoot: string): boolean {
  return rootManifestUsesOtherDeftai(projectRoot) || lockfileUsesOtherDeftai(projectRoot);
}

function isOtherDeftaiPackage(name: string): boolean {
  return (
    name.startsWith("@deftai/") &&
    !DIRECTIVE_PUBLISHED_PACKAGES.has(name) &&
    !DIRECTIVE_RETIRED_PACKAGES.has(name)
  );
}

function rootManifestUsesOtherDeftai(projectRoot: string): boolean {
  let manifest: unknown;
  try {
    manifest = JSON.parse(readFileSync(join(projectRoot, "package.json"), "utf8"));
  } catch {
    return false;
  }
  if (manifest === null || typeof manifest !== "object") return false;
  for (const key of DEPENDENCY_MAPS) {
    const deps = (manifest as Record<string, unknown>)[key];
    if (deps === null || typeof deps !== "object" || Array.isArray(deps)) continue;
    for (const name of Object.keys(deps)) {
      if (isOtherDeftaiPackage(name)) return true;
    }
  }
  return false;
}

/**
 * Lockfiles cover workspace members and transitive dependencies that the root
 * manifest does not list. A text scan is enough: any other `@deftai/*` name.
 */
function lockfileUsesOtherDeftai(projectRoot: string): boolean {
  for (const file of LOCKFILES) {
    let text: string;
    try {
      text = readFileSync(join(projectRoot, file), "utf8");
    } catch {
      continue;
    }
    for (const match of text.matchAll(/@deftai\/([a-z0-9][a-z0-9._-]*)/gi)) {
      if (isOtherDeftaiPackage(`@deftai/${(match[1] ?? "").toLowerCase()}`)) return true;
    }
  }
  return false;
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

  if (selected.source === "scoped" && projectUsesOtherDeftaiPackages(projectRoot)) {
    // #6141: npm and pnpm route a whole scope to one registry, so remapping
    // `@deftai` would break the project's other `@deftai/*` packages.
    const splitMessage =
      `${CHECK_NAME}: \`@deftai:registry\` routes @deftai packages to a non-public registry, ` +
      "and this project also uses other @deftai packages from there. " +
      "npm and pnpm send a whole scope to one registry. " +
      `Directive's two packages (${DIRECTIVE_PACKAGES_LABEL}) are published only on the public npm registry. ` +
      "Do not remap the whole @deftai scope; that would break your other @deftai packages. " +
      "If `package-lock.json` already records the runtime's npmjs URL, `npm ci` reinstalls from it. " +
      "pnpm lockfiles do not record that URL, so pnpm installs route through `@deftai:registry` again. " +
      "For one run, set `npm_config_@deftai:registry=https://registry.npmjs.org/` in the environment (changes no config). " +
      "To add or upgrade Directive, your registry needs to serve these two packages (for example a proxy registry with an upstream to npmjs), " +
      `or the internal packages need a different scope. See ${NPM_REGISTRY_MIRROR_DOC_URL}.`;
    sink.warn(splitMessage);
    addFinding({
      severity: "warning",
      message: splitMessage,
      check: CHECK_NAME,
      status: "split-scope",
      registry_source: selected.source,
      suggestion: NPM_REGISTRY_MIRROR_DOC_URL,
    });
    return;
  }

  const message =
    `${CHECK_NAME}: @deftai packages resolve through a non-public npm registry. ` +
    "Corporate mirrors can return E404/ETARGET or silently serve stale @latest metadata. " +
    "`--registry` does not beat `@deftai:registry`. " +
    "Where corporate policy permits, retry from a directory that does not load the project `.npmrc` (for example `$HOME`; " +
    `optionally \`--userconfig\` to a file that sets \`@deftai:registry=${PUBLIC_NPM_REGISTRY}\`), ` +
    `or add \`@deftai:registry=${PUBLIC_NPM_REGISTRY}\` to \`.npmrc\`. ` +
    `Otherwise ask your registry administrator to sync ${DIRECTIVE_PACKAGES_LABEL}. See ${NPM_REGISTRY_MIRROR_DOC_URL}.`;
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
