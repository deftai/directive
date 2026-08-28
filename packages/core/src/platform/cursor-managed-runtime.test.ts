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

import { spawn } from "node:child_process";
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

async function withMetadataServer(
  body: string,
  status: number,
  run: (socketPath: string) => void,
): Promise<void> {
  const unique = `deft-3859-${process.pid}-${Math.random().toString(36).slice(2)}`;
  const socketPath =
    process.platform === "win32" ? `\\\\.\\pipe\\${unique}` : join(tmpdir(), `${unique}.sock`);
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

  it("memoizes per socket path so repeat classification does not respawn", async () => {
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
