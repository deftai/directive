/**
 * Doctor wiring for the runtime-owner check (#6185): the always-cheap throttle
 * path and the full path both fail on a runtime linked in from another
 * checkout, and stay quiet for a runtime this checkout owns.
 */

import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cmdDoctor } from "./main.js";
import type { CheckResult } from "./types.js";

const temps: string[] = [];
afterEach(() => {
  while (temps.length > 0) {
    const t = temps.pop();
    if (t) rmSync(t, { recursive: true, force: true });
  }
});

const FAIL: CheckResult = {
  name: "foreign-runtime-link",
  status: "fail",
  detail: "runtime resolves to another checkout (/other)",
  data: { owner_root: "/other" },
};
const PASS: CheckResult = {
  name: "foreign-runtime-link",
  status: "pass",
  detail: "runtime belongs to this checkout.",
};

function capture<T>(fn: () => T): { value: T; out: string } {
  const out: string[] = [];
  const origOut = process.stdout.write.bind(process.stdout);
  const origErr = process.stderr.write.bind(process.stderr);
  const sink = ((chunk: string | Uint8Array): boolean => {
    out.push(typeof chunk === "string" ? chunk : chunk.toString());
    return true;
  }) as typeof process.stdout.write;
  process.stdout.write = sink;
  process.stderr.write = sink;
  try {
    return { value: fn(), out: out.join("") };
  } finally {
    process.stdout.write = origOut;
    process.stderr.write = origErr;
  }
}

function throttledDoctor(owner: CheckResult): { exit: number; out: string } {
  const now = new Date("2026-01-01T12:00:00Z");
  const root = mkdtempSync(join(tmpdir(), "deft-doc-rtlink-"));
  temps.push(root);
  mkdirSync(join(root, ".deft", "core"), { recursive: true });
  const { value, out } = capture(() =>
    cmdDoctor(["--json", "--project-root", root], {
      whichFn: () => "/usr/bin/x",
      readState: () => ({
        lastRunAt: new Date("2026-01-01T11:00:00Z"),
        lastExitCode: 0,
        lastFindingCount: 0,
        lastErrorCount: 0,
        lastHasDeftCore: true,
      }),
      writeState: () => {
        throw new Error("throttle skip must not persist");
      },
      now: () => now,
      engineProbe: () => ({ reachable: false, version: null }),
      checkDanglingNodeModulesLinks: () => ({
        name: "dangling-node-modules-links",
        status: "pass",
        detail: "ok",
      }),
      checkRuntimeLinkOwner: () => owner,
    }),
  );
  return { exit: value, out };
}

describe("doctor runtime-link owner check (#6185)", () => {
  it("fails the throttle-skipped path and reports the finding", () => {
    const { exit, out } = throttledDoctor(FAIL);
    expect(exit).toBe(1);
    const payload = JSON.parse(out) as {
      status: string;
      signpost_findings?: Array<{ check: string; severity: string }>;
    };
    expect(payload.status).toBe("throttle-skipped");
    expect(payload.signpost_findings).toContainEqual(
      expect.objectContaining({ check: "foreign-runtime-link", severity: "error" }),
    );
  });

  it("does not fail the throttle-skipped path for an owned runtime", () => {
    const { exit, out } = throttledDoctor(PASS);
    expect(exit).toBe(0);
    expect(out).not.toContain("foreign-runtime-link");
  });

  it("prints the failure on a human-readable throttle-skipped run", () => {
    const now = new Date("2026-01-01T12:00:00Z");
    const root = mkdtempSync(join(tmpdir(), "deft-doc-rtlink-h-"));
    temps.push(root);
    mkdirSync(join(root, ".deft", "core"), { recursive: true });
    const { value, out } = capture(() =>
      cmdDoctor(["--project-root", root], {
        whichFn: () => "/usr/bin/x",
        readState: () => ({
          lastRunAt: new Date("2026-01-01T11:00:00Z"),
          lastExitCode: 0,
          lastFindingCount: 0,
          lastErrorCount: 0,
          lastHasDeftCore: true,
        }),
        writeState: () => null,
        now: () => now,
        engineProbe: () => ({ reachable: false, version: null }),
        checkDanglingNodeModulesLinks: () => ({
          name: "dangling-node-modules-links",
          status: "pass",
          detail: "ok",
        }),
        checkRuntimeLinkOwner: () => FAIL,
      }),
    );
    expect(value).toBe(1);
    expect(out).toContain("foreign-runtime-link");
    expect(out).toContain("linked in from another checkout");
  });

  it("fails the full path (framework repo) with an error finding", () => {
    const { value, out } = capture(() =>
      cmdDoctor(["--full", "--json"], {
        frameworkRoot: process.cwd(),
        whichFn: () => "/usr/bin/x",
        checkRuntimeLinkOwner: () => FAIL,
        writeState: () => null,
      }),
    );
    expect(value).toBe(1);
    const payload = JSON.parse(out) as {
      findings?: Array<{ check?: string; severity?: string }>;
    };
    expect(
      payload.findings?.some((f) => f.check === "foreign-runtime-link" && f.severity === "error"),
    ).toBe(true);
  });

  it("adds no finding on the full path for an owned runtime", () => {
    const { out } = capture(() =>
      cmdDoctor(["--full", "--json"], {
        frameworkRoot: process.cwd(),
        whichFn: () => "/usr/bin/x",
        checkRuntimeLinkOwner: () => PASS,
        writeState: () => null,
      }),
    );
    const payload = JSON.parse(out) as { findings?: Array<{ check?: string }> };
    expect(payload.findings?.some((f) => f.check === "foreign-runtime-link")).toBeFalsy();
  });
});
