/**
 * The quiet session:start output keeps the runtime-link failure (#6185).
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  formatOrientationVerboseLines,
  runDoctorOrientationSection,
} from "./orientation-compression.js";
import type { OrientationState } from "./orientation-state.js";
import { isSessionStartAlwaysOnLine, selectSessionStartHumanLines } from "./session-start.js";

/** Session start's record of a clean doctor run 30 minutes before `now` (#6617). */
const CLEAN_PRIOR: OrientationState = {
  schema_version: 1,
  deposit_sha: "abc",
  updated_at: "2026-01-01T12:00:00Z",
  doctor: { ok: true, ts: "2026-01-01T12:00:00Z", exit_code: 0, error_count: 0, finding_count: 0 },
};

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
    const doctor = runDoctorOrientationSection(root, {
      now: new Date("2026-01-01T12:30:00Z"),
      prior: CLEAN_PRIOR,
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
