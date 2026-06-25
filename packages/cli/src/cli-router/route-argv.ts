/**
 * Maps `directive <namespace> <verb>` argv to flat dispatcher verbs (#1670 / #11 S3).
 * Mirrors the `task <namespace>:<verb>` surface one-to-one.
 */

import { resolveCanonicalVerb } from "../dispatch.js";

/** Top-level UX verbs promoted above the namespace layer (#1670). */
export const TOP_LEVEL_UX_VERBS = [
  "init",
  "update",
  "migrate",
  "bootstrap",
  "check",
  "doctor",
  "version",
  "feature",
] as const;

/** Stubbed until a later story lands the handler (#1670 / #11). */
export const STUBBED_TOP_LEVEL_VERBS = new Set<string>([]);

/** Registered but not yet implemented as TS handlers. */
export const DEFERRED_TOP_LEVEL_VERBS = new Set<string>(["bootstrap", "feature"]);

/** scope:* lifecycle verbs routed through scope-lifecycle handler. */
export const SCOPE_LIFECYCLE_VERBS = new Set([
  "promote",
  "activate",
  "complete",
  "fail",
  "cancel",
  "restore",
  "block",
  "unblock",
]);

/** pr:* task names that do not hyphenate 1:1 to handler stems. */
export const PR_VERB_MAP: Readonly<Record<string, string>> = {
  "merge-ready": "pr-merge-readiness",
  "check-protected-issues": "pr-protected-issues",
  "check-closing-keywords": "pr-closing-keywords",
  "wait-mergeable-and-merge": "pr-wait-mergeable",
};

/** verify:* aliases that map to non-verify-* handler stems. */
export const VERIFY_VERB_MAP: Readonly<Record<string, string>> = {
  routing: "swarm-routing-verify",
  "codebase-map-fresh": "codebase-map-fresh",
  "strategy-output": "validate-strategy-output",
  "vbrief-conformance": "vbrief-validate",
  "destructive-gh-verbs": "preflight-gh",
  "cache-fresh": "preflight-cache",
  "pack-drift": "pack-render",
};

/** Namespace handlers that require a subcommand token after the handler stem. */
export const SUBCOMMAND_ROUTES: Readonly<Record<string, readonly [string, string]>> = {
  "triage:accept": ["triage-actions", "accept"],
  "triage:reject": ["triage-actions", "reject"],
  "triage:defer": ["triage-actions", "defer"],
  "triage:needs-ac": ["triage-actions", "needs-ac"],
  "triage:mark-duplicate": ["triage-actions", "mark-duplicate"],
  "triage:status": ["triage-actions", "status"],
  "triage:reset": ["triage-actions", "reset"],
  "triage:history": ["triage-actions", "history"],
  "triage:bulk-accept": ["triage-bulk", "accept"],
  "triage:bulk-reject": ["triage-bulk", "reject"],
  "triage:bulk-defer": ["triage-bulk", "defer"],
  "triage:bulk-needs-ac": ["triage-bulk", "needs-ac"],
  "triage:show": ["triage-queue", "show"],
  "triage:audit": ["triage-queue", "audit"],
  "cache:put": ["cache", "put"],
  "cache:get": ["cache", "get"],
  "cache:invalidate": ["cache", "invalidate"],
  "cache:fetch-all": ["cache", "fetch-all"],
  "cache:prune": ["cache", "prune"],
  "policy:show": ["policy", "show"],
  "policy:enforce-branches": ["policy", "enforce-branches"],
  "policy:allow-direct-commits": ["policy", "allow-direct-commits"],
  "vbrief:reconcile-graph": ["vbrief-reconcile", "graph"],
  "vbrief:reconcile-labels": ["vbrief-reconcile", "labels"],
  "vbrief:reconcile-umbrellas": ["vbrief-reconcile", "umbrellas"],
  "slice:record-existing": ["slice", "record-existing"],
  "slice:list": ["slice", "list"],
  "github-body:issue-create": ["github-body", "issue-create"],
  "github-body:issue-edit": ["github-body", "issue-edit"],
  "github-body:comment-create": ["github-body", "comment-create"],
  "github-body:comment-edit": ["github-body", "comment-edit"],
  "github-body:pr-edit": ["github-body", "pr-edit"],
};

export type RouteKind = "dispatch" | "stub";

export interface RoutedArgv {
  kind: RouteKind;
  argv: string[];
  stubMessage?: string;
}

function isMetaVerb(token: string): boolean {
  return token === "--help" || token === "-h" || token === "--version" || token === "-V";
}

function routeTopLevel(first: string, rest: string[]): RoutedArgv | null {
  if (first === "version") {
    return { kind: "dispatch", argv: ["--version", ...rest] };
  }
  if (first === "check" || first === "doctor") {
    return { kind: "dispatch", argv: [first, ...rest] };
  }
  if (first === "init" || first === "update" || first === "migrate") {
    return { kind: "dispatch", argv: [first, ...rest] };
  }
  if (STUBBED_TOP_LEVEL_VERBS.has(first)) {
    return {
      kind: "stub",
      argv: [],
      stubMessage: `directive ${first}: not yet implemented in the TS CLI (#1670 / #11).`,
    };
  }
  if (DEFERRED_TOP_LEVEL_VERBS.has(first)) {
    return {
      kind: "stub",
      argv: [],
      stubMessage: `directive ${first}: not yet implemented in the TS CLI (#1670 / #11).`,
    };
  }
  return null;
}

