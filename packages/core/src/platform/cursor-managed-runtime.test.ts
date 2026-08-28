/**
 * Runtime classification contract for #3859.
 *
 * Both live classifiers are covered because both are consumed and they used to
 * order their hops differently. The assertions that matter are the precedence
 * ones: a positive managed-runtime read must outrank every other Cursor signal
 * and the explicit selection, CI markers must keep their precedence, and probe
 * absence must never reach a local classification on its own.
 *
 * The platform is deliberately NOT an input. An earlier revision of this issue
 * proposed `process.platform === "win32"` as a discriminator; it was withdrawn
 * because Cursor runs Windows "My Machines" workers and because "managed VMs
 * are Ubuntu" is a versioned fact about a third party's fleet.
 */

import { type ChildProcess, spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { probeRuntimeCapabilities as probeIntakeRuntime } from "../intake/platform-capabilities.js";
import {
  bodyReportsManagedRuntime,
  GITHUB_AUTH_MODE_ENV,
  MANAGED_RUNTIME_PATH,
  MANAGED_RUNTIME_SOCKET_ENV,
  type ManagedRuntimeProbe,
  parseProbeResponse,
  probeManagedRuntime,
  resetManagedRuntimeProbeCache,
} from "./cursor-managed-runtime.js";
import { classifyRuntime } from "./platform-capabilities.js";

const unavailableProbe: ManagedRuntimeProbe = () => ({
  verdict: "unavailable",
  socketPath: null,
  detail: "test: socket absent",
});
const notManagedProbe: ManagedRuntimeProbe = () => ({
  verdict: "not-managed",
  socketPath: "/tmp/s.sock",
  detail: "test: self-hosted worker",
});
const managedProbe: ManagedRuntimeProbe = () => ({
  verdict: "managed",
  socketPath: "/tmp/s.sock",
  detail: "test: managed",
});

/** Classify through both live classifiers; they must agree on the verdict. */
function bothClassifiers(
  environ: Record<string, string>,
  probe: ManagedRuntimeProbe,
): { mode: string; reason: string } {
  const intake = probeIntakeRuntime(environ, { managedRuntimeProbe: probe });
  const platform = classifyRuntime(environ, false, { managedRuntimeProbe: probe });
  expect(intake.runtimeMode).toBe(platform.mode);
  expect(intake.runtimeModeReason).toBe(platform.reason);
  return platform;
}

describe("bodyReportsManagedRuntime (#3859)", () => {
  it("accepts the documented managed values across plausible body shapes", () => {
    expect(bodyReportsManagedRuntime("managed")).toBe(true);
    expect(bodyReportsManagedRuntime(" MANAGED \n")).toBe(true);
    expect(bodyReportsManagedRuntime('"managed"')).toBe(true);
    expect(bodyReportsManagedRuntime('{"runtime":"managed"}')).toBe(true);
    expect(bodyReportsManagedRuntime('{"agentRuntime":"managed"}')).toBe(true);
    expect(bodyReportsManagedRuntime('{"agent_runtime":"managed"}')).toBe(true);
  });

  it("rejects anything that does not assert managed", () => {
    for (const body of [
      "",
      "   ",
      "self-hosted",
      '{"runtime":"machine"}',
      '{"runtime":null}',
      '{"other":"managed"}',
      "not json {",
      "42",
    ]) {
      expect(bodyReportsManagedRuntime(body)).toBe(false);
    }
  });
});

/**
 * Serve one metadata body on a platform-appropriate local socket.
 *
 * The server MUST live in its own process: the probe uses `spawnSync`, which
 * blocks this process's event loop, so an in-process server could never accept
 * the connection.
 */
const SERVER_SCRIPT = `
const http = require("node:http");
const server = http.createServer((req, res) => {
  if (req.url === process.env.SRV_ROUTE) {
    res.writeHead(Number(process.env.SRV_STATUS), { "content-type": "application/json" });
    res.end(process.env.SRV_BODY);
    return;
  }
  res.writeHead(404);
  res.end("");
});
server.listen(process.env.SRV_SOCK, () => { process.stdout.write("ready\\n"); });
`;

/** A socket path nothing is listening on yet. */
function reserveSocketPath(): string {
  const unique = `deft-3859-${process.pid}-${Math.random().toString(36).slice(2)}`;
  return process.platform === "win32" ? `\\\\.\\pipe\\${unique}` : join(tmpdir(), `${unique}.sock`);
}

/** Start serving `body` on `socketPath` and resolve once it accepts. */
async function startMetadataServer(
  socketPath: string,
  body: string,
  status: number,
): Promise<ChildProcess> {
  const child = spawn(process.execPath, ["-e", SERVER_SCRIPT], {
    env: {
      ...process.env,
      SRV_SOCK: socketPath,
      SRV_ROUTE: MANAGED_RUNTIME_PATH,
      SRV_BODY: body,
      SRV_STATUS: String(status),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("metadata server did not start")), 10_000);
      child.stdout?.setEncoding("utf8");
      child.stdout?.on("data", (chunk: string) => {
        if (chunk.includes("ready")) {
          clearTimeout(timer);
          resolve();
        }
      });
      child.once("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });
      child.once("exit", (code) => {
        clearTimeout(timer);
        reject(new Error(`metadata server exited early (${code})`));
      });
    });
  } catch (err) {
    child.kill();
    throw err;
  }
  return child;
}

