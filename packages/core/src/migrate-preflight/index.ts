import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  detectPreCutoverLegacy,
  frozenPreCutoverMigrationGuidance,
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

export function checkLayout(deftRoot: string, projectRoot: string): CheckResult {
  const schemasDir = join(resolveContentRoot(deftRoot), "xbrief", "schemas");
  if (!existsSync(schemasDir) || !statSync(schemasDir).isDirectory()) {
    return {
      name: "layout",
      status: "FAIL",
      message: `Framework schemas dir missing at ${schemasDir}. Refresh the deft checkout (see deft/QUICK-START.md).`,
    };
  }

  const projectXbrief = join(projectRoot, "xbrief");
  if (!existsSync(projectXbrief)) {
    return {
      name: "layout",
      status: "WARN",
      message: `Project xbrief/ not present at ${projectXbrief} -- expected for greenfield projects.`,
    };
  }

  return {
    name: "layout",
    status: "PASS",
    message: `Framework schemas present; project xbrief/ at ${projectXbrief}.`,
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
          "Working tree is dirty. Commit or stash before running a frozen-release migration.",
      };
    }
    return { name: "git-clean", status: "PASS", message: "Working tree is clean." };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return {
        name: "git-clean",
        status: "WARN",
        message: "git executable not on PATH; skipping working-tree check.",
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
      status: "FAIL",
      message: `Pre-v0.20 document model detected (${legacy.join(", ")}). ${frozenPreCutoverMigrationGuidance()}`,
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
          message: `Generated SPECIFICATION.md detected (source: xbrief/specification.xbrief.json); repair missing lifecycle folder(s) instead of migrating: ${missing.join(", ")}.`,
        };
      }
    }
    if (isCurrentGeneratedSpecification(projectRoot, content)) {
      return {
        name: "document-model",
        status: "PASS",
        message:
          "Current generated SPECIFICATION.md detected (source: xbrief/specification.xbrief.json); pre-v0.20 migration is not needed.",
      };
    }
  }

  const xbriefRoot = join(projectRoot, "xbrief");
  if (existsSync(xbriefRoot)) {
    const missing = missingLifecycleFolders(projectRoot);
    if (missing.length > 0) {
      return {
        name: "document-model",
        status: "FAIL",
        message: `Partial xBRIEF layout detected; missing lifecycle folder(s): ${missing.join(", ")}. Create the folders or follow ${frozenPreCutoverMigrationGuidance()}`,
      };
    }
  }

  return {
    name: "document-model",
    status: "PASS",
    message: "No pre-v0.20 document-model artifacts detected.",
  };
}

export function evaluate(
  deftRoot: string,
  projectRoot: string,
): { exitCode: 0 | 1; results: CheckResult[] } {
  const results = [
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
      "migrate:preflight FAILED -- pre-v0.20 document model or incomplete vBRIEF layout. Resolve using UPGRADING.md § Frozen pre-v0.20 document-model migration (#2068).\n",
    );
  } else {
    io.writeOut("migrate:preflight OK -- no pre-v0.20 document-model migration required.\n");
  }
  return outcome.exitCode;
}
