/**
 * Foreign runtime link diagnosis (#6185).
 *
 * A checkout whose `node_modules/@deftai/directive-runtime` is linked in from a
 * different checkout makes the hook take its launch root from the runtime's
 * real path, so every hooked call refuses as a root mismatch. Identity, not
 * containment: a runtime linked into a nested worker worktree is inside the
 * folder but still belongs to another checkout.
 *
 * Wording and early detection only. Nothing here admits a call; the root
 * check in the hook dispatcher stays exactly as strict.
 */

import { realpathSync } from "node:fs";
import { join, resolve } from "node:path";

/** Hook deny reason and doctor check name for a runtime linked in from another checkout. */
export const FOREIGN_RUNTIME_LINK = "foreign-runtime-link" as const;

/** Known runtime path under a checkout. Read directly; never discovered by a walk. */
const RUNTIME_REL = ["node_modules", "@deftai", "directive-runtime"] as const;

/**
 * Resolve the consumer project root that owns an installed runtime module path
 * (AC9.4 / AC9.5). Returns null when the path is not under
 * `node_modules/@deftai/directive-runtime` (monorepo source / vitest).
 */
export function resolveLaunchingCheckoutRootFromPath(modulePath: string): string | null {
  const normalized = modulePath.replace(/\\/g, "/");
  const needle = "/node_modules/@deftai/directive-runtime/";
  let before: string | null = null;
  const idx = normalized.lastIndexOf(needle);
  if (idx !== -1) {
    before = normalized.slice(0, idx);
  } else {
    const endNeedle = "/node_modules/@deftai/directive-runtime";
    if (normalized === endNeedle || normalized.endsWith(endNeedle)) {
      before = normalized.slice(0, normalized.length - endNeedle.length);
    }
  }
  if (before === null) return null;
  const pnpmMarker = "/node_modules/.pnpm/";
  const pnpmIdx = before.lastIndexOf(pnpmMarker);
  if (pnpmIdx !== -1) before = before.slice(0, pnpmIdx);
  return before.length > 0 ? before : null;
}

function realpathOrResolve(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

function sameCheckout(a: string, b: string): boolean {
  return realpathOrResolve(a) === realpathOrResolve(b);
}

export type RootMismatchKind = typeof FOREIGN_RUNTIME_LINK | "root-mismatch";

/**
 * Choose the wording for a root mismatch the hook already refuses. The cut of
 * the launcher's own (link-side) path equals the payload root while the
 * real-path launch root does not: the runtime is linked in from another
 * checkout. Every other mismatch is a plain root mismatch. Never an admit.
 */
export function classifyRootMismatch(
  launchRoot: string,
  linkSidePath: string | undefined,
  payloadRoot: string,
): RootMismatchKind {
  if (linkSidePath === undefined || linkSidePath === "") return "root-mismatch";
  const linkRoot = resolveLaunchingCheckoutRootFromPath(linkSidePath);
  if (linkRoot === null) return "root-mismatch";
  if (sameCheckout(linkRoot, payloadRoot) && !sameCheckout(launchRoot, payloadRoot)) {
    return FOREIGN_RUNTIME_LINK;
  }
  return "root-mismatch";
}

export interface RuntimeLinkOwnerResult {
  readonly name: typeof FOREIGN_RUNTIME_LINK;
  readonly status: "pass" | "fail" | "skip";
  readonly detail: string;
  readonly data?: Readonly<Record<string, unknown>>;
}

export interface RuntimeLinkOwnerSeams {
  /** Real path of the runtime directory; throws or returns null when absent. */
  readonly realpath?: (path: string) => string | null;
}

function defaultRealpath(path: string): string | null {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
}

/**
 * Direct check of `<checkout>/node_modules/@deftai/directive-runtime`: resolve
 * its real path, cut it to the owning checkout (pnpm normalisation included),
 * and fail when that is not this checkout. One path, no discovery walk. Skips
 * when the path is absent or its real path is not under a runtime package.
 */
export function checkRuntimeLinkOwner(
  checkoutRoot: string,
  seams: RuntimeLinkOwnerSeams = {},
): RuntimeLinkOwnerResult {
  const name = FOREIGN_RUNTIME_LINK;
  const runtimePath = join(checkoutRoot, ...RUNTIME_REL);
  const real = (seams.realpath ?? defaultRealpath)(runtimePath);
  if (real === null) {
    return { name, status: "skip", detail: "runtime not installed here -- owner check skipped." };
  }
  const owner = resolveLaunchingCheckoutRootFromPath(real);
  if (owner === null) {
    return {
      name,
      status: "skip",
      detail:
        "runtime real path is not under node_modules/@deftai/directive-runtime -- owner check skipped.",
    };
  }
  if (sameCheckout(owner, checkoutRoot)) {
    return { name, status: "pass", detail: "runtime belongs to this checkout." };
  }
  return {
    name,
    status: "fail",
    detail:
      `${runtimePath} resolves to ${real}, which belongs to another checkout (${owner}). ` +
      "Every hooked call here will refuse as a foreign runtime link. " +
      "Open a terminal outside the locked agent session, remove the link at " +
      `${join(checkoutRoot, "node_modules")} or ${runtimePath}, then install the runtime in ${checkoutRoot}.`,
    data: {
      checkout_root: checkoutRoot,
      runtime_path: runtimePath,
      real_path: real,
      owner_root: owner,
    },
  };
}
