import { engineInfo } from "@deftai/core";

/**
 * `@deftai/cli` — entrypoint for the deft directive TypeScript engine.
 *
 * Wave-1 skeleton (#1717): `banner()` spans the full dependency chain
 * (cli → core → types), proving the project-reference graph builds and
 * resolves end-to-end. Real commands land in later migration waves.
 */

export const CLI_PACKAGE = "@deftai/cli" as const;

/** Renders the engine banner string, sourcing core engine metadata. */
export function banner(): string {
  const info = engineInfo();
  return `${CLI_PACKAGE} (engine: ${info.name}@${info.version})`;
}
