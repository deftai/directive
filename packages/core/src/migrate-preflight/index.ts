import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { defaultWhich } from "../scm/binary.js";
import {
  detectPreCutoverLegacy,
  isCurrentGeneratedSpecification,
  isGeneratedSpecificationExport,
  missingLifecycleFolders,
} from "../vbrief-validate/precutover.js";

export type CheckStatus = "PASS" | "WARN" | "FAIL";

export interface CheckResult {
  readonly name: string;
  readonly status: CheckStatus;
  readonly message: string;
}

export interface MigratePreflightArgs {
  readonly projectRoot: string;
  readonly deftRoot: string;
  readonly quiet: boolean;
}

export interface MigratePreflightConfigError {
  readonly kind: "config";
  readonly message: string;
}

export type MigratePreflightOutcome =
  | { readonly kind: "ready"; readonly exitCode: 0 | 1; readonly results: readonly CheckResult[] }
  | MigratePreflightConfigError;

function resolveContentRoot(frameworkRoot: string): string {
  const nested = join(frameworkRoot, "content");
  try {
    if (statSync(nested).isDirectory()) return nested;
  } catch {
    // consumer deposit: content lives directly under framework root
  }
  return frameworkRoot;
}

export function checkUv(which: (cmd: string) => string | null = defaultWhich): CheckResult {
  if (which("uv") !== null) {
    return { name: "uv", status: "PASS", message: "uv is on PATH." };
  }
  return {
    name: "uv",
    status: "FAIL",
    message: "uv is not on PATH. Install from https://docs.astral.sh/uv/ and re-run.",
  };
}

export function checkLayout(deftRoot: string, projectRoot: string): CheckResult {
  const migrator = join(deftRoot, "scripts", "migrate_vbrief.py");
  if (!existsSync(migrator) || !statSync(migrator).isFile()) {
    return {
      name: "layout",
      status: "FAIL",
      message: `Migrator script missing at ${migrator}. The framework checkout appears incomplete or pre-v0.20; refresh per deft/QUICK-START.md.`,
    };
  }

  const schemasDir = join(resolveContentRoot(deftRoot), "vbrief", "schemas");
  if (!existsSync(schemasDir) || !statSync(schemasDir).isDirectory()) {
    return {
      name: "layout",
      status: "FAIL",
      message: `Framework schemas dir missing at ${schemasDir}. Refresh the deft checkout (see deft/QUICK-START.md).`,
    };
  }

  const projectVbrief = join(projectRoot, "vbrief");
  if (!existsSync(projectVbrief)) {
    return {
      name: "layout",
      status: "WARN",
      message: `Project vbrief/ not present at ${projectVbrief} -- migrator will create it on first run; this is expected for greenfield projects.`,
    };
  }

  return {
    name: "layout",
    status: "PASS",
    message: `Framework migrator + schemas present; project vbrief/ at ${projectVbrief}.`,
  };
}

export function checkGitClean(projectRoot: string): CheckResult {
  try {
    const stdout = execFileSync("git", ["status", "--porcelain"], {
      cwd: projectRoot,
      encoding: "utf8",
    });
    if (stdout.trim()) {
      return {
        name: "git-clean",
        status: "WARN",
        message:
          "Working tree is dirty. The migrator will refuse to run without --force; preview with `task migrate:vbrief -- --dry-run` first.",
      };
    }
    return { name: "git-clean", status: "PASS", message: "Working tree is clean." };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return {
        name: "git-clean",
        status: "WARN",
        message:
          "git executable not on PATH; skipping working-tree check. Migrator's dirty-tree guard will still fire if applicable.",
      };
    }
    return {
      name: "git-clean",
      status: "WARN",
      message: `Not a git repository at ${projectRoot}; skipping working-tree check.`,
    };
  }
}

