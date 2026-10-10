/** Thin CLI wrapper for project-render (mirrors ``scripts/project_render.py``). */
import { projectRenderMain } from "@deftai/directive-core/render";

export function runProjectRenderCli(argv: readonly string[]): number {
  return projectRenderMain(argv);
}
