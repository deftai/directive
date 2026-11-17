/**
 * session:start reports a runtime linked in from another checkout even when the
 * doctor run itself is throttle-skipped (#6185).
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { writeState } from "../doctor/doctor-state.js";
import type { CheckResult } from "../doctor/types.js";
import { runDoctorOrientationSection } from "./orientation-compression.js";

const temps: string[] = [];
afterEach(() => {
  while (temps.length > 0) {
    const t = temps.pop();
    if (t) rmSync(t, { recursive: true, force: true });
  }
});

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "orient-rtlink-"));
  temps.push(root);
  return root;
}

const FAIL: CheckResult = {
  name: "foreign-runtime-link",
  status: "fail",
  detail: "runtime resolves to another checkout (/other)",
};
const PASS: CheckResult = { name: "foreign-runtime-link", status: "pass", detail: "ok" };

describe("orientation doctor section runtime-link check (#6185)", () => {
  it("reports the failure when doctor is throttle-skipped", () => {
    const root = tempRoot();
    const now = new Date("2026-01-01T12:00:00Z");
    writeState(root, { exitCode: 0, findingCount: 0, errorCount: 0, now });
    const section = runDoctorOrientationSection(root, {
      now: new Date("2026-01-01T12:30:00Z"),
      seams: { checkRuntimeLinkOwner: () => FAIL },
      doctorRunner: () => {
        throw new Error("doctor must stay throttle-skipped");
      },
    });
    expect(section.detail?.throttle_skipped).toBe(true);
    expect(section.detail?.foreign_runtime_link).toBe(true);
    expect(section.ok).toBe(false);
    expect(section.status).toBe("dirty");
    expect(section.exitCode).toBe(1);
    expect(section.lines.join("\n")).toContain("foreign-runtime-link: fail");
  });

  it("stays ok when doctor is throttle-skipped and the runtime is owned", () => {
    const root = tempRoot();
    writeState(root, {
      exitCode: 0,
      findingCount: 0,
      errorCount: 0,
      now: new Date("2026-01-01T12:00:00Z"),
    });
    const section = runDoctorOrientationSection(root, {
      now: new Date("2026-01-01T12:30:00Z"),
      seams: { checkRuntimeLinkOwner: () => PASS },
    });
    expect(section.ok).toBe(true);
    expect(section.lines.join("\n")).not.toContain("foreign-runtime-link");
  });

  it("adds the failure line when doctor runs", () => {
    const root = tempRoot();
    const section = runDoctorOrientationSection(root, {
      seams: { checkRuntimeLinkOwner: () => FAIL },
      doctorRunner: () => 0,
    });
    expect(section.detail?.throttle_skipped).toBe(false);
    expect(section.lines.join("\n")).toContain("foreign-runtime-link: fail");
  });
});
