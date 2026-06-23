/** Thin CLI wrapper for prd-render (mirrors ``scripts/prd_render.py``). */
import { parsePrdArgv, prdRenderMain } from "@deftai/directive-core/render";

export function runPrdRenderCli(argv: readonly string[]): number {
  prdRenderMain(parsePrdArgv(argv));
  return 0;
}
