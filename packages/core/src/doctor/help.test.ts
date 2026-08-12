import { describe, expect, it } from "vitest";
import { formatDoctorHelp } from "./help.js";
import { SESSION_CODA_OFF_HINT } from "./session-coda.js";

describe("formatDoctorHelp (#2712)", () => {
  it("documents usage, flags, and DEFT_SESSION_CODA three-state", () => {
    const help = formatDoctorHelp();
    expect(help).toContain("Usage: deft doctor");
    expect(help).toContain("--json");
    expect(help).toContain("--full");
    expect(help).toContain("DEFT_SESSION_CODA");
    expect(help).toContain(SESSION_CODA_OFF_HINT);
    expect(help).toContain("\u2726 ");
    expect(help).toContain("=0");
    expect(help).toContain("=1");
  });
});
