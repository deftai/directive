/**
 * Thin CLI wrapper for spec-validate (mirrors ``scripts/spec_validate.py``).
 *
 * Supports `--project-root <dir>` to resolve the spec artifact via the layout
 * resolver (#2132), preferring `xbrief/specification.xbrief.json` on migrated
 * trees and falling back to `vbrief/specification.vbrief.json` on legacy trees.
 * A direct path positional arg is still accepted for backward compatibility.
 */
import { layout } from "@deftai/directive-core";
import { specValidateMain } from "@deftai/directive-core/render";

interface SpecValidateCliArgs {
  specPath: string | undefined;
  projectRoot: string | undefined;
}

function parseSpecValidateCliArgv(argv: readonly string[]): SpecValidateCliArgs {
  const positional: string[] = [];
  let projectRoot: string | undefined;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] ?? "";
    if (arg === "--project-root") {
      projectRoot = argv[i + 1];
      i += 1;
    } else if (arg.startsWith("--project-root=")) {
      projectRoot = arg.slice("--project-root=".length);
    } else {
      positional.push(arg);
    }
  }
  return { specPath: positional[0], projectRoot };
}

export function runSpecValidateCli(argv: readonly string[]): number {
  const { specPath, projectRoot } = parseSpecValidateCliArgv(argv);
  const resolved =
    projectRoot !== undefined ? layout.resolveSpecArtifactPath(projectRoot) : specPath;
  if (!resolved) {
    process.stderr.write("Usage: spec-validate [--project-root <dir>] [<spec_file>]\n");
    return 2;
  }
  return specValidateMain([resolved]);
}
