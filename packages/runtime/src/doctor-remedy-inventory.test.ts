/**
 * Rule 10 / rule 9 inventory for Wave 2e doctor remedies.
 * update-as-repair and agent npx/pnpm-exec must not appear in Contract-1 doctor text.
 */
import { describe, expect, it } from "vitest";
import { INSTALLATION_RECOVERY_GUIDANCE } from "@deftai/directive-core/dist/install-health/constants.js";
import {
  FORBIDDEN_DOCTOR_REMEDY_PATTERNS,
  formatDoctorReport,
  runDoctorDiagnosis,
} from "./doctor-diagnose.js";

describe("doctor remedy inventory (rule 10 / rule 9 / AC12.5–12.7)", () => {
  it("AC9.7 recovery string is the install/wiring remedy", () => {
    expect(INSTALLATION_RECOVERY_GUIDANCE).toBe(
      "npm i -g @deftai/directive, then directive install --repair",
    );
  });

  it("forbidden remedy patterns stay stable for message checks", () => {
    expect(FORBIDDEN_DOCTOR_REMEDY_PATTERNS.length).toBeGreaterThanOrEqual(8);
    const sample = formatDoctorReport(
      runDoctorDiagnosis("/tmp/definitely-not-a-directive-project-2e", { probeHooks: false }),
    );
    for (const re of FORBIDDEN_DOCTOR_REMEDY_PATTERNS) {
      expect(sample).not.toMatch(re);
    }
    // Repair wording must not be presented as upgrade when install is broken.
    if (sample.includes(INSTALLATION_RECOVERY_GUIDANCE)) {
      expect(sample).not.toMatch(/Next: directive upgrade/);
    }
  });
});