function routeSubcommandKey(ns: string, verb: string, rest: string[]): RoutedArgv | null {
  const colonKey = `${ns}:${verb}`;
  const mapped = SUBCOMMAND_ROUTES[colonKey];
  if (mapped !== undefined) {
    return { kind: "dispatch", argv: [...mapped, ...rest] };
  }
  return null;
}

function routeNamespaceVerb(ns: string, verb: string, rest: string[]): RoutedArgv | null {
  const colonKey = `${ns}:${verb}`;

  const subcommand = routeSubcommandKey(ns, verb, rest);
  if (subcommand !== null) return subcommand;

  if (resolveCanonicalVerb(colonKey) !== null) {
    return { kind: "dispatch", argv: [colonKey, ...rest] };
  }

  if (ns === "framework" && verb === "doctor") {
    return { kind: "dispatch", argv: ["doctor", ...rest] };
  }

  if (ns === "agents" && verb === "refresh") {
    return { kind: "dispatch", argv: ["agents-refresh", ...rest] };
  }

  if (ns === "scope") {
    if (SCOPE_LIFECYCLE_VERBS.has(verb)) {
      return { kind: "dispatch", argv: ["scope-lifecycle", verb, ...rest] };
    }
    if (verb === "demote") return { kind: "dispatch", argv: ["scope-demote", ...rest] };
    if (verb === "decompose") return { kind: "dispatch", argv: ["scope-decompose", ...rest] };
    if (verb === "undo") return { kind: "dispatch", argv: ["scope-undo", ...rest] };
  }

  if (ns === "pr") {
    const prStem = PR_VERB_MAP[verb];
    if (prStem !== undefined) {
      return { kind: "dispatch", argv: [prStem, ...rest] };
    }
  }

  if (ns === "verify") {
    const verifyStem = VERIFY_VERB_MAP[verb];
    if (verifyStem !== undefined) {
      return { kind: "dispatch", argv: [verifyStem, ...rest] };
    }
  }

  if (ns === "issue" && verb === "ingest") {
    return { kind: "dispatch", argv: ["issue-ingest", ...rest] };
  }
  if (ns === "issue" && verb === "emit") {
    return { kind: "dispatch", argv: ["issue-emit", ...rest] };
  }

  if (ns === "triage" && verb.startsWith("bulk-")) {
    return { kind: "dispatch", argv: ["triage-bulk", verb.slice("bulk-".length), ...rest] };
  }

  const hyphenStem = `${ns}-${verb}`;
  if (resolveCanonicalVerb(hyphenStem) !== null) {
    return { kind: "dispatch", argv: [hyphenStem, ...rest] };
  }

  return null;
}

function routeThreeToken(
  ns: string,
  verb: string,
  subverb: string,
  rest: string[],
): RoutedArgv | null {
  if (ns === "scm" && verb === "issue") {
    return { kind: "dispatch", argv: ["scm", "issue", subverb, ...rest] };
  }

  if (ns === "vbrief" && verb === "reconcile") {
    return { kind: "dispatch", argv: ["vbrief-reconcile", subverb, ...rest] };
  }

  if (ns === "policy" && verb === "set") {
    return { kind: "dispatch", argv: ["policy-set", subverb, ...rest] };
  }

  const compositeKey = `${ns}:${verb}-${subverb}`;
  const subcommand = SUBCOMMAND_ROUTES[compositeKey];
  if (subcommand !== undefined) {
    return { kind: "dispatch", argv: [...subcommand, ...rest] };
  }

  return null;
}

/**
 * Transform user-facing argv (`directive <ns> <verb>` or top-level UX) into
 * flat dispatcher argv consumed by `dispatch()`.
 */
export function routeArgv(argv: readonly string[]): RoutedArgv {
  if (argv.length === 0) {
    return { kind: "dispatch", argv: [] };
  }

  const [first, second, third, ...tail] = argv;
  if (first === undefined) {
    return { kind: "dispatch", argv: [] };
  }

  if (isMetaVerb(first) || first === "help") {
    return { kind: "dispatch", argv: [...argv] };
  }

  const topLevel = routeTopLevel(first, argv.slice(1));
  if (topLevel !== null) return topLevel;

  if (argv.length === 1 && resolveCanonicalVerb(first) !== null) {
    return { kind: "dispatch", argv: [first] };
  }

  if (second !== undefined) {
    const nsRoute = routeNamespaceVerb(
      first,
      second,
      third !== undefined ? [third, ...tail] : tail,
    );
    if (nsRoute !== null) return nsRoute;
  }

  if (second !== undefined && third !== undefined) {
    const threeToken = routeThreeToken(first, second, third, tail);
    if (threeToken !== null) return threeToken;
  }

  return { kind: "dispatch", argv: [...argv] };
}

/** Map `namespace:verb` task key to flat dispatcher argv (test seam). */
export function taskKeyToDispatchArgv(
  taskKey: string,
  rest: readonly string[] = [],
): string[] | null {
  const colon = taskKey.indexOf(":");
  if (colon <= 0) return null;
  const ns = taskKey.slice(0, colon);
  const verb = taskKey.slice(colon + 1);
  const routed = routeNamespaceVerb(ns, verb, [...rest]);
  return routed?.kind === "dispatch" ? routed.argv : null;
}
