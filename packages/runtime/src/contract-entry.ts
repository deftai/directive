/**
 * Contract 1 entry points: setup / migrate / uninstall / doctor (Wave 2e).
 * `doctor --data-status` remains the AC4.10 machine discriminant for upgrade.
 * Plain `doctor` composes install-sync diagnosis + full product doctor (F-015 / C6).
 */
import { readProjectDataStatus } from "./data-status.js";
import { formatDoctorReport, runDoctorDiagnosis } from "./doctor-diagnose.js";
import { run as runProductDoctor } from "./doctor.js";
import { runMigrate } from "./migrate.js";
import { runSetup } from "./setup.js";
import { runUninstall } from "./uninstall.js";

const SETUP_OPS = new Set(["install", "repair", "upgrade"]);

/** Separator between AC12.3 install-sync report and the product doctor suite. */
export const DOCTOR_PRODUCT_SECTION_SEPARATOR = "--- product doctor ---";

function takeFlag(argv: string[], name: string): string | null {
  const idx = argv.indexOf(name);
  if (idx === -1) return null;
  return argv[idx + 1] ?? null;
}

function hasFlag(argv: readonly string[], name: string): boolean {
  return argv.includes(name);
}

/**
 * Strip contract-only tokens and map `--root` onto product `--project-root`.
 * Product `doctor.ts` / `cmdDoctor` expect flags only (no leading `doctor` verb).
 */
export function buildProductDoctorArgv(argv: readonly string[], root: string): string[] {
  const out: string[] = ["--project-root", root];
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i] ?? "";
    if (token === "doctor" || token === "--data-status") continue;
    if (token === "--root" || token === "--project-root") {
      i += 1;
      continue;
    }
    if (token.startsWith("--root=") || token.startsWith("--project-root=")) continue;
    out.push(token);
  }
  return out;
}

/**
 * If argv is a Contract 1 bookend entry, handle it and return an exit code.
 * Otherwise return null so the ordinary product router runs.
 */
export async function handleContractEntrypoint(
  argv: readonly string[],
): Promise<number | null> {
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

    // Machine discriminant for equal-version upgrade (AC4.10). Sync-only; no product suite.
    if (hasFlag(argv, "--data-status")) {
      const status = readProjectDataStatus(root);
      process.stdout.write(`${JSON.stringify(status)}\n`);
      if (status.dataStatus === "diagnosis_failed") return 1;
      return 0;
    }

    // Help / unknown-flag UX: product doctor owns the help text (no sync preamble).
    if (hasFlag(argv, "--help") || hasFlag(argv, "-h")) {
      return runProductDoctor(buildProductDoctorArgv(argv, root));
    }

    // F-015 / C6: compose AC12.3 install-sync diagnosis, then full product doctor.
    // Install-sync surfaces stay additive; deep suite must not be silently dropped.
    const launcherPresent =
      typeof process.env.DIRECTIVE_LAUNCHER_VERSION === "string" &&
      process.env.DIRECTIVE_LAUNCHER_VERSION.length > 0;
    const diag = runDoctorDiagnosis(root, {
      launcherPresent,
      probeHooks: true,
    });
    process.stdout.write(formatDoctorReport(diag));
    process.stdout.write(`\n${DOCTOR_PRODUCT_SECTION_SEPARATOR}\n`);

    const productCode = await runProductDoctor(buildProductDoctorArgv(argv, root));

    // Trailing machine line keeps older parsers that read last JSON tolerant.
    process.stdout.write(
      `${JSON.stringify({ contract: 1, dataStatus: diag.dataStatus, entry: "doctor" })}\n`,
    );

    // Prefer install-sync exit when unhealthy; otherwise surface product suite status.
    if (diag.exitCode !== 0) return diag.exitCode;
    return productCode;
  }

  return null;
}