export function checkDocumentModel(projectRoot: string): CheckResult {
  const legacy = detectPreCutoverLegacy(projectRoot);
  if (legacy.length > 0) {
    return {
      name: "document-model",
      status: "PASS",
      message: `Legacy root artifact(s) detected: ${legacy.join(", ")}.`,
    };
  }

  const specPath = join(projectRoot, "SPECIFICATION.md");
  if (existsSync(specPath) && statSync(specPath).isFile()) {
    let content = "";
    try {
      content = readFileSync(specPath, "utf8");
    } catch {
      content = "";
    }
    if (isGeneratedSpecificationExport(projectRoot, content)) {
      const missing = missingLifecycleFolders(projectRoot);
      if (missing.length > 0) {
        return {
          name: "document-model",
          status: "FAIL",
          message: `Generated SPECIFICATION.md detected (source: vbrief/specification.vbrief.json); repair missing lifecycle folder(s) instead of migrating: ${missing.join(", ")}.`,
        };
      }
    }
    if (isCurrentGeneratedSpecification(projectRoot, content)) {
      return {
        name: "document-model",
        status: "FAIL",
        message:
          "Current generated SPECIFICATION.md detected (source: vbrief/specification.vbrief.json); `task migrate:vbrief` is not needed.",
      };
    }
  }

  const vbriefRoot = join(projectRoot, "vbrief");
  if (existsSync(vbriefRoot)) {
    const missing = missingLifecycleFolders(projectRoot);
    if (missing.length > 0) {
      return {
        name: "document-model",
        status: "PASS",
        message: `Partial vBRIEF layout detected; missing lifecycle folder(s): ${missing.join(", ")}.`,
      };
    }
  }

  return {
    name: "document-model",
    status: "WARN",
    message:
      "No legacy root SPECIFICATION.md/PROJECT.md artifacts detected. Migration may have nothing to do.",
  };
}

export function evaluate(
  deftRoot: string,
  projectRoot: string,
  which: (cmd: string) => string | null = defaultWhich,
): { exitCode: 0 | 1; results: CheckResult[] } {
  const results = [
    checkUv(which),
    checkLayout(deftRoot, projectRoot),
    checkDocumentModel(projectRoot),
    checkGitClean(projectRoot),
  ];
  if (results.some((r) => r.status === "FAIL")) {
    return { exitCode: 1, results };
  }
  return { exitCode: 0, results };
}

export function formatCheckLine(result: CheckResult): string {
  return `CHECK ${result.name}: ${result.status} ${result.message}`;
}

export function runMigratePreflight(args: MigratePreflightArgs): MigratePreflightOutcome {
  const projectRoot = resolve(args.projectRoot);
  const deftRoot = resolve(args.deftRoot);

  if (!existsSync(projectRoot) || !statSync(projectRoot).isDirectory()) {
    return {
      kind: "config",
      message: `--project-root must be an existing directory: ${args.projectRoot}`,
    };
  }
  if (!existsSync(deftRoot) || !statSync(deftRoot).isDirectory()) {
    return {
      kind: "config",
      message: `--deft-root must be an existing directory: ${args.deftRoot}`,
    };
  }

  const { exitCode, results } = evaluate(deftRoot, projectRoot);
  return { kind: "ready", exitCode, results };
}

export interface MigratePreflightIo {
  writeOut: (text: string) => void;
  writeErr: (text: string) => void;
}

export function emitMigratePreflight(
  outcome: Exclude<MigratePreflightOutcome, MigratePreflightConfigError>,
  io: MigratePreflightIo,
  quiet: boolean,
): number {
  for (const result of outcome.results) {
    if (quiet && result.status === "PASS") continue;
    const line = `${formatCheckLine(result)}\n`;
    if (result.status === "FAIL") io.writeErr(line);
    else io.writeOut(line);
  }
  if (outcome.exitCode === 1) {
    io.writeErr(
      "migrate:preflight FAILED -- resolve the FAIL line(s) above before running `task migrate:vbrief`.\n",
    );
  } else {
    io.writeOut("migrate:preflight OK -- environment ready for `task migrate:vbrief`.\n");
  }
  return outcome.exitCode;
}
