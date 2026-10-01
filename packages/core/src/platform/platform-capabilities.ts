import {
  chownSync,
  existsSync,
  lstatSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
} from "node:fs";
import { userInfo } from "node:os";
import { dirname, join, parse as parsePath, posix, resolve as resolvePath, sep } from "node:path";
import {
  IDENTITY_LOCAL_USER,
  IDENTITY_REAL_ROOT,
  IDENTITY_SANDBOX_REMAPPED_LOCAL_USER,
  IDENTITY_UNKNOWN,
  RUNTIME_MODE_CLOUD_HEADLESS,
  RUNTIME_MODE_CURSOR_NATIVE_SANDBOX,
  RUNTIME_MODE_LOCAL_UNSANDBOXED,
} from "./constants.js";
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
} from "./cursor-managed-runtime.js";
import {
  detectEnvironmentContext,
  environmentContextToDict,
  type ShellContext,
} from "./shell-context.js";

const TRUTHY = new Set(["1", "true", "yes", "on"]);

const CURSOR_SIGNAL_VARS = [
  "CURSOR_SANDBOX",
  "CURSOR_SANDBOX_LANDLOCK_STATUS",
  "CURSOR_ORIG_UID",
  "CURSOR_ORIG_GID",
  "CURSOR_AGENT",
  "CURSOR_COMPOSER",
] as const;

const CLOUD_SIGNAL_VARS = [
  "CURSOR_AGENT",
  "GROK_BUILD",
  "OPENCLAW",
  "DEFT_HAS_SESSIONS_SPAWN",
  "DEFT_PROBE_SESSIONS_SPAWN",
  "DEFT_AGENT_RUNTIME",
  "CI",
  "GITHUB_ACTIONS",
  "BUILDKITE",
] as const;

export interface UidMapEntry {
  readonly insideId: number;
  readonly outsideId: number;
  readonly length: number;
}

export interface OwnershipFacts {
  readonly path: string;
  readonly uid: number;
  readonly gid: number;
  readonly interpretedAsSandboxView: boolean;
}

export interface RuntimeCapabilityReport {
  readonly hostPlatform: NodeJS.Platform;
  readonly shell: ShellContext;
  readonly runtimeMode: string;
  /** Stable id naming why `runtimeMode` was chosen (#3859). */
  readonly runtimeModeReason: string;
  readonly identityKind: string;
  readonly effectiveUid: number | null;
  readonly effectiveUsername: string | null;
  readonly uidMap: readonly UidMapEntry[];
  readonly cursorOrigUid: number | null;
  readonly cursorOrigGid: number | null;
  readonly sandboxUidRemap: boolean;
  readonly ownership: OwnershipFacts | null;
  readonly signals: Readonly<Record<string, string>>;
}

function envTruthy(environ: Readonly<Record<string, string>>, name: string): boolean {
  return TRUTHY.has((environ[name] ?? "").trim().toLowerCase());
}

function parseIntValue(value: string | undefined): number | null {
  if (value === undefined) return null;
  const text = value.trim();
  if (!text) return null;
  const n = Number.parseInt(text, 10);
  return Number.isNaN(n) ? null : n;
}

export function readUidMap(path: string): readonly UidMapEntry[] {
  if (!existsSync(path)) return [];
  const entries: UidMapEntry[] = [];
  for (const rawLine of readFileSync(path, "utf8").split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const parts = line.split(/\s+/);
    if (parts.length !== 3) continue;
    const insideId = Number.parseInt(parts[0] ?? "", 10);
    const outsideId = Number.parseInt(parts[1] ?? "", 10);
    const length = Number.parseInt(parts[2] ?? "", 10);
    if (Number.isNaN(insideId) || Number.isNaN(outsideId) || Number.isNaN(length)) continue;
    entries.push({ insideId, outsideId, length });
  }
  return entries;
}

export function detectSandboxUidRemap(
  uidMap: readonly UidMapEntry[],
  options: { effectiveUid: number | null; cursorOrigUid: number | null },
): boolean {
  if (options.effectiveUid !== 0) return false;
  if (options.cursorOrigUid === null) return false;
  return uidMap.some((entry) => entry.insideId === 0 && entry.outsideId === options.cursorOrigUid);
}

export function classifyIdentityKind(options: {
  effectiveUid: number | null;
  sandboxUidRemap: boolean;
}): string {
  if (options.effectiveUid === null) return IDENTITY_UNKNOWN;
  if (options.effectiveUid === 0) {
    return options.sandboxUidRemap ? IDENTITY_SANDBOX_REMAPPED_LOCAL_USER : IDENTITY_REAL_ROOT;
  }
  return IDENTITY_LOCAL_USER;
}

/** Reason id when a non-Cursor CI/cloud marker forces cloud-headless, else null. */
function ciCloudReason(environ: Readonly<Record<string, string>>): string | null {
  // GROK_BUILD / DEFT_AGENT_RUNTIME=grok-build identify a local TUI, not CI (#3469).
  const runtime = (environ.DEFT_AGENT_RUNTIME ?? "").trim().toLowerCase();
  if (runtime === "cloud" || runtime === "headless") return RUNTIME_REASON_CI_MARKER;
  if (envTruthy(environ, "GITHUB_ACTIONS") || envTruthy(environ, "BUILDKITE")) {
    return RUNTIME_REASON_CI_MARKER;
  }
  if (envTruthy(environ, "CI") && !envTruthy(environ, "CURSOR_COMPOSER")) {
    return RUNTIME_REASON_CI_MARKER;
  }
  return null;
}

function isCursorNativeSandbox(
  environ: Readonly<Record<string, string>>,
  sandboxUidRemap: boolean,
): boolean {
  if (sandboxUidRemap) return true;
  if (envTruthy(environ, "CURSOR_SANDBOX")) return true;
  return Boolean((environ.CURSOR_SANDBOX_LANDLOCK_STATUS ?? "").trim());
}

export interface RuntimeClassification {
  readonly mode: string;
  readonly reason: string;
}

