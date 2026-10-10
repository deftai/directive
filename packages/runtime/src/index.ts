import { identityBanner } from "./identity-banner.js";

/**
 * `@deftai/directive` — entrypoint for the deft directive TypeScript engine.
 *
 * Wave-1 skeleton (#1717): `banner()` spans the full dependency chain
 * (cli → core → types), proving the project-reference graph builds and
 * resolves end-to-end. Real commands land in later migration waves.
 */

export { CLI_PACKAGE } from "./identity-banner.js";

/** Renders CLI package and engine identity. First semver is the engine (#4766). */
export function banner(): string {
  return identityBanner();
}
