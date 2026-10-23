import { capabilityMapMain } from "@deftai/directive-core/dist/docs/capability-map.js";

/** Thin dispatch wrapper for `capability-map` (#5841); mirrors rule-map-cli. */
export function runCapabilityMapCli(argv: readonly string[]): number {
  return capabilityMapMain(argv);
}
