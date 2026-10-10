/**
 * Contract 1 entry points: setup / migrate / uninstall / doctor data-status.
 * Wave 2a: setup install|repair is real; migrate/uninstall remain stubs.
 */
import { runSetup } from "./setup.js";

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
    const result = {
      contract: 1,
      entry: "migrate",
      stub: true,
      from,
      root,
      migrated: [] as string[],
      message: "migrate stub (wave 2b implements schema migration)",
    };
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return 0;
  }

  if (head === "uninstall" && hasFlag(argv, "--root")) {
    const root = takeFlag([...argv], "--root");
    if (root === null) {
      process.stderr.write("directive-runtime uninstall: require --root <path>\n");
      return 2;
    }
    const result = {
      contract: 1,
      entry: "uninstall",
      stub: true,
      root,
      removed: [] as string[],
      remaining: [] as string[],
      message: "uninstall stub (wave 2 implements owned-file removal)",
    };
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return 0;
  }

  if (head === "doctor" && process.env.DIRECTIVE_LAUNCHER_VERSION) {
    const result = {
      contract: 1,
      dataStatus: "current",
      stub: true,
      message: "doctor data-status stub (wave 2 expands diagnosis)",
    };
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return 0;
  }

  return null;
}