async function withMetadataServer(
  body: string,
  status: number,
  run: (socketPath: string) => void,
): Promise<void> {
  const socketPath = reserveSocketPath();
  const child = await startMetadataServer(socketPath, body, status);
  try {
    resetManagedRuntimeProbeCache();
    run(socketPath);
  } finally {
    child.kill();
    resetManagedRuntimeProbeCache();
  }
}

describe("probeManagedRuntime default (#3859)", () => {
  it("reports unavailable without spawning when the socket env is unset", () => {
    const result = probeManagedRuntime({});
    expect(result.verdict).toBe("unavailable");
    expect(result.socketPath).toBeNull();
    expect(result.detail).toContain(MANAGED_RUNTIME_SOCKET_ENV);
  });

  it("reports unavailable, never managed, for an unreachable socket path", () => {
    resetManagedRuntimeProbeCache();
    const result = probeManagedRuntime({
      [MANAGED_RUNTIME_SOCKET_ENV]: "/nonexistent/deft-3859-probe.sock",
    });
    expect(result.verdict).toBe("unavailable");
    expect(result.verdict).not.toBe("managed");
    resetManagedRuntimeProbeCache();
  });

  it("reads managed from a live metadata socket", async () => {
    await withMetadataServer(JSON.stringify({ runtime: "managed" }), 200, (socketPath) => {
      const result = probeManagedRuntime({ [MANAGED_RUNTIME_SOCKET_ENV]: socketPath });
      expect(result.verdict).toBe("managed");
      expect(result.socketPath).toBe(socketPath);
    });
  });

  it("reads not-managed from a live socket that does not assert managed", async () => {
    await withMetadataServer(JSON.stringify({ runtime: "machine" }), 200, (socketPath) => {
      const result = probeManagedRuntime({ [MANAGED_RUNTIME_SOCKET_ENV]: socketPath });
      expect(result.verdict).toBe("not-managed");
    });
  });

  it("treats a non-200 metadata response as unavailable, not managed", async () => {
    await withMetadataServer("managed", 500, (socketPath) => {
      const result = probeManagedRuntime({ [MANAGED_RUNTIME_SOCKET_ENV]: socketPath });
      expect(result.verdict).toBe("unavailable");
      expect(result.detail).toContain("500");
    });
  });

  it("memoizes a positive managed read so repeat classification does not respawn", async () => {
    await withMetadataServer(JSON.stringify({ runtime: "managed" }), 200, (socketPath) => {
      const environ = { [MANAGED_RUNTIME_SOCKET_ENV]: socketPath };
      const first = probeManagedRuntime(environ);
      const second = probeManagedRuntime(environ);
      expect(first.verdict).toBe("managed");
      // Identity, not equality: a second read would build a fresh object.
      expect(second).toBe(first);
    });
  });
});

describe("parseProbeResponse (#3859)", () => {
  it("returns null for anything that is not a response object", () => {
    // "null" is the case a bare try/catch misses: JSON.parse accepts it, and
    // reading a field off the result would throw out of a probe documented to
    // never throw.
    for (const stdout of ["null", "42", '"managed"', "[]", "[1,2]", "not json {", ""]) {
      expect(parseProbeResponse(stdout)).toBeNull();
    }
  });

  it("returns the response object when the reader reported one", () => {
    expect(parseProbeResponse(JSON.stringify({ status: 200, body: "managed" }))).toEqual({
      status: 200,
      body: "managed",
    });
    expect(parseProbeResponse(JSON.stringify({ error: "ENOENT" }))).toEqual({ error: "ENOENT" });
  });
});

/**
 * The inconclusive-cache recovery case.
 *
 * A managed VM whose first probe loses the metadata-socket startup race reads
 * `unavailable`. If that verdict were memoized it would stand for the life of
 * the process, so a later healthy endpoint reporting `managed` would never be
 * seen -- and the explicit host-gh opt-in, which only ever resolves an
 * *ambiguous* runtime, would go on authorizing host credentials on a VM the
 * probe was supposed to deny. That is the fail-open direction, so the deny has
 * to survive a transient miss.
 */
