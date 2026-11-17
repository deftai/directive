/**
 * The quiet session:start output keeps the runtime-link failure (#6185).
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { writeState } from "../doctor/doctor-state.js";
import {
  formatOrientationVerboseLines,
  runDoctorOrientationSection,
} from "./orientation-compression.js";
import { isSessionStartAlwaysOnLine, selectSessionStartHumanLines } from "./session-start.js";

const temps: string[] = [];
afterEach(() => {
  while (temps.length > 0) {
    const t = temps.pop();
    if (t) rmSync(t, { recursive: true, force: true });
  }
});

describe("quiet session:start output and the runtime-link failure (#6185)", () => {
  it("classifies the failure line as always-on and a pass as not", () => {
    expect(
      isSessionStartAlwaysOnLine(
        "[deft doctor] foreign-runtime-link: fail -- runtime is elsewhere",
      ),
    ).toBe(true);
    expect(isSessionStartAlwaysOnLine("[deft doctor] status: ok")).toBe(false);
  });

  it("keeps the cause and recovery in the final quiet output", () => {
    const root = mkdtempSync(join(tmpdir(), "ss-rtlink-"));
    temps.push(root);
    writeState(root, {
      exitCode: 0,
      findingCount: 0,
      errorCount: 0,
      now: new Date("2026-01-01T12:00:00Z"),
    });
    const doctor = runDoctorOrientationSection(root, {
      now: new Date("2026-01-01T12:30:00Z"),
      seams: {
        checkRuntimeLinkOwner: () => ({
          name: "foreign-runtime-link",
          status: "fail",
          detail: "runtime belongs to another checkout. Remove the link and install locally.",
        }),
      },
    });
    const quiet = selectSessionStartHumanLines({
      code: 0,
      payload: { ready: true },
      lines: formatOrientationVerboseLines([doctor]),
      env: {},
    });
    const text = quiet.join("\n");
    expect(text).toContain("foreign-runtime-link: fail");
    expect(text).toContain("Remove the link and install locally.");
  });
});
