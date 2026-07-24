import { ruleMapMain } from "@deftai/directive-core/render";

export function runRuleMapCli(argv: readonly string[]): number {
  return ruleMapMain(argv);
}
