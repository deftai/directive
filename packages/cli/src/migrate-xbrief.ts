#!/usr/bin/env node
import { fileURLToPath } from "node:url";
import { resolveFrameworkRootForProject } from "@deftai/directive-core/doctor";
import { runXbriefMigrationCli } from "@deftai/directive-core/xbrief-migrate";

export interface ParsedMigrateXbriefArgs {
  projectRoot: string;
  frameworkRoot: string;
  force: boolean;
  error?: string;
}

export function parseArgs(argv: readonly string[]): ParsedMigrateXbriefArgs {
  let projectRoot = ".";
  let explicitFrameworkRoot: string | undefined;
  let force = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] ?? "";
    if (arg === "--force") {
      force = true;
    } else if (arg === "--project-root") {
      const value = argv[i + 1];
      if (value === undefined) {
        return {
          projectRoot,
          frameworkRoot: resolveFrameworkRootForProject(projectRoot, explicitFrameworkRoot),
          force,
          error: "argument --project-root: expected one argument",
        };
      }
      projectRoot = value;
      i += 1;
    } else if (arg.startsWith("--project-root=")) {
      projectRoot = arg.slice("--project-root=".length);
    } else if (arg === "--framework-root") {
      const value = argv[i + 1];
      if (value === undefined) {
        return {
          projectRoot,
          frameworkRoot: resolveFrameworkRootForProject(projectRoot, explicitFrameworkRoot),
          force,
          error: "argument --framework-root: expected one argument",
        };
      }
      explicitFrameworkRoot = value;
      i += 1;
    } else if (arg.startsWith("--framework-root=")) {
      explicitFrameworkRoot = arg.slice("--framework-root=".length);
    } else {
      return {
        projectRoot,
        frameworkRoot: resolveFrameworkRootForProject(projectRoot, explicitFrameworkRoot),
        force,
        error: `unrecognized argument: ${arg}`,
      };
    }
  }

  const frameworkRoot = resolveFrameworkRootForProject(projectRoot, explicitFrameworkRoot);
  return { projectRoot, frameworkRoot, force };
}

export function run(argv: readonly string[]): number {
  const args = parseArgs(argv);
  if (args.error !== undefined) {
    process.stderr.write(`migrate:xbrief: ${args.error}\n`);
    return 2;
  }

  return runXbriefMigrationCli(
    {
      projectRoot: args.projectRoot,
      frameworkRoot: args.frameworkRoot,
      force: args.force,
    },
    {
      writeOut: (text) => {
        process.stdout.write(text);
      },
      writeErr: (text) => {
        process.stderr.write(text);
      },
    },
  );
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exit(run(process.argv.slice(2)));
}
