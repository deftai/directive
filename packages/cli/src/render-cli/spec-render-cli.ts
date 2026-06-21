/** Thin CLI wrapper for spec-render (mirrors ``scripts/spec_render.py``). */
import { specRenderMain } from "@deftai/core/render";

export function runSpecRenderCli(argv: readonly string[]): number {
  return specRenderMain(argv);
}
