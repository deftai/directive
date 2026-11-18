/**
 * Split `@deftai` registry hint (#6141, D-009: message only).
 *
 * npm and pnpm send a whole scope to one registry. When a project routes
 * `@deftai` to a private registry for its own packages, Directive's two public
 * packages miss there. On a real registry miss we explain the cause and give a
 * one-run environment override. We never write npm/pnpm config (AC5.8) and
 * never print the configured registry URL.
 */
import { spawnSync } from "node:child_process";
import { LAUNCHER_PACKAGE_NAME, RUNTIME_PACKAGE_NAME } from "./constants.js";

const SCOPE_REGISTRY_KEY = "@deftai:registry";
const PUBLIC_NPM_REGISTRY = "https://registry.npmjs.org/";
const OVERRIDE_ENV_KEY = `npm_config_${SCOPE_REGISTRY_KEY}`;
const UNSET_NPM_VALUES = new Set(["", "null", "undefined"]);
const REDACTED = "<@deftai registry>";

/** npm / pnpm codes and phrases for "this registry does not have it". */
const REGISTRY_MISS_PATTERNS: readonly RegExp[] = [
  /\bE404\b/,
  /\b404 Not Found\b/i,
  /\bERR_PNPM_FETCH_404\b/,
  /\bETARGET\b/,
  /\bERR_PNPM_NO_MATCHING_VERSION\b/,
];

/** Directive package names as they appear in PM output (plain or URL-encoded). */
const DIRECTIVE_PACKAGE_PATTERN = /@deftai(?:\/|%2f)directive(?:-runtime)?(?![\w-])/i;

/**
 * Per-line evidence that the line itself reports the miss (not a command echo):
 * npm `404 Not Found - GET …/@deftai%2fdirective-runtime`, `'…' is not in this
 * registry`, `No matching version found for …`, pnpm `ERR_PNPM_FETCH_404 GET …`.
 */
const MISS_LINE_PATTERN = /\b404\b|not in this registry|no matching version|\bnot found\b/i;

export type RegistryHintVerb = "install" | "upgrade" | "repair";

export interface ScopedRegistryHintOptions {
  readonly verb: RegistryHintVerb;
  readonly env?: NodeJS.ProcessEnv;
  /** PM used for the lockfile reinstall line (repair only). */
  readonly pm?: "npm" | "pnpm";
  /** Repair: the lockfile already records the exact pin. */
  readonly lockfileRecordsPin?: boolean;
  /** Test seam: read the effective `@deftai:registry` (raw value or null). */
  readonly readScopedRegistry?: (projectRoot: string, env: NodeJS.ProcessEnv) => string | null;
}

export interface ScopedRegistryHint {
  /** Multi-line hint text, no trailing newline. */
  readonly hint: string;
  /** Replace the configured registry's URLs in PM output. */
  readonly redact: (text: string) => string;
}

/**
 * True when `blob` reports a registry miss for one of Directive's packages:
 * a miss code, plus a line that both reports the miss and names the Directive
 * package. A command echo naming the runtime does not count, so a miss for
 * another dependency gives no hint.
 */
export function isDirectiveRegistryMiss(blob: string): boolean {
  if (!REGISTRY_MISS_PATTERNS.some((p) => p.test(blob))) return false;
  return blob
    .split(/\r?\n/)
    .some((line) => DIRECTIVE_PACKAGE_PATTERN.test(line) && MISS_LINE_PATTERN.test(line));
}

/** Read `@deftai:registry` without contacting a registry (`npm config get`). */
export function defaultReadScopedRegistry(
  projectRoot: string,
  env: NodeJS.ProcessEnv,
): string | null {
  try {
    const proc = spawnSync("npm", ["config", "get", SCOPE_REGISTRY_KEY], {
      cwd: projectRoot,
      env,
      encoding: "utf8",
      // npm is a .cmd shim on Windows; the args are fixed literals.
      shell: process.platform === "win32",
      timeout: 5_000,
      windowsHide: true,
    });
    if (proc.status !== 0 || typeof proc.stdout !== "string") return null;
    return proc.stdout.trim();
  } catch {
    return null;
  }
}

function parseRegistryUrl(raw: string | null): URL | null {
  if (raw === null) return null;
  const trimmed = raw.trim();
  if (UNSET_NPM_VALUES.has(trimmed.toLowerCase())) return null;
  try {
    const url = new URL(trimmed);
    if ((url.protocol !== "https:" && url.protocol !== "http:") || url.hostname === "") {
      return null;
    }
    return url;
  } catch {
    return null;
  }
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function redactorFor(raw: string, url: URL): (text: string) => string {
  const hostPattern = new RegExp(
    `[a-z][a-z0-9+.-]*://(?:[^\\s/@'"]*@)?${escapeRegExp(url.host)}(?=[/:\\s'"]|$)[^\\s'"]*`,
    "gi",
  );
  const rawTrimmed = raw.trim();
  return (text) => text.split(rawTrimmed).join(REDACTED).replace(hostPattern, REDACTED);
}

function commandFor(verb: RegistryHintVerb): string {
  if (verb === "repair") return "directive install --repair";
  return `directive ${verb}`;
}

/**
 * Return the split-scope hint when `blob` is a registry miss for a Directive
 * package and the effective `@deftai:registry` is set and not public npm.
 * Returns null otherwise (including when a proxy registry serves the packages,
 * because then nothing fails).
 */
export function scopedRegistryHint(
  projectRoot: string,
  blob: string,
  options: ScopedRegistryHintOptions,
): ScopedRegistryHint | null {
  if (!isDirectiveRegistryMiss(blob)) return null;
  const env = options.env ?? process.env;
  const read = options.readScopedRegistry ?? defaultReadScopedRegistry;
  let raw: string | null;
  try {
    raw = read(projectRoot, env);
  } catch {
    return null;
  }
  const url = parseRegistryUrl(raw);
  if (url === null || raw === null) return null;
  if (url.hostname === "registry.npmjs.org") return null;

  const command = commandFor(options.verb);
  const lines = [
    "Hint: `@deftai:registry` sends every @deftai package to a non-public registry, " +
      "and that registry does not serve Directive. npm and pnpm route a whole scope to one registry. " +
      `Directive's two packages (${LAUNCHER_PACKAGE_NAME}, ${RUNTIME_PACKAGE_NAME}) are published only on ${PUBLIC_NPM_REGISTRY}`,
    "Do not remap the whole @deftai scope in .npmrc; that would break your other @deftai packages.",
  ];
  // npm lockfiles record each package's resolved URL; pnpm lockfiles do not, so
  // a pnpm frozen install routes through `@deftai:registry` again (#6141).
  if (
    options.verb === "repair" &&
    options.lockfileRecordsPin === true &&
    (options.pm ?? "npm") === "npm"
  ) {
    lines.push(
      `If package-lock.json records the runtime's npmjs URL, run \`npm ci\` in this project, then \`${command}\`.`,
    );
    lines.push(
      "Or re-run the same command with the same flags, overriding the registry for that one run (changes no config):",
    );
  } else {
    lines.push(
      "Re-run the same command with the same flags (for example --target-version, --root), overriding the registry for that one run (changes no config):",
    );
  }
  lines.push(`  env '${OVERRIDE_ENV_KEY}=${PUBLIC_NPM_REGISTRY}' ${command}`);
  lines.push(
    `  PowerShell: \${env:${OVERRIDE_ENV_KEY}}='${PUBLIC_NPM_REGISTRY}'; ${command}; Remove-Item 'env:${OVERRIDE_ENV_KEY}'`,
  );
  return { hint: lines.join("\n"), redact: redactorFor(raw, url) };
}
