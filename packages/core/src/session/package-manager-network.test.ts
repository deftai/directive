import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProbeScmReadinessOptions, ScmReadinessReport } from "../scm/readiness.js";
import type { SessionStartOptions } from "./session-start.js";

/**
 * #2182: fixture repo with a private-scope registry configuration. Read-only
 * / session / ritual flows MUST perform NO npm/pnpm registry access, even
 * when the target repo has a private scope pointed at an internal registry
 * (the exact shape the issue is concerned about: package scopes and registry
 * traffic can be sensitive in an arbitrary consumer repo).
 *
 * The package-manager seam is stubbed at `node:child_process` spawnSync, the
 * lowest level the asserted argv is built at. `--with-network` session start
 * reaches it through `probeSessionReleaseAvailability` ->
 * `release-availability.ts` `defaultNpmView` (`timeout: 5_000`); doctor's
 * offline `npm config get` reads and `verify-tools.ts` tool probing bottom out
 * on the same call. `doctor/payload-staleness.ts` is a separate seam with a
 * different timeout and is not exercised here.
 *
 * #3901: the seam is a stub, not a pass-through spy. `vi.fn(actual.spawnSync)`
 * recorded AND executed, so this suite made a live registry request whose
 * response it never inspected. npm and pnpm now return a deterministic process
 * result; every other command still executes, because the git fixture needs
 * it. The SCM probe is injected for the same reason -- the shallow path spawns
 * `gh auth status` on a 15s timeout and `allowOptionalNetwork` selects the deep
 * path, which spawns live `gh` on a 30s timeout.
 *
 * The no-network claim is enforced rather than asserted by inspection. Both
 * `spawnSync` and `execFileSync` are wrapped, and `afterEach` fails closed on
 * any execution that could leave the machine: a network-capable binary, or a
 * `git` invocation naming a remote-contacting subcommand. Local git is exempt
 * because it is the fixture's own cost, not an outbound request. A case that
 * needs real network has to be marked and excluded from gate runs before it
 * lands here.
 */

const spawnHarness = vi.hoisted(() => {
  /** Binaries whose execution leaves the machine outright. */
  const OUTBOUND_COMMANDS = new Set(["npm", "pnpm", "gh", "ghx", "curl", "wget"]);
  /** git subcommands that contact a remote; every other git call is local. */
  const REMOTE_GIT_SUBCOMMANDS = new Set(["fetch", "pull", "push", "clone", "ls-remote"]);
  /** Matches the fixture's installed tag, so the release advisory stays quiet. */
  const PUBLISHED_VERSION = "0.1.0";
  /** Every invocation passed through to the real child_process, in order. */
  const executed: { command: string; args: readonly unknown[] }[] = [];

  function commandName(command: unknown): string {
    const raw = String(command ?? "");
    const leaf = raw.split(/[\\/]/u).pop() ?? raw;
    return leaf.toLowerCase().replace(/\.(?:exe|cmd|bat|ps1)$/u, "");
  }

  function isOutbound(command: string, args: readonly unknown[]): boolean {
    if (OUTBOUND_COMMANDS.has(command)) return true;
    if (command !== "git") return false;
    const sub = String(args[0] ?? "");
    return (
      REMOTE_GIT_SUBCOMMANDS.has(sub) || (sub === "remote" && String(args[1] ?? "") === "update")
    );
  }

  function packageManagerStdout(args: readonly unknown[]): string {
    if (args[0] === "view") return `${PUBLISHED_VERSION}\n`;
    if (args[0] === "config" && args[1] === "get") {
      return args[2] === "@deftai:registry" ? "undefined\n" : "https://registry.npmjs.org/\n";
    }
    return "";
  }

  function packageManagerResult(args: readonly unknown[]): {
    status: number;
    stdout: string;
    stderr: string;
    pid: number;
    output: (string | null)[];
    signal: null;
    error: undefined;
  } {
    const stdout = packageManagerStdout(args);
    return {
      status: 0,
      stdout,
      stderr: "",
      pid: 1,
      output: [null, stdout, ""],
      signal: null,
      error: undefined,
    };
  }

  return { executed, commandName, isOutbound, packageManagerResult };
});

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  const realSpawnSync = actual.spawnSync as unknown as (...args: unknown[]) => unknown;
  const realExecFileSync = actual.execFileSync as unknown as (...args: unknown[]) => unknown;

  function record(command: unknown, rest: unknown[]): void {
    spawnHarness.executed.push({
      command: spawnHarness.commandName(command),
      args: Array.isArray(rest[0]) ? (rest[0] as unknown[]) : [],
    });
  }

  const spawnSyncStub = vi.fn((command: unknown, ...rest: unknown[]) => {
    const name = spawnHarness.commandName(command);
    if (name === "npm" || name === "pnpm") {
      return spawnHarness.packageManagerResult(Array.isArray(rest[0]) ? rest[0] : []);
    }
    record(command, rest);
    return realSpawnSync(command, ...rest);
  });

  // execFileSync is passed through, never stubbed: the git fixture depends on
  // it. It is recorded so the afterEach guard can see a package manager or a
  // remote git call that arrives on this seam instead of spawnSync.
  const execFileSyncStub = vi.fn((command: unknown, ...rest: unknown[]) => {
    record(command, rest);
    return realExecFileSync(command, ...rest);
  });

  return {
    ...actual,
    spawnSync: spawnSyncStub as unknown as typeof actual.spawnSync,
    execFileSync: execFileSyncStub as unknown as typeof actual.execFileSync,
  };
});

