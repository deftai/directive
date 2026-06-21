/** Thin CLI wrapper for spec-validate (mirrors ``scripts/spec_validate.py``). */
import { specValidateMain } from "@deftai/core/render";

export function runSpecValidateCli(argv: readonly string[]): number {
  return specValidateMain(argv);
}
