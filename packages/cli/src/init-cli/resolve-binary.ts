import { accessSync, constants as fsConstants } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** Resolve @deftai/directive package root from a compiled init-cli module URL. */
export function cliPackageRoot(fromModuleUrl: string = import.meta.url): string {
  return join(dirname(fileURLToPath(fromModuleUrl)), "..", "..");
}

/** Release artifact basename for the current platform (#11 bundled layout). */
export function releaseArtifactName(platform: NodeJS.Platform, arch: string): string {
  const normalizedArch = arch === "x64" ? "amd64" : arch === "arm64" ? "arm64" : arch;
  switch (platform) {
    case "win32":
      return `install-windows-${normalizedArch}.exe`;
    case "darwin":
      return `install-macos-${normalizedArch}`;
    case "linux":
      return `install-linux-${normalizedArch}`;
    default:
      return `install-${platform}-${normalizedArch}`;
  }
}

/** Ordered search paths for the bundled deft-install binary. */
export function bundledBinaryCandidates(
  packageRoot: string,
  platform: NodeJS.Platform,
  arch: string,
): readonly string[] {
  const artifact = releaseArtifactName(platform, arch);
  const genericName = platform === "win32" ? "deft-install.exe" : "deft-install";
  return [
    join(packageRoot, "vendor", "deft-install", artifact),
    join(packageRoot, "vendor", "deft-install", genericName),
  ];
}

function isReadableFile(path: string): boolean {
  try {
    accessSync(path, fsConstants.R_OK);
    return true;
  } catch {
    return false;
  }
}

export interface ResolveBinaryOptions {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  arch?: string;
  packageRoot?: string;
  moduleUrl?: string;
}

/** Locate the bundled deft-install binary or an explicit DEFT_INSTALL_BINARY override. */
export function resolveBundledDeftInstallBinary(options: ResolveBinaryOptions = {}): string | null {
  const env = options.env ?? process.env;
  const override = env.DEFT_INSTALL_BINARY?.trim();
  if (override !== undefined && override.length > 0) {
    return isReadableFile(override) ? override : null;
  }

  const packageRoot = options.packageRoot ?? cliPackageRoot(options.moduleUrl ?? import.meta.url);
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;

  for (const candidate of bundledBinaryCandidates(packageRoot, platform, arch)) {
    if (isReadableFile(candidate)) {
      return candidate;
    }
  }
  return null;
}

export function missingBinaryMessage(
  verb: "init" | "update",
  packageRoot: string,
  platform: NodeJS.Platform,
  arch: string,
): string {
  const expected = bundledBinaryCandidates(packageRoot, platform, arch)[0];
  return (
    `directive ${verb}: bundled deft-install binary not found (expected ${expected}).\n` +
    "Download a platform installer from https://github.com/deftai/directive/releases " +
    "or set DEFT_INSTALL_BINARY to the absolute path of deft-install."
  );
}
