/**
 * Cursor managed-runtime probe and explicit host-gh selection (#3859).
 *
 * `CURSOR_AGENT` is set by local desktop Cursor, by Cursor-managed cloud VMs,
 * and by Windows "My Machines" workers alike, so it cannot decide the runtime on
 * its own. Two routes were considered and rejected:
 *
 *   - Dropping the `CURSOR_AGENT` hop grants host credentials on a managed VM
 *     by marker *absence*.
 *   - `process.platform === "win32"` is not an invariant. Cursor runs Windows
 *     My Machines workers under a cloud agent loop, and "managed VMs are Ubuntu"
 *     is a versioned fact about a third party's fleet, not a runtime property.
 *
 * What remains is a genuine asymmetry:
 *
 *   - Cursor-managed VMs serve a local metadata API on `CURSOR_AGENT_SOCKET`
 *     whose `agent/runtime` is always `managed`. A successful read is a
 *     *positive* assertion of managed cloud, so it is a sound deny signal.
 *   - There is no positive local-desktop signal. Absence of the socket means
 *     "not managed, or unreachable" and MUST NOT select host credentials --
 *     that is the marker-absence grant this module exists to prevent. Absence
 *     leaves the runtime ambiguous, and an ambiguous runtime requires an
 *     explicit operator or dispatcher selection.
 *
 * Both probe error directions are safe. A false `managed` denies host
 * credentials (fail closed). A failed read leaves the runtime ambiguous, which
 * preserves today's behaviour unless an operator opted in.
 */

import { spawnSync } from "node:child_process";

/**
 * The `host-gh` auth-mode label. Duplicated from intake/github-auth-modes.ts
 * rather than imported: that module imports the runtime classifier, which
 * imports this one.
 */
const HOST_GH_SELECTION = "host-gh";

/** Env var carrying the Cursor managed-runtime metadata socket path. */
export const MANAGED_RUNTIME_SOCKET_ENV = "CURSOR_AGENT_SOCKET";

/** Metadata API route reporting the runtime kind. */
export const MANAGED_RUNTIME_PATH = "/agent/runtime";

/** The only `agent/runtime` value Cursor-managed VMs report. */
export const MANAGED_RUNTIME_VALUE = "managed";

/**
 * Env var an operator or dispatcher sets to resolve an ambiguous Cursor
 * runtime. Named for the `github_auth_mode` dispatch-envelope field so a
 * dispatcher exports the same label it already records.
 */
export const GITHUB_AUTH_MODE_ENV = "DEFT_GITHUB_AUTH_MODE";

/** Stable reason ids naming why a runtime mode was chosen (#3859). */
export const RUNTIME_REASON_CI_MARKER = "ci-marker";
export const RUNTIME_REASON_MANAGED_RUNTIME_PROBE = "cursor-managed-runtime-probe";
export const RUNTIME_REASON_CURSOR_SANDBOX_MARKER = "cursor-sandbox-marker";
export const RUNTIME_REASON_CURSOR_MARKER_AMBIGUOUS = "cursor-marker-runtime-ambiguous";
export const RUNTIME_REASON_EXPLICIT_HOST_GH = "explicit-host-gh-selection";
export const RUNTIME_REASON_NO_RUNTIME_MARKER = "no-runtime-marker";

export type ManagedRuntimeVerdict = "managed" | "not-managed" | "unavailable";

export interface ManagedRuntimeProbeResult {
  /** `managed` is the only verdict that may deny host credentials. */
  readonly verdict: ManagedRuntimeVerdict;
  readonly socketPath: string | null;
  /** Short non-secret diagnostic for operator-visible output. */
  readonly detail: string;
}

export type ManagedRuntimeProbe = (
  environ: Readonly<Record<string, string | undefined>>,
) => ManagedRuntimeProbeResult;

/**
 * Read the metadata API in a child process.
 *
 * The readiness and classification paths are synchronous throughout, and Node
 * cannot read an HTTP-over-unix-socket response synchronously in-process. This
 * runs only when `CURSOR_AGENT_SOCKET` is set, so the common local case pays
 * nothing.
 */
const READER_SCRIPT = `
const http = require("node:http");
const done = (payload) => { process.stdout.write(JSON.stringify(payload)); };
const req = http.request(
  {
    socketPath: process.env.DEFT_PROBE_SOCKET,
    path: process.env.DEFT_PROBE_PATH,
    method: "GET",
    timeout: 2000,
  },
  (res) => {
    let body = "";
    res.setEncoding("utf8");
    res.on("data", (chunk) => { body += chunk; if (body.length > 4096) req.destroy(); });
    res.on("end", () => done({ status: res.statusCode, body }));
  },
);
req.on("timeout", () => { req.destroy(new Error("timeout")); });
req.on("error", (err) => done({ error: String((err && err.message) || err) }));
req.end();
`;

function unavailable(socketPath: string | null, detail: string): ManagedRuntimeProbeResult {
  return { verdict: "unavailable", socketPath, detail };
}

