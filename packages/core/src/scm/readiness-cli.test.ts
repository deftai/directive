import { describe, expect, it } from "vitest";
import {
  mainEntry,
  parseScmReadinessArgs,
  scmReadinessMain,
} from "./readiness-cli.js";
import type { ScmReadinessReport } from "./readiness.js";

function readyReport(overrides: Partial<ScmReadinessReport> = {}): ScmReadinessReport {
  return {
    ready: true,
    binary: "gh",
    binaryPath: "/usr/bin/gh",
    authState: "authenticated",
    githubAuthMode: "host-gh",
    runtimeMode: "local-unsandboxed",
    injectedTokenPresent: false,
    depth: "shallow",
    detail: "SCM ready: gh present, host-gh authenticated (shallow)",
    remediation: null,
    skippedGates: [],
    login: null,
    failureKind: null,
    ...overrides,
  };
}

describe("scm readiness CLI (#2275)", () => {
  it("parses --json and --deep", () => {
    const { args, error } = parseScmReadinessArgs(["--json", "--deep"]);
    expect(error).toBeNull();
    expect(args.json).toBe(true);
    expect(args.depth).toBe("deep");
  });

  it("rejects unknown flags with config error shape", () => {
    const { error } = parseScmReadinessArgs(["--bogus"]);
    expect(error).toMatch(/unknown flag/);
  });

  it("exits 0 when ready", () => {
    const out: string[] = [];
    const code = scmReadinessMain(
      { json: false },
      {
        writeOut: (s) => out.push(s),
        writeErr: () => undefined,
        probe: () => readyReport(),
      },
    );
    expect(code).toBe(0);
    expect(out.join("")).toContain("[deft scm]");
  });

  it("exits 1 when not ready and prints remediation to stderr", () => {
    const err: string[] = [];
    const code = scmReadinessMain(
      {},
      {
        writeOut: () => undefined,
        writeErr: (s) => err.push(s),
        probe: () =>
          readyReport({
            ready: false,
            authState: "binary-absent",
            detail: "gh not found on PATH",
            remediation: "install gh",
            skippedGates: ["triage:queue"],
          }),
      },
    );
    expect(code).toBe(1);
    expect(err.join("")).toContain("install gh");
  });

  it("json mode emits snake_case readiness dict", () => {
    const out: string[] = [];
    scmReadinessMain(
      { json: true },
      {
        writeOut: (s) => out.push(s),
        probe: () => readyReport({ binary: "ghx" }),
      },
    );
    const parsed = JSON.parse(out.join("")) as Record<string, unknown>;
    expect(parsed.ready).toBe(true);
    expect(parsed.binary).toBe("ghx");
    expect(parsed.auth_state).toBe("authenticated");
  });

  it("mainEntry --help exits 0", () => {
    expect(mainEntry(["--help"])).toBe(0);
  });
});
