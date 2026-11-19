/**
 * Doctor wiring for the runtime-owner check (#6185): the full
 * path fails on a runtime linked in from another
 * checkout, and stay quiet for a runtime this checkout owns.
 */

import { rmSync } from "node:fs";
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

describe("doctor runtime-link owner check (#6185)", () => {
  it("fails the full path (framework repo) with an error finding", () => {
    const { value, out } = capture(() =>
      cmdDoctor(["--full", "--json"], {
        frameworkRoot: process.cwd(),
        whichFn: () => "/usr/bin/x",
        checkRuntimeLinkOwner: () => FAIL,
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
      }),
    );
    const payload = JSON.parse(out) as { findings?: Array<{ check?: string }> };
    expect(payload.findings?.some((f) => f.check === "foreign-runtime-link")).toBeFalsy();
  });
});
