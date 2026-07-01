/**
 * Thin CLI wrapper for prd-render (mirrors ``scripts/prd_render.py``).
 *
 * Supports `--project-root <dir>` to resolve the spec artifact via the layout
 * resolver (#2132), preferring `xbrief/specification.xbrief.json` on migrated
 * trees and falling back to `vbrief/specification.vbrief.json` on legacy trees.
 * When `--spec` is explicitly provided it takes precedence over `--project-root`.
 * Direct `--spec` / `--output` / `--force` flags are still accepted unchanged.
 */
import { layout } from "@deftai/directive-core";
import { parsePrdArgv, prdRenderMain } from "@deftai/directive-core/render";

interface PrdRenderCliArgv {
  projectRoot: string | undefined;
  remaining: string[];
}

function parsePrdRenderCliArgv(argv: readonly string[]): PrdRenderCliArgv {
  const remaining: string[] = [];
  let projectRoot: string | undefined;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] ?? "";
    if (arg === "--project-root") {
      projectRoot = argv[i + 1];
      i += 1;
    } else if (arg.startsWith("--project-root=")) {
      projectRoot = arg.slice("--project-root=".length);
    } else {
      remaining.push(arg);
    }
  }
  return { projectRoot, remaining };
}

export function runPrdRenderCli(argv: readonly string[]): number {
  const { projectRoot, remaining } = parsePrdRenderCliArgv(argv);
  const parsedArgs = parsePrdArgv(remaining);
  const spec =
    parsedArgs.spec !== undefined
      ? parsedArgs.spec
      : projectRoot !== undefined
        ? layout.resolveSpecArtifactPath(projectRoot)
        : undefined;
  prdRenderMain({ ...parsedArgs, spec });
  return 0;
}
