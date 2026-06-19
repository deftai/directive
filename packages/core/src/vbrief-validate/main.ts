import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { evaluateConformance } from "./conformance.js";
import { USAGE } from "./constants.js";
import { validateAll } from "./validate-all.js";

export interface ValidateCliOptions {
  readonly vbriefDir?: string;
  readonly strictOriginTypes?: boolean;
  readonly warningsAsErrors?: boolean;
}

export interface ConformanceCliOptions {
  readonly mode?: "all" | "staged";
  readonly projectRoot?: string;
  readonly allowList?: string | null;
  readonly quiet?: boolean;
}

/** CLI entry for vbrief_validate.py parity. */
export function runValidate(argv: string[]): number {
  let vbriefDir = "vbrief";
  let strictOriginTypes = false;
  let warningsAsErrors = false;

  let i = 0;
  while (i < argv.length) {
    const arg = argv[i];
    if (arg === "--vbrief-dir" && i + 1 < argv.length) {
      vbriefDir = argv[i + 1] ?? vbriefDir;
      i += 2;
    } else if (arg === "--strict-origin-types") {
      strictOriginTypes = true;
      i += 1;
    } else if (arg === "--warnings-as-errors") {
      warningsAsErrors = true;
      i += 1;
    } else if (arg === "-h" || arg === "--help") {
      process.stdout.write(`${USAGE}\n`);
      return 0;
    } else {
      process.stderr.write(`Unknown argument: ${arg}\n`);
      process.stderr.write(`${USAGE}\n`);
      return 2;
    }
  }

  if (!existsSync(vbriefDir)) {
    process.stdout.write(`OK: No vbrief directory at ${vbriefDir} -- skipping validation\n`);
    return 0;
  }

  const { errors, warnings, scopeCount } = validateAll(vbriefDir, { strictOriginTypes });

  for (const w of warnings) {
    process.stdout.write(`WARN: ${w}\n`);
  }
  for (const e of errors) {
    process.stdout.write(`FAIL: ${e}\n`);
  }

  const warningsEscalated = warnings.length > 0 && warningsAsErrors;
  const exitCode = errors.length > 0 || warningsEscalated ? 1 : 0;

  if (exitCode === 0) {
    const parts: string[] = [];
    if (scopeCount > 0) {
      parts.push(`${scopeCount} scope vBRIEF(s)`);
    }
    const projectDef = resolve(vbriefDir, "PROJECT-DEFINITION.vbrief.json");
    if (existsSync(projectDef)) {
      parts.push("PROJECT-DEFINITION");
    }
    const summary = parts.length > 0 ? parts.join(", ") : "no vBRIEF files";
    const warningNote = warnings.length > 0 ? ` (${warnings.length} warning(s))` : "";
    process.stdout.write(`OK: vBRIEF validation passed: ${summary}${warningNote}\n`);
  } else {
    if (errors.length > 0) {
      process.stdout.write(`\nFAIL: ${errors.length} error(s) found\n`);
    }
    if (warningsEscalated && errors.length === 0) {
      process.stdout.write(
        `\nFAIL: ${warnings.length} warning(s) treated as errors (--warnings-as-errors)\n`,
      );
    }
  }

  return exitCode;
}

/** CLI entry for verify_vbrief_conformance.py parity. */
export function runConformance(argv: string[]): number {
  let mode: "all" | "staged" = "all";
  let projectRoot = ".";
  let allowList: string | null = null;
  let quiet = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--all") {
      mode = "all";
    } else if (arg === "--staged") {
      mode = "staged";
    } else if (arg === "--quiet") {
      quiet = true;
    } else if (arg === "--project-root") {
      projectRoot = argv[i + 1] ?? projectRoot;
      i += 1;
    } else if (arg === "--allow-list") {
      allowList = argv[i + 1] ?? null;
      i += 1;
    } else if (arg === "-h" || arg === "--help") {
      process.stdout.write(
        "usage: verify_vbrief_conformance [--all | --staged] [--project-root PATH] [--allow-list PATH] [--quiet]\n",
      );
      return 0;
    } else {
      process.stderr.write(`verify_vbrief_conformance: unrecognized argument: ${arg}\n`);
      return 2;
    }
  }

  const allowListPath = allowList !== null ? resolve(allowList) : null;
  const { exitCode, message } = evaluateConformance(resolve(projectRoot), {
    mode,
    allowListPath,
  });

  if (exitCode === 0) {
    if (!quiet) {
      process.stdout.write(`${message}\n`);
    }
  } else {
    process.stderr.write(`${message}\n`);
  }
  return exitCode;
}

export function cmdVbriefValidate(argv: string[]): number {
  if (argv[0] === "conformance") {
    return runConformance(argv.slice(1));
  }
  return runValidate(argv);
}