/**
 * Classify runtime mode and name the reason for the verdict (#3859).
 *
 * Ordering matches intake/platform-capabilities.ts: CI markers, then a positive
 * managed-runtime read, then sandbox, then the ambiguous Cursor hop. The Cursor
 * hop previously ran first here; it now runs last so neither a CI marker nor a
 * managed read can be overridden by an explicit host-gh selection.
 */
export function classifyRuntime(
  environ: Readonly<Record<string, string>>,
  sandboxUidRemap: boolean,
  options: { managedRuntimeProbe?: ManagedRuntimeProbe } = {},
): RuntimeClassification {
  const ciReason = ciCloudReason(environ);
  if (ciReason !== null) return { mode: RUNTIME_MODE_CLOUD_HEADLESS, reason: ciReason };
  const managedProbe = options.managedRuntimeProbe ?? probeManagedRuntime;
  if (managedProbe(environ).verdict === "managed") {
    return {
      mode: RUNTIME_MODE_CLOUD_HEADLESS,
      reason: RUNTIME_REASON_MANAGED_RUNTIME_PROBE,
    };
  }
  if (isCursorNativeSandbox(environ, sandboxUidRemap)) {
    return {
      mode: RUNTIME_MODE_CURSOR_NATIVE_SANDBOX,
      reason: RUNTIME_REASON_CURSOR_SANDBOX_MARKER,
    };
  }
  if (envTruthy(environ, "CURSOR_AGENT")) {
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

export function classifyRuntimeMode(
  environ: Readonly<Record<string, string>>,
  sandboxUidRemap: boolean,
  options: { managedRuntimeProbe?: ManagedRuntimeProbe } = {},
): string {
  return classifyRuntime(environ, sandboxUidRemap, options).mode;
}

function readOwnership(path: string, sandboxUidRemap: boolean): OwnershipFacts | null {
  try {
    const stat = statSync(path);
    return {
      path,
      uid: stat.uid,
      gid: stat.gid,
      interpretedAsSandboxView: sandboxUidRemap,
    };
  } catch {
    return null;
  }
}

function collectSignals(environ: Readonly<Record<string, string>>): Record<string, string> {
  const names = [...new Set([...CURSOR_SIGNAL_VARS, ...CLOUD_SIGNAL_VARS])].sort();
  const out: Record<string, string> = {};
  for (const name of names) {
    if (name in environ) out[name] = environ[name] ?? "";
  }
  return out;
}

export interface ProbeRuntimeOptions {
  readonly environ?: Readonly<Record<string, string>>;
  readonly platform?: NodeJS.Platform;
  readonly userShell?: string | null;
  readonly uidMapPath?: string;
  readonly cwd?: string;
  readonly effectiveUidOverride?: number | null;
  readonly effectiveUsername?: string | null;
  readonly getuid?: () => number;
  /** Injectable managed-runtime probe (#3859). Defaults to the metadata read. */
  readonly managedRuntimeProbe?: ManagedRuntimeProbe;
}

export function probeRuntimeCapabilities(
  options: ProbeRuntimeOptions = {},
): RuntimeCapabilityReport {
  const env: Record<string, string> =
    options.environ === undefined
      ? ({ ...process.env } as Record<string, string>)
      : { ...options.environ };
  const environment = detectEnvironmentContext({
    environ: env,
    platform: options.platform,
    userShell: options.userShell,
  });

  // #1617: live process.getuid is the production probe. null/unknown must not
  // mean non-root — only an explicit override may force null (tests / seams).
  let effectiveUid: number | null;
  if (options.effectiveUidOverride !== undefined) {
    effectiveUid = options.effectiveUidOverride;
  } else if (options.getuid) {
    effectiveUid = options.getuid();
  } else if (typeof process.getuid === "function") {
    try {
      effectiveUid = process.getuid();
    } catch {
      effectiveUid = null;
    }
  } else {
    effectiveUid = null;
  }

  let effectiveUsername = options.effectiveUsername ?? env.USER ?? env.USERNAME ?? null;
  if (!effectiveUsername) {
    try {
      effectiveUsername = userInfo().username;
    } catch {
      effectiveUsername = null;
    }
  }

  const cursorOrigUid = parseIntValue(env.CURSOR_ORIG_UID);
  const cursorOrigGid = parseIntValue(env.CURSOR_ORIG_GID);

  const uidMapFile = options.uidMapPath ?? "/proc/self/uid_map";
  const uidMap = readUidMap(uidMapFile);

  const sandboxUidRemap = detectSandboxUidRemap(uidMap, { effectiveUid, cursorOrigUid });
  const identityKind = classifyIdentityKind({ effectiveUid, sandboxUidRemap });
  const runtime = classifyRuntime(env, sandboxUidRemap, {
    managedRuntimeProbe: options.managedRuntimeProbe,
  });

  const cwdPath = options.cwd ?? process.cwd();
  const ownership = readOwnership(cwdPath, sandboxUidRemap);

  return {
    hostPlatform: environment.hostPlatform,
    shell: environment.shell,
    runtimeMode: runtime.mode,
    runtimeModeReason: runtime.reason,
    identityKind,
    effectiveUid,
    effectiveUsername,
    uidMap,
    cursorOrigUid,
    cursorOrigGid,
    sandboxUidRemap,
    ownership,
    signals: collectSignals(env),
  };
}

export function getPlatformCapabilities(
  options: ProbeRuntimeOptions = {},
): RuntimeCapabilityReport {
  return probeRuntimeCapabilities(options);
}

export function reportToDict(report: RuntimeCapabilityReport): Record<string, unknown> {
  return {
    ...environmentContextToDict({ hostPlatform: report.hostPlatform, shell: report.shell }),
    runtime_mode: report.runtimeMode,
    runtime_mode_reason: report.runtimeModeReason,
    identity_kind: report.identityKind,
    effective_uid: report.effectiveUid,
    effective_username: report.effectiveUsername,
    uid_map: report.uidMap.map((e) => ({
      inside_id: e.insideId,
      outside_id: e.outsideId,
      length: e.length,
    })),
    cursor_orig_uid: report.cursorOrigUid,
    cursor_orig_gid: report.cursorOrigGid,
    sandbox_uid_remap: report.sandboxUidRemap,
    ownership: report.ownership
      ? {
          path: report.ownership.path,
          uid: report.ownership.uid,
          gid: report.ownership.gid,
          interpreted_as_sandbox_view: report.ownership.interpretedAsSandboxView,
        }
      : null,
    signals: report.signals,
  };
}

// ---------------------------------------------------------------------------
// WSL root-runtime ownership guard (#1617)
// Classifier that owns filesystem project-owner facts for this guard.
// Distinct from occupancy/session owner and issue-emit private recovery owner.
// ---------------------------------------------------------------------------

/** Stable id naming the classifier that owns WSL ownership facts (#1617). */
export const OWNERSHIP_FACTS_CLASSIFIER = "wsl-root-runtime-ownership-guard" as const;

/** Env override for restrained root on WSL — not an OS security boundary. */
export const DEFT_ALLOW_ROOT_WSL_RUNTIME = "DEFT_ALLOW_ROOT_WSL_RUNTIME";

/** Explicit project owner uid:gid when inference is ambiguous. */
export const DEFT_PROJECT_OWNER = "DEFT_PROJECT_OWNER";

/**
 * Override acknowledgment limitation (#1617 item 6): a sole env flag set by
 * the restrained root principal is not out-of-band/human-visible. Stronger
 * binding (TTY confirm / parent lease) is deferred.
 */
export const ROOT_WSL_OVERRIDE_LIMITATION =
  "DEFT_ALLOW_ROOT_WSL_RUNTIME is process-env only; a restrained root can set " +
  "it without out-of-band human acknowledgment. It is not an OS security boundary.";

export type OwnershipMountCapability = "harm-capable" | "mount-pinned" | "unknown";

export type ProjectOwnerSource =
  | "explicit-owner"
  | "project-root"
  | "nearest-nonroot-ancestor"
  | "home-passwd"
  | "sudo-env"
  | "user-env"
  | "ambiguous"
  | "unresolved";

export type WslOwnershipGuardStatus =
  | "ok"
  | "warn"
  | "fail"
  | "exempt-non-wsl"
  | "exempt-override"
  | "exempt-mount-pinned"
  | "exempt-sandbox-remap";

export interface OwnerCandidate {
  readonly uid: number;
  readonly gid: number;
  readonly account: string | null;
  readonly source: ProjectOwnerSource;
}

export interface ResolvedProjectOwner {
  readonly uid: number | null;
  readonly gid: number | null;
  readonly account: string | null;
  readonly source: ProjectOwnerSource;
  readonly candidates: readonly OwnerCandidate[];
  readonly conflict: boolean;
  readonly detail: string;
}

export interface MountOwnershipFacts {
  readonly path: string;
  readonly capability: OwnershipMountCapability;
  readonly fstype: string | null;
  readonly options: string | null;
  readonly detail: string;
}

export interface WslOwnershipGuardVerdict {
  readonly classifier: typeof OWNERSHIP_FACTS_CLASSIFIER;
  /** True when host looks like WSL (Linux + WSL signals). */
  readonly wsl: boolean;
  readonly status: WslOwnershipGuardStatus;
  readonly effectiveUid: number | null;
  readonly identityKind: string;
  readonly intendedOwner: ResolvedProjectOwner;
  readonly mount: MountOwnershipFacts;
  readonly overrideSet: boolean;
  readonly overrideLimitation: string;
  readonly messages: readonly string[];
  /** Soft session:start lines; empty when nothing to warn. */
  readonly sessionWarnLines: readonly string[];
  /** True when a protected mutating entry point must refuse. */
  readonly blockProtectedMutation: boolean;
}

export interface OwnershipGuardSeams {
  readonly environ?: Readonly<Record<string, string | undefined>>;
  readonly platform?: NodeJS.Platform;
  readonly projectRoot?: string;
  readonly effectiveUidOverride?: number | null;
  readonly getuid?: () => number;
  readonly readFile?: (path: string) => string | null;
  readonly statOwnership?: (path: string) => { uid: number; gid: number } | null;
  readonly readPasswd?: () => string | null;
  readonly readMountInfo?: () => string | null;
  readonly explicitOwner?: string | null;
  /** When true, treat override as set even without env (tests). */
  readonly forceOverride?: boolean;
}

/**
 * Preserve POSIX absolute paths on win32 hosts (unit seams / cross-compile).
 * Windows drive paths and relative paths still use platform resolve.
 */
function normalizeProjectPath(projectRoot: string): string {
  const trimmed = projectRoot.trim() || ".";
  if (trimmed.startsWith("/")) {
    return posix.normalize(trimmed);
  }
  return resolvePath(trimmed);
}

function readTextOrNull(
  path: string,
  readFile: ((path: string) => string | null) | undefined,
): string | null {
  if (readFile) {
    try {
      return readFile(path);
    } catch {
      return null;
    }
  }
  try {
    if (!existsSync(path)) return null;
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

function defaultStatOwnership(path: string): { uid: number; gid: number } | null {
  try {
    const st = lstatSync(path);
    return { uid: st.uid, gid: st.gid };
  } catch {
    return null;
  }
}

/** Detect WSL from env and /proc/version — native win32/darwin never match. */
export function detectWslHost(options: {
  readonly environ?: Readonly<Record<string, string | undefined>>;
  readonly platform?: NodeJS.Platform;
  readonly readFile?: (path: string) => string | null;
}): boolean {
  const platform = options.platform ?? process.platform;
  if (platform === "win32" || platform === "darwin") return false;
  if (platform !== "linux") return false;
  const env = options.environ ?? process.env;
  if ((env.WSL_DISTRO_NAME ?? "").trim()) return true;
  if ((env.WSL_INTEROP ?? "").trim()) return true;
  if (TRUTHY.has((env.WSLENV ?? "").trim().toLowerCase())) return true;
  const version = readTextOrNull("/proc/version", options.readFile);
  if (version === null) return false;
  return /microsoft|wsl/i.test(version);
}

function parsePasswdAccount(
  passwdText: string,
  predicate: (uid: number, name: string, home: string) => boolean,
): OwnerCandidate | null {
  for (const raw of passwdText.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const parts = line.split(":");
    if (parts.length < 7) continue;
    const name = parts[0] ?? "";
    const uid = Number.parseInt(parts[2] ?? "", 10);
    const gid = Number.parseInt(parts[3] ?? "", 10);
    const home = parts[5] ?? "";
    if (!name || Number.isNaN(uid) || Number.isNaN(gid)) continue;
    if (uid === 0) continue;
    if (predicate(uid, name, home)) {
      return { uid, gid, account: name, source: "home-passwd" };
    }
  }
  return null;
}

function lookupPasswdByName(
  passwdText: string,
  account: string,
): { uid: number; gid: number; account: string } | null {
  for (const raw of passwdText.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const parts = line.split(":");
    if (parts.length < 4) continue;
    const name = parts[0] ?? "";
    if (name !== account) continue;
    const uid = Number.parseInt(parts[2] ?? "", 10);
    const gid = Number.parseInt(parts[3] ?? "", 10);
    if (Number.isNaN(uid) || Number.isNaN(gid) || uid === 0) return null;
    return { uid, gid, account: name };
  }
  return null;
}

function lookupPasswdByUid(
  passwdText: string,
  uid: number,
): { uid: number; gid: number; account: string } | null {
  for (const raw of passwdText.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const parts = line.split(":");
    if (parts.length < 4) continue;
    const name = parts[0] ?? "";
    const entryUid = Number.parseInt(parts[2] ?? "", 10);
    const gid = Number.parseInt(parts[3] ?? "", 10);
    if (entryUid !== uid || Number.isNaN(gid) || uid === 0) continue;
    return { uid, gid, account: name };
  }
  return null;
}

/** Parse `uid:gid` or refuse. */
export function parseOwnerSpec(spec: string): { uid: number; gid: number } | null {
  const text = spec.trim();
  const match = /^(\d+):(\d+)$/.exec(text);
  if (!match) return null;
  const uid = Number.parseInt(match[1] ?? "", 10);
  const gid = Number.parseInt(match[2] ?? "", 10);
  if (Number.isNaN(uid) || Number.isNaN(gid)) return null;
  return { uid, gid };
}

function sameOwner(a: OwnerCandidate, b: OwnerCandidate): boolean {
  return a.uid === b.uid && a.gid === b.gid;
}

/**
 * Dynamic project-owner resolution (#1617 item 4).
 * Env-sourced candidates never alone authorize chown — callers must require
 * explicit --owner / DEFT_PROJECT_OWNER when using repair.
 */
export function resolveProjectOwner(options: OwnershipGuardSeams = {}): ResolvedProjectOwner {
  const projectRoot = normalizeProjectPath(options.projectRoot ?? process.cwd());
  const env = options.environ ?? process.env;
  const statOwnership = options.statOwnership ?? defaultStatOwnership;
  const candidates: OwnerCandidate[] = [];
  const explicitRaw =
    options.explicitOwner ??
    (typeof env[DEFT_PROJECT_OWNER] === "string" ? env[DEFT_PROJECT_OWNER] : null);
  if (explicitRaw && explicitRaw.trim()) {
    const parsed = parseOwnerSpec(explicitRaw);
    if (parsed === null) {
      return {
        uid: null,
        gid: null,
        account: null,
        source: "unresolved",
        candidates,
        conflict: false,
        detail: `Invalid ${DEFT_PROJECT_OWNER} / --owner value '${explicitRaw.trim()}'; expected uid:gid.`,
      };
    }
    const passwd = options.readPasswd
      ? options.readPasswd()
      : readTextOrNull("/etc/passwd", options.readFile);
    const account = passwd ? (lookupPasswdByUid(passwd, parsed.uid)?.account ?? null) : null;
    return {
      uid: parsed.uid,
      gid: parsed.gid,
      account,
      source: "explicit-owner",
      candidates: [{ uid: parsed.uid, gid: parsed.gid, account, source: "explicit-owner" }],
      conflict: false,
      detail: `Explicit owner ${parsed.uid}:${parsed.gid}${account ? ` (${account})` : ""}.`,
    };
  }

  const rootStat = statOwnership(projectRoot);
  if (rootStat && rootStat.uid !== 0) {
    candidates.push({
      uid: rootStat.uid,
      gid: rootStat.gid,
      account: null,
      source: "project-root",
    });
  } else {
    let cursor = projectRoot;
    for (let i = 0; i < 64; i += 1) {
      const parent = dirname(cursor);
      if (parent === cursor) break;
      const st = statOwnership(parent);
      if (st && st.uid !== 0) {
        candidates.push({
          uid: st.uid,
          gid: st.gid,
          account: null,
          source: "nearest-nonroot-ancestor",
        });
        break;
      }
      cursor = parent;
    }
  }

  const passwd = options.readPasswd
    ? options.readPasswd()
    : readTextOrNull("/etc/passwd", options.readFile);
  const normalizedRoot = projectRoot.replace(/\\/g, "/");
  const homeMatch = /^\/home\/([^/]+)/.exec(normalizedRoot);
  if (passwd && homeMatch) {
    const homeUser = homeMatch[1] ?? "";
    const fromHome = parsePasswdAccount(
      passwd,
      (_uid, name, home) => name === homeUser || home === `/home/${homeUser}`,
    );
    if (fromHome) {
      candidates.push({ ...fromHome, source: "home-passwd" });
    }
  }

  const sudoUid = parseIntValue(env.SUDO_UID);
  const sudoGid = parseIntValue(env.SUDO_GID);
  if (sudoUid !== null && sudoUid !== 0 && passwd) {
    const entry = lookupPasswdByUid(passwd, sudoUid);
    if (entry) {
      candidates.push({
        uid: entry.uid,
        gid: sudoGid !== null && sudoGid !== 0 ? sudoGid : entry.gid,
        account: entry.account,
        source: "sudo-env",
      });
    }
  }

  for (const key of ["USER", "LOGNAME"] as const) {
    const name = (env[key] ?? "").trim();
    if (!name || name === "root" || !passwd) continue;
    const entry = lookupPasswdByName(passwd, name);
    if (entry) {
      candidates.push({
        uid: entry.uid,
        gid: entry.gid,
        account: entry.account,
        source: "user-env",
      });
    }
  }

  const homeEnv = (env.HOME ?? "").trim();
  if (homeEnv && passwd && homeEnv !== "/root") {
    const fromHomeEnv = parsePasswdAccount(passwd, (_uid, _name, home) => home === homeEnv);
    if (fromHomeEnv) {
      candidates.push({ ...fromHomeEnv, source: "user-env" });
    }
  }

  if (candidates.length === 0) {
    return {
      uid: null,
      gid: null,
      account: null,
      source: "unresolved",
      candidates,
      conflict: false,
      detail:
        "No safe non-root project owner candidate. Set --owner uid:gid or " +
        `${DEFT_PROJECT_OWNER}=uid:gid.`,
    };
  }

  const primary = candidates[0]!;
  const conflict = candidates.some((c) => !sameOwner(c, primary));
  if (conflict) {
    const summary = candidates
      .map((c) => `${c.uid}:${c.gid}@${c.source}${c.account ? `(${c.account})` : ""}`)
      .join(", ");
    return {
      uid: null,
      gid: null,
      account: null,
      source: "ambiguous",
      candidates,
      conflict: true,
      detail:
        `Conflicting owner candidates (${summary}). Set --owner uid:gid or ` +
        `${DEFT_PROJECT_OWNER}=uid:gid.`,
    };
  }

  // Enrich account from passwd when missing.
  let account = primary.account;
  if (!account && passwd) {
    account = lookupPasswdByUid(passwd, primary.uid)?.account ?? null;
  }
  return {
    uid: primary.uid,
    gid: primary.gid,
    account,
    source: primary.source,
    candidates,
    conflict: false,
    detail:
      `Resolved filesystem project-owner ${primary.uid}:${primary.gid}` +
      `${account ? ` (${account})` : ""} via ${primary.source}.`,
  };
}

/**
 * Classify whether the project path can take real root-owned files (#1617 item 2).
 * DrvFs/9p without metadata are mount-pinned — do not fail closed.
 * Unknown/error fails closed.
 */
export function classifyMountOwnershipCapability(
  projectRoot: string,
  options: {
    readonly readMountInfo?: () => string | null;
    readonly readFile?: (path: string) => string | null;
    /** Resolve symlinks before mount matching (symlink on DrvFs → ext4 target). */
    readonly realpath?: (path: string) => string;
  } = {},
): MountOwnershipFacts {
  const inputPath = normalizeProjectPath(projectRoot);
  let path = inputPath;
  try {
    if (options.realpath) {
      path = options.realpath(inputPath);
    } else {
      try {
        path = realpathSync(inputPath);
      } catch {
        path = inputPath;
      }
    }
  } catch {
    path = inputPath;
  }
  path = normalizeProjectPath(path);
  const normalized = path.replace(/\\/g, "/");
  // Injected null/empty must not fall through via ?? to a live /proc read (CI Linux).
  const mountInfo =
    options.readMountInfo !== undefined
      ? options.readMountInfo()
      : readTextOrNull("/proc/self/mountinfo", options.readFile);
  if (mountInfo === null || mountInfo.trim() === "") {
    // Prefer harm-capable for classic Linux home trees when mount table is
    // unreadable only if path is under /home — otherwise unknown (fail closed).
    // Empty tables are unknown everywhere (Bound: unknown/empty fail closed).
    if (mountInfo === null && normalized.startsWith("/home/")) {
      return {
        path,
        capability: "harm-capable",
        fstype: null,
        options: null,
        detail: "Mount table unreadable; path under /home treated as harm-capable.",
      };
    }
    return {
      path,
      capability: "unknown",
      fstype: null,
      options: null,
      detail:
        mountInfo !== null && mountInfo.trim() === ""
          ? "Empty mount table; ownership semantics unknown (fail closed)."
          : "Cannot read /proc/self/mountinfo to classify ownership semantics; " +
            "fail closed. Re-run on a readable mount table or set " +
            `${DEFT_ALLOW_ROOT_WSL_RUNTIME}=1 with human acknowledgment.`,
    };
  }

  let best: { mountPoint: string; fstype: string; options: string } | null = null;
  for (const raw of mountInfo.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    // mountinfo: ... mountPoint mountOptions ... - fstype source superOptions
    const sepIdx = line.indexOf(" - ");
    if (sepIdx < 0) continue;
    const left = line.slice(0, sepIdx).split(" ");
    const right = line.slice(sepIdx + 3).split(" ");
    if (left.length < 5 || right.length < 1) continue;
    const mountPoint = (left[4] ?? "").replace(/\\040/g, " ");
    const fstype = right[0] ?? "";
    const options = `${left[5] ?? ""},${right.slice(2).join(",")}`;
    if (!mountPoint) continue;
    const mountNorm = mountPoint.replace(/\\/g, "/");
    if (
      normalized === mountNorm ||
      normalized.startsWith(mountNorm.endsWith("/") ? mountNorm : `${mountNorm}/`) ||
      mountNorm === "/"
    ) {
      if (!best || mountNorm.length >= best.mountPoint.length) {
        best = { mountPoint: mountNorm, fstype, options };
      }
    }
  }

  if (!best) {
    return {
      path,
      capability: "unknown",
      fstype: null,
      options: null,
      detail: "No matching mountinfo entry; ownership semantics unknown (fail closed).",
    };
  }

  const fstype = best.fstype.toLowerCase();
  const opts = best.options.toLowerCase();
  const isDrvFs = fstype === "drvfs" || fstype === "9p" || fstype.includes("drvfs");
  const metadataEnabled = /\bmetadata\b/.test(opts) || /\bmetadata=1\b/.test(opts);
  if (isDrvFs && !metadataEnabled) {
    return {
      path,
      capability: "mount-pinned",
      fstype: best.fstype,
      options: best.options,
      detail:
        `Mount ${best.mountPoint} is ${best.fstype} without metadata; uid/gid are ` +
        "mount-pinned and root cannot create root-owned files — WSL ownership " +
        "guard does not fail closed here.",
    };
  }
  if (
    normalized.startsWith("/home/") ||
    ["ext4", "ext3", "ext2", "xfs", "btrfs", "zfs", "bcachefs"].includes(fstype) ||
    (isDrvFs && metadataEnabled)
  ) {
    return {
      path,
      capability: "harm-capable",
      fstype: best.fstype,
      options: best.options,
      detail:
        `Mount ${best.mountPoint} (${best.fstype}) can record real uid 0 ownership` +
        `${isDrvFs && metadataEnabled ? " (metadata-enabled)" : ""}.`,
    };
  }
  return {
    path,
    capability: "unknown",
    fstype: best.fstype,
    options: best.options,
    detail: `Mount ${best.mountPoint} fstype=${best.fstype} ownership semantics unknown; fail closed.`,
  };
}

function formatOwnerLabel(owner: ResolvedProjectOwner): string {
  if (owner.uid === null || owner.gid === null) {
    return owner.detail;
  }
  return `${owner.uid}:${owner.gid}${owner.account ? ` (${owner.account})` : ""}`;
}

/**
 * Evaluate the WSL root-runtime ownership guard (#1617).
 * Native Windows/macOS always return exempt-non-wsl (no WSL hard failures).
 * Returned failures only — no throw.
 */
export function evaluateWslOwnershipGuard(
  options: OwnershipGuardSeams = {},
): WslOwnershipGuardVerdict {
  const projectRoot = normalizeProjectPath(options.projectRoot ?? process.cwd());
  const envRecord: Record<string, string> = {};
  const rawEnv = options.environ ?? process.env;
  for (const [k, v] of Object.entries(rawEnv)) {
    if (typeof v === "string") envRecord[k] = v;
  }
  const wsl = detectWslHost({
    environ: rawEnv,
    platform: options.platform,
    readFile: options.readFile,
  });
  const runtime = probeRuntimeCapabilities({
    environ: envRecord,
    platform: options.platform,
    cwd: projectRoot,
    effectiveUidOverride: options.effectiveUidOverride,
    getuid: options.getuid,
  });
  const intendedOwner = resolveProjectOwner({
    ...options,
    projectRoot,
    environ: rawEnv,
  });
  const mount = classifyMountOwnershipCapability(projectRoot, {
    readMountInfo: options.readMountInfo,
    readFile: options.readFile,
  });
  const overrideSet =
    options.forceOverride === true || envTruthy(envRecord, DEFT_ALLOW_ROOT_WSL_RUNTIME);

  const base = {
    classifier: OWNERSHIP_FACTS_CLASSIFIER,
    wsl,
    effectiveUid: runtime.effectiveUid,
    identityKind: runtime.identityKind,
    intendedOwner,
    mount,
    overrideSet,
    overrideLimitation: ROOT_WSL_OVERRIDE_LIMITATION,
  } as const;

  if (!wsl) {
    return {
      ...base,
      status: "exempt-non-wsl",
      messages: [
        "WSL ownership guard skipped: host is not WSL (native Windows/macOS/Linux non-WSL).",
      ],
      sessionWarnLines: [],
      blockProtectedMutation: false,
    };
  }

  if (runtime.sandboxUidRemap || runtime.identityKind === IDENTITY_SANDBOX_REMAPPED_LOCAL_USER) {
    return {
      ...base,
      status: "exempt-sandbox-remap",
      messages: [
        "WSL ownership guard skipped: sandbox uid remap (not real root vs project owner).",
      ],
      sessionWarnLines: [],
      blockProtectedMutation: false,
    };
  }

  // null/unknown must not mean non-root on WSL.
  const uidUnknown = runtime.effectiveUid === null;
  const isRoot = runtime.effectiveUid === 0;
  const ownerNonRoot =
    intendedOwner.uid !== null && intendedOwner.uid !== 0 && !intendedOwner.conflict;

  if (!isRoot && !uidUnknown) {
    return {
      ...base,
      status: "ok",
      messages: [`WSL ownership guard ok: effective uid ${runtime.effectiveUid} is non-root.`],
      sessionWarnLines: [],
      blockProtectedMutation: false,
    };
  }

  if (mount.capability === "mount-pinned") {
    return {
      ...base,
      status: "exempt-mount-pinned",
      messages: [mount.detail],
      sessionWarnLines: [],
      blockProtectedMutation: false,
    };
  }

  if (overrideSet) {
    const ownerLabel = formatOwnerLabel(intendedOwner);
    const warn =
      `[deft ownership] WSL root runtime override active via ${DEFT_ALLOW_ROOT_WSL_RUNTIME}; ` +
      `intended filesystem project-owner ${ownerLabel}. ${ROOT_WSL_OVERRIDE_LIMITATION}`;
    return {
      ...base,
      status: "exempt-override",
      messages: [warn],
      sessionWarnLines: [warn],
      blockProtectedMutation: false,
    };
  }

  const ownerLabel = formatOwnerLabel(intendedOwner);
  const identityBit = uidUnknown
    ? "effective uid is unknown (null must not mean non-root)"
    : "effective uid is 0 (real root)";
  const mountBit =
    mount.capability === "unknown"
      ? `mount ownership semantics unknown (${mount.detail})`
      : mount.detail;
  const failDetail =
    `WSL agent-as-root ownership mismatch: ${identityBit}; ` +
    `intended filesystem project-owner ${ownerLabel}; ${mountBit}. ` +
    `Recover with \`deft ownership:doctor\` / \`deft ownership:fix\`, or set ` +
    `${DEFT_ALLOW_ROOT_WSL_RUNTIME}=1 (limitation: ${ROOT_WSL_OVERRIDE_LIMITATION}). ` +
    "This guard is a Directive entry-point check, not an OS security boundary.";

  const sessionWarn =
    `[deft ownership] WARN: WSL runtime ${identityBit} while filesystem project-owner ` +
    `is ${ownerLabel} (classifier=${OWNERSHIP_FACTS_CLASSIFIER}). ` +
    "Mutating install/update/check/preflight will fail closed unless " +
    `${DEFT_ALLOW_ROOT_WSL_RUNTIME}=1. Run \`deft ownership:doctor\`.`;

  // Fail when root (or unknown) on harm-capable/unknown mounts with non-root owner,
  // or when owner itself is unresolved/ambiguous under root/unknown identity.
  const shouldBlock =
    (isRoot || uidUnknown) &&
    (mount.capability === "harm-capable" || mount.capability === "unknown") &&
    (ownerNonRoot || intendedOwner.conflict || intendedOwner.uid === null);

  if (shouldBlock) {
    return {
      ...base,
      status: "fail",
      messages: [failDetail],
      sessionWarnLines: [sessionWarn],
      blockProtectedMutation: true,
    };
  }

  // Soft warn path: root on WSL but owner is also root / inconclusive without block.
  return {
    ...base,
    status: "warn",
    messages: [sessionWarn],
    sessionWarnLines: [sessionWarn],
    blockProtectedMutation: false,
  };
}

/**
 * Live check for protected mutating entry points (#1617 item 5).
 * Independent of ritual/doctor cache. Returned failure only.
 */
export function assertProtectedMutationOwnership(options: OwnershipGuardSeams = {}): {
  readonly ok: boolean;
  readonly exitCode: number;
  readonly verdict: WslOwnershipGuardVerdict;
  readonly message: string;
} {
  const verdict = evaluateWslOwnershipGuard(options);
  if (!verdict.blockProtectedMutation) {
    return { ok: true, exitCode: 0, verdict, message: verdict.messages[0] ?? "ok" };
  }
  return {
    ok: false,
    exitCode: 1,
    verdict,
    message: verdict.messages[0] ?? "WSL ownership guard refused protected mutation.",
  };
}

export function ownershipGuardToDict(verdict: WslOwnershipGuardVerdict): Record<string, unknown> {
  return {
    classifier: verdict.classifier,
    vocabulary: {
      filesystem_project_owner: "uid:gid of project tree owner (this guard)",
      occupancy_session_owner: "cooperative session lease id (not this guard)",
      issue_emit_private_recovery_owner: "issue-emit trusted per-uid dir (not this guard)",
    },
    wsl: verdict.wsl,
    status: verdict.status,
    effective_uid: verdict.effectiveUid,
    identity_kind: verdict.identityKind,
    intended_owner: {
      uid: verdict.intendedOwner.uid,
      gid: verdict.intendedOwner.gid,
      account: verdict.intendedOwner.account,
      source: verdict.intendedOwner.source,
      conflict: verdict.intendedOwner.conflict,
      detail: verdict.intendedOwner.detail,
      candidates: verdict.intendedOwner.candidates.map((c) => ({
        uid: c.uid,
        gid: c.gid,
        account: c.account,
        source: c.source,
      })),
    },
    mount: {
      path: verdict.mount.path,
      capability: verdict.mount.capability,
      fstype: verdict.mount.fstype,
      options: verdict.mount.options,
      detail: verdict.mount.detail,
    },
    override_set: verdict.overrideSet,
    override_limitation: verdict.overrideLimitation,
    block_protected_mutation: verdict.blockProtectedMutation,
    messages: [...verdict.messages],
  };
}

/** Approved repair roots relative to project (no blanket HOME). */
export const OWNERSHIP_FIX_PROJECT_RELATIVE_ROOTS = [
  ".",
  ".deft",
  ".venv",
  "node_modules",
  ".deft-cache",
  ".pytest_cache",
  "xbrief",
  "vbrief",
] as const;

export interface OwnershipFixResult {
  readonly ok: boolean;
  readonly exitCode: number;
  readonly repaired: readonly string[];
  readonly skippedProtected: readonly string[];
  readonly failed: readonly string[];
  readonly messages: readonly string[];
}

export interface OwnershipFixSeams extends OwnershipGuardSeams {
  readonly chown?: (path: string, uid: number, gid: number) => void;
  readonly readdir?: (path: string) => string[];
  readonly exists?: (path: string) => boolean;
  readonly lstat?: (
    path: string,
  ) => { uid: number; gid: number; isDirectory: boolean; isSymbolicLink: boolean } | null;
  readonly approvedRoots?: readonly string[];
  /** Env-sourced owner alone must not authorize chown. */
  readonly allowEnvOwnerForChown?: boolean;
}

function isPathInsideRoot(path: string, root: string): boolean {
  const resolvedPath = resolvePath(path);
  const resolvedRoot = resolvePath(root);
  if (resolvedPath === resolvedRoot) return true;
  const prefix = resolvedRoot.endsWith(sep) ? resolvedRoot : resolvedRoot + sep;
  return resolvedPath.startsWith(prefix);
}

/**
 * Scoped ownership:fix (#1617 item 8). Root-owned objects only; no symlink
 * follow outside approved roots; post-chown re-stat required.
 */
export function fixScopedOwnership(options: OwnershipFixSeams = {}): OwnershipFixResult {
  const projectRoot = normalizeProjectPath(options.projectRoot ?? process.cwd());
  const owner = resolveProjectOwner(options);
  const messages: string[] = [];
  if (owner.uid === null || owner.gid === null || owner.conflict) {
    return {
      ok: false,
      exitCode: 1,
      repaired: [],
      skippedProtected: [],
      failed: [],
      messages: [
        owner.detail,
        "Env-sourced candidates alone do not authorize chown; pass --owner uid:gid.",
      ],
    };
  }
  if (
    owner.source !== "explicit-owner" &&
    owner.source !== "project-root" &&
    owner.source !== "nearest-nonroot-ancestor" &&
    owner.source !== "home-passwd" &&
    options.allowEnvOwnerForChown !== true
  ) {
    // sudo-env / user-env alone must not authorize chown.
    if (owner.source === "sudo-env" || owner.source === "user-env") {
      return {
        ok: false,
        exitCode: 1,
        repaired: [],
        skippedProtected: [],
        failed: [],
        messages: [
          `Owner source ${owner.source} alone does not authorize chown. ` +
            `Pass --owner ${owner.uid}:${owner.gid} or set ${DEFT_PROJECT_OWNER}.`,
        ],
      };
    }
  }

  const statOwnership = options.statOwnership ?? defaultStatOwnership;
  const chown =
    options.chown ??
    ((path: string, uid: number, gid: number) => {
      chownSync(path, uid, gid);
    });
  const readdir = options.readdir ?? ((path: string) => readdirSync(path));
  const exists = options.exists ?? ((path: string) => existsSync(path));

  const relativeRoots = options.approvedRoots ?? OWNERSHIP_FIX_PROJECT_RELATIVE_ROOTS;
  const approvedAbs: string[] = [];
  const joinUnderRoot = projectRoot.startsWith("/")
    ? (root: string, rel: string) => posix.join(root, rel)
    : (root: string, rel: string) => resolvePath(root, rel);
  for (const rel of relativeRoots) {
    const abs = rel === "." ? projectRoot : joinUnderRoot(projectRoot, rel);
    approvedAbs.push(abs);
  }

  const repaired: string[] = [];
  const skippedProtected: string[] = [];
  const failed: string[] = [];

  const lstat =
    options.lstat ??
    ((path: string) => {
      try {
        const raw = lstatSync(path);
        return {
          uid: raw.uid,
          gid: raw.gid,
          isDirectory: raw.isDirectory(),
          isSymbolicLink: raw.isSymbolicLink(),
        };
      } catch {
        return null;
      }
    });

  const visit = (absPath: string, root: string): void => {
    const raw = lstat(absPath);
    if (raw === null) return;
    const st = {
      uid: raw.uid,
      gid: raw.gid,
      isDir: raw.isDirectory,
      isSymlink: raw.isSymbolicLink,
    };
    if (st.isSymlink) {
      // Do not follow symlinks outside approved roots.
      let target: string | null = null;
      try {
        target = realpathSync(absPath);
      } catch {
        skippedProtected.push(absPath);
        return;
      }
      if (
        !isPathInsideRoot(target, root) &&
        !approvedAbs.some((r) => isPathInsideRoot(target!, r))
      ) {
        skippedProtected.push(absPath);
        return;
      }
      return;
    }
    // Protected leftovers (Cursor indexes): report, do not change.
    const base = parsePath(absPath).base;
    if (base === "cursor" && absPath.replace(/\\/g, "/").includes("/.git/cursor")) {
      skippedProtected.push(absPath);
      return;
    }
    if (st.uid === 0) {
      try {
        chown(absPath, owner.uid!, owner.gid!);
        const after = statOwnership(absPath);
        if (!after || after.uid !== owner.uid || after.gid !== owner.gid) {
          failed.push(absPath);
          messages.push(
            `chown appeared to succeed but re-stat still shows uid=${after?.uid ?? "?"} ` +
              `gid=${after?.gid ?? "?"} at ${absPath} (DrvFs false-success).`,
          );
        } else {
          repaired.push(absPath);
        }
      } catch (err) {
        failed.push(absPath);
        messages.push(
          `chown failed at ${absPath}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    if (st.isDir) {
      let entries: string[] = [];
      try {
        entries = readdir(absPath);
      } catch (err) {
        failed.push(absPath);
        messages.push(
          `cannot list directory ${absPath}: ${err instanceof Error ? err.message : String(err)}`,
        );
        return;
      }
      for (const name of entries) {
        visit(join(absPath, name), root);
      }
    }
  };

  for (const root of approvedAbs) {
    if (!exists(root)) continue;
    visit(root, root);
  }

  // Known Deft tool path under validated account home — never blanket HOME.
  if (owner.account) {
    const passwd = options.readPasswd
      ? options.readPasswd()
      : readTextOrNull("/etc/passwd", options.readFile);
    if (passwd) {
      const entry = lookupPasswdByName(passwd, owner.account);
      if (entry) {
        // Resolve home from passwd only (validated account).
        for (const raw of passwd.split("\n")) {
          const parts = raw.trim().split(":");
          if ((parts[0] ?? "") !== owner.account) continue;
          const home = parts[5] ?? "";
          if (!home || home === "/root") break;
          const toolPath = join(home, ".local", "bin", "task");
          if (exists(toolPath)) {
            const st = statOwnership(toolPath);
            if (st && st.uid === 0) {
              visit(toolPath, dirname(toolPath));
            }
          }
          break;
        }
      }
    }
  }

  if (skippedProtected.length > 0) {
    messages.push(
      `Protected/uncertain leftovers (unchanged): ${skippedProtected.slice(0, 20).join(", ")}` +
        (skippedProtected.length > 20 ? ` (+${skippedProtected.length - 20} more)` : ""),
    );
  }
  const ok = failed.length === 0;
  messages.unshift(
    `ownership:fix target ${owner.uid}:${owner.gid}` +
      `${owner.account ? ` (${owner.account})` : ""}` +
      `; repaired=${repaired.length} failed=${failed.length} protected=${skippedProtected.length}`,
  );
  return { ok, exitCode: ok ? 0 : 1, repaired, skippedProtected, failed, messages };
}