import { spawnSync } from "node:child_process";
import { defaultRitualRunner } from "./ritual-entrypoint.js";
import { runSessionStart } from "./session-start.js";
import { GATED_ENTRYPOINT_COMMANDS } from "./verify-session-ritual.js";

function packageManagerCalls(mock: ReturnType<typeof vi.mocked<typeof spawnSync>>): unknown[][] {
  return mock.mock.calls.filter((call) => {
    const command = spawnHarness.commandName(call[0]);
    return command === "npm" || command === "pnpm";
  });
}

/** Executions that reached the OS and could have left the machine, as `cmd sub`. */
function outboundExecutions(): string[] {
  return spawnHarness.executed
    .filter((call) => spawnHarness.isOutbound(call.command, call.args))
    .map((call) => `${call.command} ${String(call.args[0] ?? "")}`.trim());
}

const PUBLIC_REGISTRY_VIEW_ARGS = [
  "view",
  "@deftai/directive",
  "version",
  "--registry=https://registry.npmjs.org/",
  "--ignore-scripts",
];

const PRIVATE_SCOPE_VIEW_ARGS = [
  "view",
  "@my-private-scope/anything",
  "version",
  "--registry=https://npm.internal.example.com/",
  "--ignore-scripts",
];

/**
 * The #2182 boundary in one predicate: exactly one npm/pnpm call, and it is the
 * disclosed public-registry probe with the argv `defaultNpmView` builds. Shared
 * with the two mutation checks so non-vacuity is proved against the same
 * predicate the target case asserts.
 */
function expectOnlyDisclosedPublicRegistryProbe(calls: unknown[][]): void {
  expect(calls).toEqual([
    [
      "npm",
      PUBLIC_REGISTRY_VIEW_ARGS,
      expect.objectContaining({ encoding: "utf8", timeout: 5_000 }),
    ],
  ]);
}

/** SCM readiness without a `gh` subprocess; records the depth it was asked for. */
function hermeticScmProbe(
  observedDepths: string[],
): (options: ProbeScmReadinessOptions) => ScmReadinessReport {
  return (options) => {
    const depth = options.depth ?? "shallow";
    observedDepths.push(depth);
    return {
      ready: true,
      binary: "gh",
      binaryPath: "/usr/bin/gh",
      authState: "authenticated",
      githubAuthMode: "host-gh",
      runtimeMode: "local-unsandboxed",
      runtimeModeReason: null,
      injectedTokenPresent: false,
      depth,
      detail: "SCM ready (injected; #3901 keeps gh off the wire)",
      remediation: null,
      skippedGates: [],
      login: null,
      failureKind: null,
    };
  };
}

/** Session options with every optional seam held off the wire (#3286 / #3901). */
function hermeticSessionOptions(observedDepths: string[] = []): SessionStartOptions {
  return {
    writeHistory: false,
    runStalenessTickler: () => ({ lines: [], prompted: false }),
    // Keep triage on a no-op so the assertion is about the release probe only.
    runTriageWelcome: () => ({ exitCode: 0 }),
    // #3286: stub orientation so composed doctor does not probe npm config.
    orientationOptions: {
      doctorSection: {
        name: "doctor",
        status: "ok",
        ok: true,
        exitCode: 0,
        lines: ["[deft doctor] status: ok"],
        shaMatch: false,
        durationMs: 0,
      },
      agentsRefreshSection: {
        name: "agents_refresh",
        status: "ok",
        ok: true,
        exitCode: 0,
        lines: ["agents:refresh stub"],
        shaMatch: false,
        durationMs: 0,
      },
      cacheFreshSection: {
        name: "cache_fresh",
        status: "ok",
        ok: true,
        exitCode: 0,
        lines: ["cache-fresh stub"],
        shaMatch: false,
        durationMs: 0,
      },
      toolchainPreflight: {
        status: "ok",
        ok: true,
        degraded: false,
        findings: [],
        lines: ["[deft preflight] toolchain status: ok"],
        skipGateIds: [],
      },
    },
    probeScm: hermeticScmProbe(observedDepths),
  };
}