/**
 * True when a metadata body reports the managed runtime.
 *
 * Accepts a JSON object carrying a `runtime` (or `agentRuntime` / `agent_runtime`)
 * field and a bare string body, because the exact response shape is documented
 * only as "`agent/runtime` is always `managed`". Over-matching here denies host
 * credentials, which is the safe direction.
 */
export function bodyReportsManagedRuntime(body: string): boolean {
  const text = body.trim();
  if (text.length === 0) return false;
  if (text.toLowerCase() === MANAGED_RUNTIME_VALUE) return true;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return false;
  }
  if (typeof parsed === "string") return parsed.trim().toLowerCase() === MANAGED_RUNTIME_VALUE;
  if (typeof parsed !== "object" || parsed === null) return false;
  const record = parsed as Record<string, unknown>;
  for (const key of ["runtime", "agentRuntime", "agent_runtime"]) {
    const value = record[key];
    if (typeof value === "string" && value.trim().toLowerCase() === MANAGED_RUNTIME_VALUE) {
      return true;
    }
  }
  return false;
}

/**
 * Per-process memo keyed by socket path. The runtime kind cannot change within
 * a process, and classification runs from several verbs, so this holds the child
 * spawn to one per socket even on a managed VM.
 */
const probeCache = new Map<string, ManagedRuntimeProbeResult>();

/** Clear the probe memo. Test seam only. */
export function resetManagedRuntimeProbeCache(): void {
  probeCache.clear();
}

/** Default managed-runtime probe. Never throws. */
export const probeManagedRuntime: ManagedRuntimeProbe = (environ) => {
  const socketPath = (environ[MANAGED_RUNTIME_SOCKET_ENV] ?? "").trim();
  if (socketPath.length === 0) {
    return unavailable(null, `${MANAGED_RUNTIME_SOCKET_ENV} is not set; runtime not asserted`);
  }
  const cached = probeCache.get(socketPath);
  if (cached !== undefined) return cached;
  const result = readManagedRuntime(socketPath);
  probeCache.set(socketPath, result);
  return result;
};

function readManagedRuntime(socketPath: string): ManagedRuntimeProbeResult {
  let result: ReturnType<typeof spawnSync>;
  try {
    result = spawnSync(process.execPath, ["-e", READER_SCRIPT], {
      env: {
        ...process.env,
        DEFT_PROBE_SOCKET: socketPath,
        DEFT_PROBE_PATH: MANAGED_RUNTIME_PATH,
      },
      encoding: "utf8",
      timeout: 3000,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return unavailable(socketPath, `metadata probe failed to start: ${message}`);
  }
  const stdout = typeof result.stdout === "string" ? result.stdout : "";
  if (stdout.trim().length === 0) {
    return unavailable(socketPath, `${MANAGED_RUNTIME_PATH} returned no response`);
  }
  let payload: { status?: number; body?: string; error?: string };
  try {
    payload = JSON.parse(stdout) as typeof payload;
  } catch {
    return unavailable(socketPath, `${MANAGED_RUNTIME_PATH} response was unparseable`);
  }
  if (typeof payload.error === "string") {
    return unavailable(socketPath, `${MANAGED_RUNTIME_PATH} unreachable: ${payload.error}`);
  }
  if (payload.status !== 200) {
    return unavailable(socketPath, `${MANAGED_RUNTIME_PATH} returned status ${payload.status}`);
  }
  if (bodyReportsManagedRuntime(payload.body ?? "")) {
    return {
      verdict: "managed",
      socketPath,
      detail: `${MANAGED_RUNTIME_PATH} reported ${MANAGED_RUNTIME_VALUE}`,
    };
  }
  return {
    verdict: "not-managed",
    socketPath,
    detail: `${MANAGED_RUNTIME_PATH} did not report ${MANAGED_RUNTIME_VALUE}`,
  };
}

/**
 * True when an operator or dispatcher explicitly selected host-gh for this
 * execution environment. This resolves an *ambiguous* runtime only; it can
 * never override a positive managed-runtime read.
 */
export function hasExplicitHostGhSelection(
  environ: Readonly<Record<string, string | undefined>>,
): boolean {
  return (environ[GITHUB_AUTH_MODE_ENV] ?? "").trim().toLowerCase() === HOST_GH_SELECTION;
}

/** Remediation naming the opt-in, for operator-visible not-ready output. */
export const EXPLICIT_SELECTION_REMEDIATION =
  `Remediation for an ambiguous Cursor runtime (#3859):\n` +
  `  - CURSOR_AGENT is set but the ${MANAGED_RUNTIME_SOCKET_ENV} metadata API did not report\n` +
  `    "${MANAGED_RUNTIME_VALUE}", so this runtime could be local desktop, a self-hosted\n` +
  `    worker, or an unreachable managed VM. Deft will not guess from the OS.\n` +
  `  - On a machine you control, where the host gh credential store is the right\n` +
  `    credential, opt in explicitly: set ${GITHUB_AUTH_MODE_ENV}=${HOST_GH_SELECTION}\n` +
  `  - Dispatchers should export the same github_auth_mode label they record in the\n` +
  `    dispatch envelope\n` +
  `  - A positive managed-runtime read always wins; this opt-in cannot override it`;
