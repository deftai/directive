#!/usr/bin/env node
/**
 * CLI for scope:record-observable-scope (#4495).
 *
 * Writes `.deft/observable-scope/<plan-id>.json` from `plan["x-directive/observableChange"]` with a declared stamp
 * (#7031): `{kind: "declared", actor, mintedAt, mintedVia: "scope:record-observable-scope"}`.
 * No terminal step: it writes from any shell, an agent's included. A declared
 * record is a declaration the product check holds the PR to, not an approval.
 * --actor is an optional declared-by name. The UAT refusal stays.
 */
import { existsSync, readFileSync } from "node:fs";
import { basename, relative, resolve } from "node:path";
import {
  buildObservableScopeRecord,
  extractObservableChangeFromPlan,
  parseObservableChangeContract,
  writeObservableScopeRecord,
} from "@deftai/directive-core/observable-scope";
import { decideSignedWrite, resolveCliSignedLevel, signedLevelUsage } from "./approvers-link.js";
import { isDirectEntrypoint } from "./entrypoint.js";
import { refuseMintWhileUatActive } from "./human-presence-mint.js";
import { isPathInsideRoot } from "./scope-record-approved-scope.js";
import { type RecordCohortSeams, runRecordCohort } from "./scope-record-cohort.js";

export interface ParsedArgs {
  projectRoot: string;
  xbriefPath: string;
  /** Every brief path given; two or more select the cohort form (#6937). */
  xbriefPaths: string[];
  /** Launch-manifest path for the cohort form (#6937). */
  manifest: string | null;
  /** Declared-by display name; may name an agent (#7031). */
  actor: string;
  quiet: boolean;
  /** Signed level: print the ceremony link and write nothing (#6945). */
  request: boolean;
  /** Signed level: the page's assertion blob (#6945). */
  assertion: string | null;
  help?: boolean;
  error?: string;
}

/** The verb, recorded as mintedVia on every record it writes (#7031). */
const WRITER_VERB = "scope:record-observable-scope";
/** Declared-by name when --actor is not given (#7031). */
const DEFAULT_DECLARED_BY = "unspecified";
/** Flags refused because the stamp is always declared (#7031). */
const REFUSED_FLAGS = ["--kind", "--minted-via"] as const;

function usage(): string {
  return (
    "usage: scope:record-observable-scope -- <xbrief-path> [<xbrief-path> ...] | --manifest <launch-manifest> " +
    "[--actor <declared-by>] [--project-root <dir>] [--quiet]\n" +
    '  Writes .deft/observable-scope/<plan-id>.json from plan["x-directive/observableChange"].\n' +
    "  Declared record (#7031): no terminal step; it writes from any shell, an agent's included, " +
    "with humanApproval {kind: declared, mintedVia: scope:record-observable-scope}. --kind and --minted-via are " +
    "refused. --actor is an optional declared-by name and may name an agent. A declared record is " +
    "a declaration the product check holds the PR to, not consent. Land it on the delivery-branch " +
    "merge base before the UI-change PR (a record PR, or the activation PR that adds its brief), then " +
    "rebase the implementation branch; same-PR working-tree-only records are not authoritative. " +
    "Refused during an active UAT lease.\n" +
    "  Cohort form (#6937): several brief paths or --manifest (launch-manifest xbrief_path entries) " +
    "print every record first and write only new records. A matching record is left as it is; one " +
    "that would change, or does not parse, refuses the whole set (change it with the one-path form). " +
    "Records may ride in the activation PR when each matches a brief that PR adds. The record's " +
    "control is the merge that lands it.\n" +
    signedLevelUsage()
  );
}

function extractPlanId(payload: unknown): string | null {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) return null;
  const plan = (payload as Record<string, unknown>).plan;
  if (plan === null || typeof plan !== "object" || Array.isArray(plan)) return null;
  const id = (plan as Record<string, unknown>).id;
  return typeof id === "string" && id.trim().length > 0 ? id.trim() : null;
}

export function parseArgs(argv: string[]): ParsedArgs {
  const parsed: ParsedArgs = {
    projectRoot: ".",
    xbriefPath: "",
    xbriefPaths: [],
    manifest: null,
    actor: DEFAULT_DECLARED_BY,
    quiet: false,
    request: false,
    assertion: null,
  };
  const positionals: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--") continue;
    if (arg === "--help" || arg === "-h") return { ...parsed, help: true };
    if (arg === "--quiet") parsed.quiet = true;
    // Accepted and ignored: there is no terminal step to confirm (#7031).
    else if (arg === "--confirm") continue;
    else if (REFUSED_FLAGS.some((flag) => arg === flag || arg?.startsWith(`${flag}=`))) {
      return {
        ...parsed,
        error:
          `argument ${arg?.split("=")[0]} is not accepted: this command always writes kind declared ` +
          `with mintedVia ${WRITER_VERB} (#7031)\n${usage()}`,
      };
    } else if (arg === "--project-root") {
      const value = argv[i + 1];
      if (value === undefined)
        return { ...parsed, error: "argument --project-root: expected one argument" };
      parsed.projectRoot = value;
      i += 1;
    } else if (arg?.startsWith("--project-root=")) {
      parsed.projectRoot = arg.slice("--project-root=".length);
    } else if (arg === "--manifest") {
      const value = argv[i + 1];
      if (value === undefined)
        return { ...parsed, error: "argument --manifest: expected one argument" };
      parsed.manifest = value;
      i += 1;
    } else if (arg?.startsWith("--manifest=")) {
      parsed.manifest = arg.slice("--manifest=".length);
    } else if (arg === "--request") {
      parsed.request = true;
    } else if (arg === "--assertion") {
      const value = argv[i + 1];
      if (value === undefined) {
        return { ...parsed, error: "argument --assertion: expected one argument" };
      }
      parsed.assertion = value;
      i += 1;
    } else if (arg?.startsWith("--assertion=")) {
      parsed.assertion = arg.slice("--assertion=".length);
    } else if (arg === "--actor") {
      const value = argv[i + 1];
      if (value === undefined)
        return { ...parsed, error: "argument --actor: expected one argument" };
      parsed.actor = value;
      i += 1;
    } else if (arg?.startsWith("--actor=")) {
      parsed.actor = arg.slice("--actor=".length);
    } else if (arg?.startsWith("-")) {
      return { ...parsed, error: `unrecognized argument: ${arg}` };
    } else if (arg !== undefined) {
      positionals.push(arg);
    }
  }
  if (parsed.help) return parsed;
  if (parsed.manifest !== null && positionals.length > 0) {
    return { ...parsed, error: `give brief paths or --manifest, not both\n${usage()}` };
  }
  if (positionals.length === 0 && parsed.manifest === null) {
    return { ...parsed, error: `missing xBRIEF path\n${usage()}` };
  }
  parsed.xbriefPaths = positionals;
  parsed.xbriefPath = positionals[0] ?? "";
  parsed.actor = parsed.actor.trim().length > 0 ? parsed.actor.trim() : DEFAULT_DECLARED_BY;
  if (parsed.request && parsed.assertion !== null) {
    return { ...parsed, error: `pass --request or --assertion, not both\n${usage()}` };
  }
  return parsed;
}