/** The #3901 target shape: optional network on, full ceremony, no live subprocess. */
function withNetworkOptions(observedDepths: string[] = []): SessionStartOptions {
  return {
    ...hermeticSessionOptions(observedDepths),
    allowOptionalNetwork: true,
    // #3214: force full ceremony so optional release probe runs (cold default is rapid).
    ceremonyDialInputs: {
      taskSize: "M",
      modelTier: "mid",
      projectShape: "project",
    },
  };
}

function initPrivateScopeRepo(): { root: string; head: string } {
  const root = mkdtempSync(join(tmpdir(), "deft-pkgnet-"));
  // Private-scope registry fixture (#2182 acceptance criteria): a private
  // npm scope routed at an internal, authenticated registry. Its mere
  // presence on disk must not be enough to make any read-only flow contact
  // it (or the public npm registry) as a side effect.
  writeFileSync(
    join(root, ".npmrc"),
    "@my-private-scope:registry=https://npm.internal.example.com/\n" +
      "//npm.internal.example.com/:_authToken=should-never-be-read\n",
    "utf8",
  );
  mkdirSync(join(root, ".deft", "core"), { recursive: true });
  writeFileSync(
    join(root, ".deft", "core", "VERSION"),
    `sha: ${"f".repeat(40)}\nref: v0.1.0\ntag: v0.1.0\n`,
    "utf8",
  );
  writeFileSync(
    join(root, "AGENTS.md"),
    "<!-- deft:managed-section v3 -->\n<!-- /deft:managed-section -->\n",
    "utf8",
  );
  mkdirSync(join(root, "xbrief"), { recursive: true });
  writeFileSync(
    join(root, "xbrief", "PROJECT-DEFINITION.xbrief.json"),
    JSON.stringify({
      xBRIEFInfo: { version: "0.8" },
      plan: { title: "T", status: "running", items: [], policy: {} },
    }),
    "utf8",
  );
  execFileSync("git", ["init", "-q"], { cwd: root, encoding: "utf8" });
  execFileSync("git", ["config", "user.email", "t@t.local"], { cwd: root, encoding: "utf8" });
  execFileSync("git", ["config", "user.name", "T"], { cwd: root, encoding: "utf8" });
  execFileSync("git", ["add", "-A"], { cwd: root, encoding: "utf8" });
  execFileSync("git", ["commit", "-q", "-m", "init"], {
    cwd: root,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "T",
      GIT_AUTHOR_EMAIL: "t@t.local",
      GIT_COMMITTER_NAME: "T",
      GIT_COMMITTER_EMAIL: "t@t.local",
    },
  });
  const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
  return { root, head };
}

