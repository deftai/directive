/**
 * resolve-content.ts — resolve the installed @deftai/directive-content package root.
 *
 * Used by the TS-native init/update deposit path (#1942 S1) to locate the npm
 * content package before copying its tree into `.deft/core/`. Mirrors the
 * package-resolution half of the Go installer's content fetch, but reads from
 * the local node_modules install instead of a GitHub tarball.
 *
 * Refs #1942, #11, #1477.
 */

import { readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const CONTENT_PACKAGE_NAME = "@deftai/directive-content";

/** Thrown when {@link resolveInstalledContentRoot} cannot resolve the content package. */
export class ContentPackageNotFoundError extends Error {
  override readonly name = "ContentPackageNotFoundError";
}

type ResolveSpecifier = (specifier: string) => Promise<string>;

async function defaultResolveSpecifier(specifier: string): Promise<string> {
  return fileURLToPath(await import.meta.resolve(specifier));
}

/**
 * Walk upward from `resolvedEntry` until a `package.json` names
 * {@link CONTENT_PACKAGE_NAME}; returns that directory.
 */
export function contentPackageRootFromResolvedEntry(resolvedEntry: string): string {
  let dir = statSync(resolvedEntry).isDirectory() ? resolvedEntry : dirname(resolvedEntry);
  for (;;) {
    const pkgJsonPath = join(dir, "package.json");
    try {
      if (statSync(pkgJsonPath).isFile()) {
        const parsed: unknown = JSON.parse(readFileSync(pkgJsonPath, "utf8"));
        if (
          typeof parsed === "object" &&
          parsed !== null &&
          (parsed as { name?: string }).name === CONTENT_PACKAGE_NAME
        ) {
          return dir;
        }
      }
    } catch {
      // Missing or unreadable package.json — keep walking.
    }
    const parent = dirname(dir);
    if (parent === dir) {
      break;
    }
    dir = parent;
  }
  throw new ContentPackageNotFoundError(
    `Resolved ${CONTENT_PACKAGE_NAME} entry at ${resolvedEntry}, but no matching package root was found. ` +
      "Reinstall with `pnpm add @deftai/directive-content` or `npm i @deftai/directive-content`.",
  );
}

/**
 * Resolve the installed {@link CONTENT_PACKAGE_NAME} package root via Node module
 * resolution (`import.meta.resolve`).
 */
export async function resolveInstalledContentRoot(
  resolveSpecifier: ResolveSpecifier = defaultResolveSpecifier,
): Promise<string> {
  let resolvedEntry: string;
  try {
    resolvedEntry = await resolveSpecifier(CONTENT_PACKAGE_NAME);
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    throw new ContentPackageNotFoundError(
      `${CONTENT_PACKAGE_NAME} is not installed or could not be resolved. ` +
        "Install it with `pnpm add @deftai/directive-content` or `npm i @deftai/directive-content` " +
        "so init/update can deposit framework content locally. " +
        `Resolution error: ${detail}`,
    );
  }
  return contentPackageRootFromResolvedEntry(resolvedEntry);
}
