import { engineInfo } from "@deftai/directive-core";
import { readCliPackageVersion } from "./cli-package-version.js";

export const CLI_PACKAGE = "@deftai/directive" as const;

export interface IdentityBannerParts {
  readonly cliVersion: string;
  readonly engineName: string;
  readonly engineVersion: string;
}

/**
 * Display-both identity line. Engine semver is first so parseVersionFromOutput
 * in active-cli.ts and classify.ts still treat --version as the engine.
 */
export function formatIdentityBanner(parts: IdentityBannerParts): string {
  return `${CLI_PACKAGE} (engine: ${parts.engineName}@${parts.engineVersion}; package: ${CLI_PACKAGE}@${parts.cliVersion})`;
}

export function identityBanner(): string {
  const info = engineInfo();
  return formatIdentityBanner({
    cliVersion: readCliPackageVersion(),
    engineName: info.name,
    engineVersion: info.version,
  });
}