describe("package-manager network scope (#2182)", () => {
  const temps: string[] = [];
  const spawnSyncMock = vi.mocked(spawnSync);

  beforeEach(() => {
    spawnSyncMock.mockClear();
    spawnHarness.executed.length = 0;
  });

  afterEach(() => {
    for (const t of temps) rmSync(t, { recursive: true, force: true });
    temps.length = 0;
    // #3901: no case in this file may execute an outbound command. A case that
    // needs one must be marked and excluded from gate runs before it lands.
    expect(outboundExecutions()).toEqual([]);
  });

  it("session:start (read-only) invokes no npm/pnpm even with a private-scope registry present", () => {
    const { root } = initPrivateScopeRepo();
    temps.push(root);

    const result = runSessionStart(root, {
      writeHistory: false,
      posture: "read-only",
      probeScm: hermeticScmProbe([]),
    });

    expect(result.code).toBe(0);
    expect(packageManagerCalls(spawnSyncMock)).toEqual([]);
  });

  it("session:start default hot path invokes no npm/pnpm (#2991)", () => {
    const { root } = initPrivateScopeRepo();
    temps.push(root);

    const result = runSessionStart(root, hermeticSessionOptions());

    expect(result.code === 0 || result.code === 1).toBe(true);
    expect(packageManagerCalls(spawnSyncMock)).toEqual([]);
    expect(result.payload.optional_network).toBe(false);
  });

  it("session:start --with-network probes only the disclosed public npm registry", () => {
    const { root } = initPrivateScopeRepo();
    temps.push(root);

    const result = runSessionStart(root, withNetworkOptions());

    expect(result.code === 0 || result.code === 1).toBe(true);
    expectOnlyDisclosedPublicRegistryProbe(packageManagerCalls(spawnSyncMock));
  });

  it("--with-network reaches the deep SCM path yet executes no outbound command (#3901 control)", () => {
    const { root } = initPrivateScopeRepo();
    temps.push(root);
    const observedDepths: string[] = [];

    const result = runSessionStart(root, withNetworkOptions(observedDepths));

    expect(result.payload.optional_network).toBe(true);
    // The injected probe is load-bearing: this depth otherwise spawns live `gh`.
    expect(observedDepths).toEqual(["deep"]);
    expect(outboundExecutions()).toEqual([]);
  });

  it("the outbound guard sees a remote git call on either child_process seam (#3901)", () => {
    // Non-vacuity for the guard itself: local git is exempt, remote git is not,
    // and both wrapped entrypoints feed the same record.
    expect(spawnHarness.isOutbound("git", ["rev-parse", "HEAD"])).toBe(false);
    expect(spawnHarness.isOutbound("git", ["status"])).toBe(false);
    expect(spawnHarness.isOutbound("git", ["remote", "get-url", "origin"])).toBe(false);
    expect(spawnHarness.isOutbound("git", ["ls-remote", "origin"])).toBe(true);
    expect(spawnHarness.isOutbound("git", ["fetch", "origin"])).toBe(true);
    expect(spawnHarness.isOutbound("git", ["remote", "update"])).toBe(true);
    expect(spawnHarness.isOutbound("gh", ["auth", "status"])).toBe(true);
    expect(spawnHarness.isOutbound("npm", ["view"])).toBe(true);

    const { root } = initPrivateScopeRepo();
    temps.push(root);
    // The fixture's six git subprocesses ran through the wrapped execFileSync
    // and are all local, so the guard stays empty on a real recorded run.
    expect(spawnHarness.executed.some((call) => call.command === "git")).toBe(true);
    expect(outboundExecutions()).toEqual([]);
  });

  it("mutation: an added private-scope registry call fails the assertion (#2182 non-vacuity)", () => {
    const { root } = initPrivateScopeRepo();
    temps.push(root);

    runSessionStart(root, withNetworkOptions());
    expectOnlyDisclosedPublicRegistryProbe(packageManagerCalls(spawnSyncMock));

    // A second flow reaches the fixture's internal registry through the same
    // seam. The stub answers it, so the mutation adds a recorded call without
    // any traffic -- assert that rather than discarding the result.
    const injected = spawnSync("npm", PRIVATE_SCOPE_VIEW_ARGS, {
      encoding: "utf8",
      timeout: 5_000,
    });
    expect(injected.status).toBe(0);

    expect(() =>
      expectOnlyDisclosedPublicRegistryProbe(packageManagerCalls(spawnSyncMock)),
    ).toThrow();
  });

  it("mutation: dropping the public-registry probe fails the assertion (#2182 non-vacuity)", () => {
    const { root } = initPrivateScopeRepo();
    temps.push(root);

    const result = runSessionStart(root, {
      ...withNetworkOptions(),
      // The mutation: the release probe no longer issues the disclosed call.
      probeReleaseAvailability: () => ({ lines: [] }),
    });

    expect(result.code === 0 || result.code === 1).toBe(true);
    expect(packageManagerCalls(spawnSyncMock)).toEqual([]);
    expect(() =>
      expectOnlyDisclosedPublicRegistryProbe(packageManagerCalls(spawnSyncMock)),
    ).toThrow();
  });

  it("the gated session-ritual doctor step never requests --network", () => {
    // Regression lock: the gated tier issues a bare `doctor` command with no
    // extra args, so a bare `deft doctor` call stays on the offline tier
    // by default -- this is the load-bearing wiring that keeps the gated
    // session-ritual step network-free without the doctor implementation
    // needing to know it is being invoked from the ritual.
    expect(GATED_ENTRYPOINT_COMMANDS.doctor).toEqual(["doctor"]);
  });

  it("defaultRitualRunner's doctor step invokes only offline npm config reads", () => {
    const { root } = initPrivateScopeRepo();
    temps.push(root);

    const result = defaultRitualRunner(GATED_ENTRYPOINT_COMMANDS.doctor.slice(), root);

    expect(typeof result.code).toBe("number");
    expect(packageManagerCalls(spawnSyncMock)).toEqual([
      [
        "npm",
        ["config", "get", "@deftai:registry"],
        expect.objectContaining({
          cwd: root,
          encoding: "utf8",
          shell: false,
          timeout: 5_000,
        }),
      ],
      [
        "npm",
        ["config", "get", "registry"],
        expect.objectContaining({
          cwd: root,
          encoding: "utf8",
          shell: false,
          timeout: 5_000,
        }),
      ],
    ]);
    expect(`${result.stdout}${result.stderr}`).toMatch(/--network/);
  });
});