export function run(argv: string[], seams: RecordCohortSeams = {}): number {
  const args = parseArgs(argv);
  if (args.help) {
    process.stdout.write(`${usage()}\n`);
    return 0;
  }
  if (args.error !== undefined) {
    process.stderr.write(`scope_record_observable_scope: ${args.error}\n`);
    return 2;
  }
  const level = seams.approvalLevel ?? resolveCliSignedLevel(resolve(args.projectRoot));
  const decision = decideSignedWrite(level, args.request, args.assertion);
  if (decision.kind === "refuse") {
    process.stderr.write(`scope_record_observable_scope: ${decision.message}\n`);
    return decision.code;
  }
  if (decision.kind === "request" || decision.kind === "assertion") {
    return runRecordCohort(
      "observable-scope",
      {
        projectRoot: args.projectRoot,
        briefPaths: args.xbriefPaths,
        manifest: args.manifest,
        actor: args.actor,
        quiet: args.quiet,
        signed: {
          level: decision.level,
          phase: decision.kind,
          approval: decision.kind === "assertion" ? decision.approval : undefined,
        },
      },
      seams,
    );
  }
  if (args.manifest !== null || args.xbriefPaths.length > 1) {
    return runRecordCohort(
      "observable-scope",
      {
        projectRoot: args.projectRoot,
        briefPaths: args.xbriefPaths,
        manifest: args.manifest,
        actor: args.actor,
        quiet: args.quiet,
      },
      seams,
    );
  }
  const projectRoot = resolve(args.projectRoot);
  const uat = refuseMintWhileUatActive("scope:record-observable-scope", projectRoot);
  if (uat !== null) return uat;
  const xbriefAbs = resolve(projectRoot, args.xbriefPath);
  const fullPath = existsSync(xbriefAbs) ? xbriefAbs : resolve(args.xbriefPath);
  if (!existsSync(fullPath)) {
    process.stderr.write(`scope_record_observable_scope: xBRIEF not found: ${args.xbriefPath}\n`);
    return 2;
  }
  if (!isPathInsideRoot(projectRoot, fullPath)) {
    process.stderr.write("scope_record_observable_scope: xBRIEF path escapes --project-root.\n");
    return 2;
  }

  let payload: unknown;
  const rawText = readFileSync(fullPath, "utf8");
  try {
    payload = JSON.parse(rawText) as unknown;
  } catch (err: unknown) {
    process.stderr.write(`scope_record_observable_scope: invalid JSON: ${String(err)}\n`);
    return 2;
  }
  const planId = extractPlanId(payload) ?? basename(fullPath, ".xbrief.json");
  const contract = parseObservableChangeContract(extractObservableChangeFromPlan(payload));
  if ("error" in contract) {
    process.stderr.write(`scope_record_observable_scope: ${contract.error}\n`);
    return 2;
  }
  const rel = relative(projectRoot, fullPath).replace(/\\/g, "/");
  const rec = buildObservableScopeRecord({
    planId,
    xbriefRelPath: rel.startsWith("xbrief/pending/") ? `xbrief/active/${basename(rel)}` : rel,
    allowedChanges: contract.allowedChanges,
    mustPreserve: contract.mustPreserve,
    changeKind: contract.changeKind,
    humanApproval: {
      kind: "declared",
      actor: args.actor,
      mintedAt: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
      mintedVia: WRITER_VERB,
    },
  });
  if ("error" in rec) {
    process.stderr.write(`scope_record_observable_scope: ${rec.error}\n`);
    return 2;
  }
  const path = writeObservableScopeRecord(projectRoot, rec);
  if (!args.quiet) {
    process.stdout.write(
      `Wrote ${path} (kind declared, declared by ${args.actor}).\n` +
        "A declared record is a declaration, not consent (#7031). Land it on the merge base before " +
        "the UI-change PR. Write it after the observableChange contract is authored, not at parking " +
        "(#4588; predecessor #4383).\n",
    );
  }
  return 0;
}

if (isDirectEntrypoint(import.meta.url)) {
  process.exit(run(process.argv.slice(2)));
}
