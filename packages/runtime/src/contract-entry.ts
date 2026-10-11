/**
 * Contract 1 entry points: setup / migrate / uninstall / doctor (Wave 2e).
 * `doctor --data-status` remains the AC4.10 machine discriminant for upgrade.
 * Plain `doctor` runs full read-only diagnosis (R12).
 */
import { readProjectDataStatus } from "./data-status.js";
import { formatDoctorReport, runDoctorDiagnosis } from "./doctor-diagnose.js";
import { runMigrate } from "./migrate.js";
import { runSetup } from "./setup.js";
import { runUninstall } from "./uninstall.js";

const SETUP_OPS = new Set(["install", "repair", "upgrade"]);

function takeFlag(argv: string[], name: string): string | null {
  const idx = argv.indexOf(name);
  if (idx === -1) return null;
  return argv[idx + 1] ?? null;
}

function hasFlag(argv: readonly string[], name: string): boolean {
  return argv.includes(name);
}

/**
 * If argv is a Contract 1 bookend entry, handle it and return an exit code.
 * Otherwise return null so the ordinary product router runs.
 */
export function handleContractEntrypoint(argv: readonly string[]): number | null {
  const head = argv[0];
  if (head === undefined) return null;

  if (head === "setup") {
    const operation = takeFlag([...argv], "--operation");
    const from = takeFlag([...argv], "--from");
    const root = takeFlag([...argv], "--root");
    if (operation === null || !SETUP_OPS.has(operation) || from === null || root === null) {
      process.stderr.write(
        "directive-runtime setup: require --operation <install|repair|upgrade> --from <version|old-style|none> --root <path>\n",
      );
      return 2;
    }
    const result = runSetup({
      operation: operation as "install" | "repair" | "upgrade",
      from,
      root,
    });
    process.stdout.write(`${JSON.stringify(result)}\n`);
    if (result.conflicts.length > 0) return 1;
    return 0;
  }

  if (head === "migrate") {
    const from = takeFlag([...argv], "--from");
    const root = takeFlag([...argv], "--root");
    if (from === null || root === null) {
      process.stderr.write("directive-runtime migrate: require --from <version> --root <path>\n");
      return 2;
    }
    const result = runMigrate({ from, root });
    process.stdout.write(`${JSON.stringify(result)}\n`);
    if (result.message.startsWith("migrate failed")) return 1;
    return 0;
  }

  if (head === "uninstall" && hasFlag(argv, "--root")) {
    const root = takeFlag([...argv], "--root");
    if (root === null) {
      process.stderr.write("directive-runtime uninstall: require --root <path>\n");
      return 2;
    }
    const result = runUninstall({ root });
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return result.remaining.length > 0 ? 1 : 0;
  }

  if (head === "doctor") {
    const root =
      takeFlag([...argv], "--root") ??
      process.env.DIRECTIVE_PROJECT_ROOT ??
      process.cwd();

    // Machine discriminant for equal-version upgrade (AC4.10).
    if (hasFlag(argv, "--data-status")) {
      const status = readProjectDataStatus(root);
      process.stdout.write(`${JSON.stringify(status)}\n`);
      if (status.dataStatus === "diagnosis_failed") return 1;
      return 0;
    }

    // Full read-only diagnosis (R12 / AC12.*). Never writes.
    const launcherPresent =
      typeof process.env.DIRECTIVE_LAUNCHER_VERSION === "string" &&
      process.env.DIRECTIVE_LAUNCHER_VERSION.length > 0;
    const diag = runDoctorDiagnosis(root, {
      launcherPresent,
      probeHooks: true,
    });
    process.stdout.write(formatDoctorReport(diag));
    // Trailing machine line keeps older parsers that read last JSON tolerant.
    process.stdout.write(
      `${JSON.stringify({ contract: 1, dataStatus: diag.dataStatus, entry: "doctor" })}\n`,
    );
    return diag.exitCode;
  }

  return null;
}
