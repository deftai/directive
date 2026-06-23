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

function accessMode(platform: NodeJS.Platform): number {
  return platform === "win32" ? fsConstants.R_OK : fsConstants.R_OK | fsConstants.X_OK;
}

function isRunnableBinary(path: string, platform: NodeJS.Platform): boolean {
  try {
    accessSync(path, accessMode(platform));
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

export type ResolveBinaryResult =
  | { ok: true; path: string }
  | { ok: false; reason: "not-found"; packageRoot: string; platform: NodeJS.Platform; arch: string }
  | { ok: false; reason: "override-unreadable"; path: string };

/** Locate the bundled deft-install binary or an explicit DEFT_INSTALL_BINARY override. */
export function resolveBundledDeftInstallBinaryDetailed(
  options: ResolveBinaryOptions = {},
): ResolveBinaryResult {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  const packageRoot = options.packageRoot ?? cliPackageRoot(options.moduleUrl ?? import.meta.url);

  const override = env.DEFT_INSTALL_BINARY?.trim();
  if (override !== undefined && override.length > 0) {
    if (isRunnableBinary(override, platform)) {
      return { ok: true, path: override };
    }
    return { ok: false, reason: "override-unreadable", path: override };
  }

  for (const candidate of bundledBinaryCandidates(packageRoot, platform, arch)) {
    if (isRunnableBinary(candidate, platform)) {
      return { ok: true, path: candidate };
    }
  }

  return { ok: false, reason: "not-found", packageRoot, platform, arch };
}

/** Back-compat helper returning only the resolved path. */
export function resolveBundledDeftInstallBinary(options: ResolveBinaryOptions = {}): string | null {
  const resolved = resolveBundledDeftInstallBinaryDetailed(options);
  return resolved.ok ? resolved.path : null;
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

export function overrideUnreadableMessage(verb: "init" | "update", path: string): string {
  return (
    `directive ${verb}: DEFT_INSTALL_BINARY is set to ${path} but the path is missing or not executable.\n` +
    "Fix the path or download a platform installer from https://github.com/deftai/directive/releases."
  );
}
