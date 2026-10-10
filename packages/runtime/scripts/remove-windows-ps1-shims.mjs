/**
 * postinstall entry (#4654). The published tarball includes dist/.
 * A workspace install before tsc has no linked shims yet, so a missing
 * dist file is a no-op rather than a failed install.
 */
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const pkgDir = dirname(dirname(fileURLToPath(import.meta.url)));
const entry = join(pkgDir, "dist", "windows-bin-ps1.js");

if (existsSync(entry)) {
  const mod = await import(pathToFileURL(entry).href);
  const result = mod.removeInstalledWindowsPs1Shims({
    pkgDir,
    env: process.env,
    platform: process.platform,
  });
  if (result.failed.length > 0) {
    process.stderr.write(
      `remove-windows-ps1-shims: could not remove ${result.failed.join(", ")}\n`,
    );
    process.exitCode = 1;
  }
}
