/**
 * Thin CLI wrapper for prd-render (mirrors ``scripts/prd_render.py``).
 *
 * Supports `--project-root <dir>` to resolve full-spec or greenfield authority
 * through the shared authority resolver (#2132 / #3598).
 * When `--spec` is explicitly provided it takes precedence over `--project-root`.
 * Direct `--spec` / `--output` / `--force` flags are still accepted unchanged.
 */
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
  prdRenderMain({
    ...parsedArgs,
    projectRoot: projectRoot ?? parsedArgs.projectRoot,
  });
  return 0;
}
