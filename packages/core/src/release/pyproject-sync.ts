import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { updatePyprojectVersion } from "./pyproject.js";
import type { ReleaseSeams } from "./types.js";
import { NonPublishableVersionError, toPep440 } from "./version.js";

export function syncPyprojectForRelease(
  pyprojectPath: string,
  version: string,
  options: { dryRun: boolean },
  seams: ReleaseSeams = {},
): [string, string | null] {
  const exists =
    seams.fileExists ??
    ((p: string) => {
      try {
        return existsSync(p) && statSync(p).isFile();
      } catch {
        return false;
      }
    });
  const read = seams.readFile ?? ((p: string) => readFileSync(p, "utf8"));

  if (!exists(pyprojectPath)) {
    return ["no pyproject.toml; skipping sync", null];
  }

  let pepVersion: string;
  try {
    pepVersion = toPep440(version);
  } catch (err) {
    if (err instanceof NonPublishableVersionError) {
      return [`non-publishable tag (${err.message}); skipping pyproject sync`, null];
    }
    if (err instanceof Error) {
      return [`FAIL (cannot normalize version to PEP 440: ${err.message})`, null];
    }
    return [`FAIL (cannot normalize version to PEP 440: ${String(err)})`, null];
  }

  const original = read(pyprojectPath);
  let newText: string;
  try {
    newText = updatePyprojectVersion(original, pepVersion);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return [`FAIL (pyproject.toml: ${msg})`, null];
  }

  if (newText === original) {
    return [`pyproject already at ${pepVersion}`, null];
  }
  if (options.dryRun) {
    return [`pyproject [project].version -> ${pepVersion}`, null];
  }
  return [`pyproject [project].version -> ${pepVersion}`, newText];
}

export function pyprojectPathFor(projectRoot: string): string {
  return join(projectRoot, "pyproject.toml");
}
