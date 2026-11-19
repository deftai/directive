/**
 * Doctor --help / -h text (#2712 session coda env docs + flag surface).
 */

import { DOCTOR_ALLOWED_FLAGS } from "./constants.js";
import { sessionCodaHelpText } from "./session-coda.js";

export function formatDoctorHelp(): string {
  const flags = DOCTOR_ALLOWED_FLAGS.join(", ");
  return [
    "Usage: deft doctor [options]",
    "",
    "Diagnose the Directive install and print the one next step.",
    "",
    "Options:",
    "  --session              Session-oriented probe",
    "  --fix, --repair        Copy missing OpenClaw always-pin skills (OpenClaw only)",
    "  --json                 Machine-readable JSON (no human footer / no coda)",
    "  --quiet                Suppress mid-run chatter; final summary still prints",
    "  --full                 Also run the live hook probe (doctor never skips a run)",
    "  --network              Allow offline-tier network checks (payload staleness)",
    "  --project-root <path>  Project root (default: cwd)",
    "  --force                Replace divergent OpenClaw pins during --fix",
    "  --openclaw-all-agents  Wire always-pins into every OpenClaw workspace seat",
    "  -h, --help             Show this help",
    "",
    `Allowed flags: ${flags}`,
    "",
    sessionCodaHelpText(),
    "",
  ].join("\n");
}
