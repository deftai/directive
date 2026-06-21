/**
 * Wave 8.5 s7 install/migrate CLI tail — retire-vs-retarget coverage map (#1838).
 * Primary deliverable is duplicated in the PR body for Wave 9 mechanical teardown.
 */
export type InstallCliTailClassification = "retire-at-Wave-9" | "retarget";

export interface InstallCliTailEntry {
  readonly pythonTest: string;
  readonly classification: InstallCliTailClassification;
  readonly rationale: string;
  readonly vitestSpec?: string;
}

/** One-line rationale per in-scope tests/cli file (Bucket C audit). */
export const INSTALL_CLI_TAIL_COVERAGE_MAP: readonly InstallCliTailEntry[] = [
  {
    pythonTest: "tests/cli/test_migrate_vbrief.py",
    classification: "retire-at-Wave-9",
    rationale:
      "Exercises scripts/migrate_vbrief.py pre-v0.20 migrator — accepted non-port deleted in #1731.",
  },
  {
    pythonTest: "tests/cli/test_migrate_vbrief_canonical_refs.py",
    classification: "retire-at-Wave-9",
    rationale:
      "End-to-end migrate_vbrief references/narrative clamp regressions — accepted non-port migrator.",
  },
  {
    pythonTest: "tests/cli/test_migrate_vbrief_fixtures.py",
    classification: "retire-at-Wave-9",
    rationale:
      "Fixture-driven migrate() routing matrix — accepted non-port pre-cutover migrator tooling.",
  },
  {
    pythonTest: "tests/cli/test_migrate_vbrief_rc4.py",
    classification: "retire-at-Wave-9",
    rationale: "RC4 migrator rollback/reconciliation — accepted non-port migrate_* family (#1731).",
  },
  {
    pythonTest: "tests/cli/test_migrate_preflight.py",
    classification: "retire-at-Wave-9",
    rationale:
      "scripts/migrate_preflight.py agent-side migrate:vbrief gate — accepted non-port migration tooling.",
  },
  {
    pythonTest: "tests/cli/test_precutover_guard.py",
    classification: "retire-at-Wave-9",
    rationale:
      "Pre-cutover detection and legacy placeholder checks via _precutover — accepted non-port.",
  },
  {
    pythonTest: "tests/cli/test_cmd_agents_refresh.py",
    classification: "retire-at-Wave-9",
    rationale:
      "Python run cmd_agents_refresh upgrade-gate companion — no deft-ts verb; retires with legacy run.",
  },
  {
    pythonTest: "tests/cli/test_cmd_check_updates.py",
    classification: "retire-at-Wave-9",
    rationale:
      "Python run cmd_check_updates remote version probe — no TS port; retires with legacy run module.",
  },
  {
    pythonTest: "tests/cli/test_cmd_doctor.py",
    classification: "retarget",
    rationale:
      "cmd_doctor survives as deft-ts doctor verb (packages/cli/src/doctor.ts); exit-code parity via dispatch.",
    vitestSpec: "packages/cli/src/install-cli/retarget-dispatch.test.ts",
  },
  {
    pythonTest: "tests/cli/test_cmd_gate.py",
    classification: "retire-at-Wave-9",
    rationale:
      "Python run cmd_gate universal upgrade gate — no deft-ts verb; retires with legacy run module.",
  },
  {
    pythonTest: "tests/cli/test_cmd_spec.py",
    classification: "retire-at-Wave-9",
    rationale:
      "Python run cmd_spec interactive spec generator — no deft-ts verb; retires with legacy run.",
  },
  {
    pythonTest: "tests/cli/test_upgrade_gate.py",
    classification: "retire-at-Wave-9",
    rationale:
      "Python run upgrade gate and cmd_project lifecycle scaffolding — legacy run; no TS equivalent.",
  },
  {
    pythonTest: "tests/cli/test_upgrade_gate_remote_drift.py",
    classification: "retire-at-Wave-9",
    rationale: "Python run _check_upgrade_gate remote-drift integration — legacy run upgrade path.",
  },
  {
    pythonTest: "tests/cli/test_run_bat_path.py",
    classification: "retire-at-Wave-9",
    rationale:
      "Windows run.bat packaging shim self-relative resolution — build/packaging accepted non-port.",
  },
  {
    pythonTest: "tests/cli/test_run_version.py",
    classification: "retire-at-Wave-9",
    rationale:
      "Python run VERSION resolution chain — legacy run entrypoint retires with scripts/*.py in #1731.",
  },
  {
    pythonTest: "tests/cli/test_setup_ghx.py",
    classification: "retire-at-Wave-9",
    rationale:
      "scripts/setup_ghx.py consent-gated installer helper — build/packaging accepted non-port (#1731).",
  },
  {
    pythonTest: "tests/cli/test_safe_subprocess.py",
    classification: "retire-at-Wave-9",
    rationale:
      "scripts/_safe_subprocess.py UTF-8 capture shim — Python runtime accepted non-port (#1731).",
  },
  {
    pythonTest: "tests/cli/test_task_scripts.py",
    classification: "retarget",
    rationale:
      "TestToolchainCheck maps to deft-ts toolchain-check; remainder covers legacy Python task scripts without TS verbs.",
    vitestSpec: "packages/cli/src/install-cli/retarget-dispatch.test.ts",
  },
  {
    pythonTest: "tests/cli/test_ts_check_lane.py",
    classification: "retire-at-Wave-9",
    rationale:
      "scripts/ts_check_lane.py Python meta-guard for pnpm lane — retires once Python CI lane is removed.",
  },
  {
    pythonTest: "tests/cli/test_vendored_install_metadata.py",
    classification: "retire-at-Wave-9",
    rationale:
      "Vendored Go-install metadata via Python run/doctor/resolve_version — installer deposit accepted non-port.",
  },
  {
    pythonTest: "tests/cli/test_remote_probe_throttle.py",
    classification: "retire-at-Wave-9",
    rationale:
      "Python run remote-probe throttle state for #801 — legacy run module; no deft-ts verb.",
  },
];
