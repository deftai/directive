/** Node/pnpm presence contract for TS-backed consumer gates (#1828 / #1530). */

export const NODE_RUNTIME_TOOL_NAMES = ["node", "pnpm"] as const;

export const NODE_RUNTIME_REMEDIATION =
  "Node.js and pnpm are required for TS-backed deft gates. Install Node 20+ (see .nvmrc), then run: corepack enable && corepack prepare pnpm@latest --activate. See UPGRADING.md § Node runtime.";

/** Append remediation lines when node or pnpm is among the missing tools. */
export function nodeRuntimeRemediationLines(failed: readonly string[]): readonly string[] {
  if (failed.some((name) => (NODE_RUNTIME_TOOL_NAMES as readonly string[]).includes(name))) {
    return [NODE_RUNTIME_REMEDIATION];
  }
  return [];
}
