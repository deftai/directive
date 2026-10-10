/**
 * Thin CLI wrapper for spec-render (mirrors ``scripts/spec_render.py``).
 *
 * Supports `--project-root <dir>` to resolve the spec artifact via the layout
 * resolver (#2132), preferring `xbrief/specification.xbrief.json` on migrated
 * trees and falling back to `vbrief/specification.vbrief.json` on legacy trees.
 * Direct positional path args are still accepted for backward compatibility.
 */
import { join, resolve } from "node:path";
import { layout } from "@deftai/directive-core";
import { specRenderMain } from "@deftai/directive-core/render";

interface SpecRenderCliArgs {
  projectRoot: string | undefined;
  remaining: string[];
}

function parseSpecRenderCliArgv(argv: readonly string[]): SpecRenderCliArgs {
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

export function runSpecRenderCli(argv: readonly string[]): number {
  const { projectRoot, remaining } = parseSpecRenderCliArgv(argv);
  if (projectRoot !== undefined && remaining.filter((a) => !a.startsWith("--")).length === 0) {
    const specPath = layout.resolveSpecArtifactPath(projectRoot);
    const outPath = join(resolve(projectRoot), "SPECIFICATION.md");
    return specRenderMain([specPath, outPath, ...remaining]);
  }
  return specRenderMain(remaining);
}
