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

/** Published runtime that may hoist content at its package root (AC1.3 / PKG-AC13). */
export const RUNTIME_PACKAGE_NAME = "@deftai/directive-runtime";

const CONTENT_ROOT_PACKAGE_NAMES = new Set([CONTENT_PACKAGE_NAME, RUNTIME_PACKAGE_NAME]);

/** Thrown when {@link resolveInstalledContentRoot} cannot resolve the content package. */
export class ContentPackageNotFoundError extends Error {
  override readonly name = "ContentPackageNotFoundError";
}

type ResolveSpecifier = (specifier: string) => Promise<string>;

async function defaultResolveSpecifier(specifier: string): Promise<string> {
  return fileURLToPath(await import.meta.resolve(specifier));
}

/**
 * Walk upward from `resolvedEntry` until a `package.json` names the private
 * content package or the published runtime (content hoisted into runtime);
 * returns that directory.
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
          CONTENT_ROOT_PACKAGE_NAMES.has(String((parsed as { name?: string }).name ?? ""))
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
    `Resolved content entry at ${resolvedEntry}, but no matching package root was found. ` +
      "Reinstall with `npm i @deftai/directive-runtime` (or `pnpm add @deftai/directive-content`).",
  );
}

/**
 * Resolve the installed content root via Node module resolution.
 *
 * Prefers the private {@link CONTENT_PACKAGE_NAME} when present (workspace /
 * legacy). Falls back to {@link RUNTIME_PACKAGE_NAME} when content is hoisted
 * into the published runtime package (AC1.3). Resolves `package.json` subpaths
 * rather than bare specifiers (#2023).
 */
export async function resolveInstalledContentRoot(
  resolveSpecifier: ResolveSpecifier = defaultResolveSpecifier,
): Promise<string> {
  const candidates = [
    `${CONTENT_PACKAGE_NAME}/package.json`,
    `${RUNTIME_PACKAGE_NAME}/package.json`,
  ];
  let lastDetail = "";
  for (const specifier of candidates) {
    try {
      const resolvedEntry = await resolveSpecifier(specifier);
      return contentPackageRootFromResolvedEntry(resolvedEntry);
    } catch (cause) {
      lastDetail = cause instanceof Error ? cause.message : String(cause);
    }
  }
  throw new ContentPackageNotFoundError(
    `Neither ${CONTENT_PACKAGE_NAME} nor ${RUNTIME_PACKAGE_NAME} could be resolved for content. ` +
      "Install `@deftai/directive-runtime` (or the private content package in a workspace) " +
      "so init/update can deposit framework content locally. " +
      `Resolution error: ${lastDetail}`,
  );
}
