import { defaultWhich, resolveBinary, type WhichFn } from "./binary.js";
import { ScmStubError } from "./errors.js";

/** Surfaces ghx may serve versus surfaces that must use live gh (#3737). */
export type ScmBinaryRole = "cached-get" | "live-gh";

/**
 * Classify an SCM argv for ghx eligibility.
 *
 * ghx is a cached read-only GET proxy that accepts a single positional path.
 * Extra positionals are rejected (`accepts 1 arg(s), received 2`). Flags
 * (`--method`, `--paginate`, `--jq`, `--input`, `-X`, ...) are not the cache
 * shape. Non-`api` verbs are live `gh`.
 */
export function classifyScmArgv(verb: string, args: readonly string[] = []): ScmBinaryRole {
  if (verb !== "api") {
    return "live-gh";
  }
  const positionals: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const token = args[i];
    if (token === undefined) {
      continue;
    }
    if (token === "--") {
      positionals.push(...args.slice(i + 1));
      break;
    }
    if (token.startsWith("-")) {
      return "live-gh";
    }
    positionals.push(token);
  }
  if (positionals.length !== 1) {
    return "live-gh";
  }
  return "cached-get";
}

/**
 * Resolve a binary for a classified role.
 *
 * cached-get uses the PATH ladder (`resolveBinary`, ghx then gh).
 * live-gh pins `gh` — the same preference as `resolveLiveGh`,
 * `resolveAuthProbeBinary`, and `GH_ONLY_WHICH`. If `gh` is absent, throw
 * rather than fall through to ghx (a mutation or flag-rich GET is not a
 * cache-proxy shape).
 */
export function resolveBinaryForRole(role: ScmBinaryRole, whichFn: WhichFn = defaultWhich): string {
  if (role === "live-gh") {
    if (whichFn("gh") !== null) {
      return "gh";
    }
    throw new ScmStubError(
      "gh not found on PATH; this call shape requires live gh, not the ghx cache proxy. " +
        "install GitHub CLI (https://cli.github.com/) or pass GH_TOKEN into a matched env and re-run. " +
        "Refs #3737 / #2275.",
    );
  }
  return resolveBinary(whichFn);
}

/** Classify argv then resolve. Compose with `resolveBinary`; do not probe health. */
export function resolveBinaryForArgv(
  verb: string,
  args: readonly string[] = [],
  whichFn: WhichFn = defaultWhich,
): string {
  return resolveBinaryForRole(classifyScmArgv(verb, args), whichFn);
}