describe("recovery after an inconclusive probe (#3859)", () => {
  it("re-probes an unavailable read and denies once the socket reports managed", async () => {
    const socketPath = reserveSocketPath();
    const environ = {
      CURSOR_AGENT: "1",
      [GITHUB_AUTH_MODE_ENV]: "host-gh",
      [MANAGED_RUNTIME_SOCKET_ENV]: socketPath,
    };
    resetManagedRuntimeProbeCache();
    try {
      // Nothing is listening yet. The runtime is ambiguous, and the opt-in an
      // operator set on a machine they believed was theirs resolves it local.
      expect(probeManagedRuntime(environ).verdict).toBe("unavailable");
      const before = bothClassifiers(environ, probeManagedRuntime);
      expect(before.mode).toBe("local-unsandboxed");
      expect(before.reason).toBe("explicit-host-gh-selection");

      const child = await startMetadataServer(
        socketPath,
        JSON.stringify({ runtime: "managed" }),
        200,
      );
      try {
        // Same process, same socket path, endpoint now healthy.
        expect(probeManagedRuntime(environ).verdict).toBe("managed");
        const after = bothClassifiers(environ, probeManagedRuntime);
        expect(after.mode).toBe("cloud-headless");
        expect(after.reason).toBe("cursor-managed-runtime-probe");
      } finally {
        child.kill();
      }
    } finally {
      resetManagedRuntimeProbeCache();
    }
  });

  it("does not memoize an unavailable read", () => {
    resetManagedRuntimeProbeCache();
    try {
      const environ = { [MANAGED_RUNTIME_SOCKET_ENV]: reserveSocketPath() };
      const first = probeManagedRuntime(environ);
      const second = probeManagedRuntime(environ);
      expect(first.verdict).toBe("unavailable");
      expect(second.verdict).toBe("unavailable");
      // Identity: a memoized verdict hands back the same object, which is what
      // would freeze this socket at "not managed" for the whole process.
      expect(second).not.toBe(first);
    } finally {
      resetManagedRuntimeProbeCache();
    }
  });

  it("does not memoize a not-managed read", async () => {
    await withMetadataServer(JSON.stringify({ runtime: "machine" }), 200, (socketPath) => {
      const environ = { [MANAGED_RUNTIME_SOCKET_ENV]: socketPath };
      const first = probeManagedRuntime(environ);
      const second = probeManagedRuntime(environ);
      expect(first.verdict).toBe("not-managed");
      expect(second.verdict).toBe("not-managed");
      // Only a positive managed read earns a memo. A 200 that does not assert
      // managed is still a read of an endpoint whose shape is documented only
      // loosely, so it does not get to stand in for one.
      expect(second).not.toBe(first);
    });
  });
});

describe("runtime classification precedence (#3859)", () => {
  it("denies host credentials on a positive managed read", () => {
    const result = bothClassifiers({ CURSOR_AGENT: "1" }, managedProbe);
    expect(result.mode).toBe("cloud-headless");
    expect(result.reason).toBe("cursor-managed-runtime-probe");
  });

  it("lets a managed read outrank an explicit host-gh selection", () => {
    const result = bothClassifiers(
      { CURSOR_AGENT: "1", [GITHUB_AUTH_MODE_ENV]: "host-gh" },
      managedProbe,
    );
    expect(result.mode).toBe("cloud-headless");
    expect(result.reason).toBe("cursor-managed-runtime-probe");
  });

  it("lets a managed read outrank the Cursor sandbox hop", () => {
    // The sandbox hop resolves to cursor-native-sandbox, which infers host-gh.
    // A managed VM must not reach it.
    const result = bothClassifiers({ CURSOR_AGENT: "1", CURSOR_SANDBOX: "1" }, managedProbe);
    expect(result.mode).toBe("cloud-headless");
  });

  it("leaves the runtime ambiguous, not local, when the probe is unavailable", () => {
    for (const probe of [unavailableProbe, notManagedProbe]) {
      const result = bothClassifiers({ CURSOR_AGENT: "1" }, probe);
      expect(result.mode).toBe("cloud-headless");
      expect(result.reason).toBe("cursor-marker-runtime-ambiguous");
    }
  });

  it("resolves an ambiguous runtime to local only on explicit selection", () => {
    const result = bothClassifiers(
      { CURSOR_AGENT: "1", [GITHUB_AUTH_MODE_ENV]: "host-gh" },
      unavailableProbe,
    );
    expect(result.mode).toBe("local-unsandboxed");
    expect(result.reason).toBe("explicit-host-gh-selection");
  });

  it("keeps CI precedence over both the Cursor hop and the explicit selection", () => {
    for (const marker of ["GITHUB_ACTIONS", "BUILDKITE", "CI"]) {
      const result = bothClassifiers(
        { CURSOR_AGENT: "1", [marker]: "true", [GITHUB_AUTH_MODE_ENV]: "host-gh" },
        unavailableProbe,
      );
      expect(result.mode).toBe("cloud-headless");
      expect(result.reason).toBe("ci-marker");
    }
  });

  it("keeps an unmarked runtime local, as before", () => {
    const result = bothClassifiers({}, unavailableProbe);
    expect(result.mode).toBe("local-unsandboxed");
    expect(result.reason).toBe("no-runtime-marker");
  });

  it("does not consult the host platform", () => {
    // Same environment on any host must classify identically: the classifiers
    // take no platform input, so a Windows My Machines worker and a Linux
    // desktop are treated the same way.
    const ambiguous = { CURSOR_AGENT: "1" };
    expect(bothClassifiers(ambiguous, unavailableProbe).mode).toBe("cloud-headless");
    expect(
      probeIntakeRuntime(ambiguous, { managedRuntimeProbe: unavailableProbe }).runtimeMode,
    ).toBe("cloud-headless");
  });
});
