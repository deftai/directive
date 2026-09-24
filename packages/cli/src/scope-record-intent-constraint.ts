#!/usr/bin/env node
/**
 * CLI for scope:record-intent-constraint (#4541).
 *
 * Human-presence mint of `.deft/intent-constraint/<plan-id>.json` from
 * `plan["x-directive/intentConstraint"]`. --actor is display-only.
 */
import { existsSync, readFileSync } from "node:fs";
import { basename, relative, resolve } from "node:path";
import {
  buildIntentConstraintRecord,
  extractIntentConstraintFromPlan,
  parseIntentConstraintContract,
  writeIntentConstraintRecord,
} from "@deftai/directive-core/intent-constraint";
import { isDirectEntrypoint } from "./entrypoint.js";
import {
  type HumanPresenceMintSeams,
  refuseMintWhileUatActive,
  refuseNonInteractiveMint,
  resolveHumanPresenceMintSeams,
} from "./human-presence-mint.js";
import { isPathInsideRoot } from "./scope-record-approved-scope.js";

export interface ParsedArgs {
  projectRoot: string;
  xbriefPath: string;
  actor: string;
  kind: string;
  mintedVia: string;
  quiet: boolean;
  confirm: boolean;
  help?: boolean;
  error?: string;
}

const DEFAULT_MINTED_VIA = "scope:record-intent-constraint";
const ALLOWED_MINTED_VIA = new Set([DEFAULT_MINTED_VIA, "in-harness-ask"]);

function usage(): string {
  return (
    "usage: scope:record-intent-constraint -- <xbrief-path> --actor <name> --confirm " +
    "[--kind operator] [--minted-via in-harness-ask|scope:record-intent-constraint] " +
    "[--project-root <dir>] [--quiet]\n" +
    '  Writes .deft/intent-constraint/<plan-id>.json from plan["x-directive/intentConstraint"].\n' +
    "  Normal mid-build collection is attended in-harness ask (#5010); this verb is legacy repair " +
    "or the human landing step after chat yes. --minted-via=in-harness-ask records that attestation. " +
    "--actor is display only and never authorizes mint. Mint still requires a real TTY, " +
    "controlling terminal, --confirm, and typed phrase mint (#3110). Agent/CI shells refuse."
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
    actor: "",
    kind: "operator",
    mintedVia: DEFAULT_MINTED_VIA,
    quiet: false,
    confirm: false,
  };
  const positionals: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--") continue;
    if (arg === "--help" || arg === "-h") return { ...parsed, help: true };
    if (arg === "--quiet") parsed.quiet = true;
    else if (arg === "--confirm") parsed.confirm = true;
    else if (arg === "--project-root") {
      const value = argv[i + 1];
      if (value === undefined)
        return { ...parsed, error: "argument --project-root: expected one argument" };
      parsed.projectRoot = value;
      i += 1;
    } else if (arg?.startsWith("--project-root=")) {
      parsed.projectRoot = arg.slice("--project-root=".length);
    } else if (arg === "--actor") {
      const value = argv[i + 1];
      if (value === undefined)
        return { ...parsed, error: "argument --actor: expected one argument" };
      parsed.actor = value;
      i += 1;
    } else if (arg?.startsWith("--actor=")) {
      parsed.actor = arg.slice("--actor=".length);
    } else if (arg === "--kind") {
      const value = argv[i + 1];
      if (value === undefined)
        return { ...parsed, error: "argument --kind: expected one argument" };
      parsed.kind = value;
      i += 1;
    } else if (arg?.startsWith("--kind=")) {
      parsed.kind = arg.slice("--kind=".length);
    } else if (arg === "--minted-via") {
      const value = argv[i + 1];
      if (value === undefined)
        return { ...parsed, error: "argument --minted-via: expected one argument" };
      parsed.mintedVia = value;
      i += 1;
    } else if (arg?.startsWith("--minted-via=")) {
      parsed.mintedVia = arg.slice("--minted-via=".length);
    } else if (arg?.startsWith("-")) {
      return { ...parsed, error: `unrecognized argument: ${arg}` };
    } else if (arg !== undefined) {
      positionals.push(arg);
    }
  }
  if (parsed.help) return parsed;
  if (positionals.length === 0) return { ...parsed, error: `missing xBRIEF path\n${usage()}` };
  if (positionals.length > 1) {
    return { ...parsed, error: `unexpected extra args: ${positionals.slice(1).join(" ")}` };
  }
  parsed.xbriefPath = positionals[0] ?? "";
  if (parsed.actor.trim().length === 0) {
    return {
      ...parsed,
      error: `argument --actor is required (human operator identity)\n${usage()}`,
    };
  }
  if (!ALLOWED_MINTED_VIA.has(parsed.mintedVia.trim())) {
    return {
      ...parsed,
      error: `argument --minted-via must be one of: ${[...ALLOWED_MINTED_VIA].join(", ")}\n${usage()}`,
    };
  }
  parsed.mintedVia = parsed.mintedVia.trim();
  return parsed;
}

export function run(argv: string[], seams: HumanPresenceMintSeams = {}): number {
  const args = parseArgs(argv);
  if (args.help) {
    process.stdout.write(`${usage()}\n`);
    return 0;
  }
  if (args.error !== undefined) {
    process.stderr.write(`scope_record_intent_constraint: ${args.error}\n`);
    return 2;
  }
  const projectRoot = resolve(args.projectRoot);
  const uat = refuseMintWhileUatActive("scope:record-intent-constraint", projectRoot);
  if (uat !== null) return uat;
  const resolved = resolveHumanPresenceMintSeams(seams);
  const refused = refuseNonInteractiveMint({
    verb: "scope:record-intent-constraint",
    confirm: args.confirm,
    isTty: resolved.isTty,
    environ: resolved.environ,
    hasControllingTerminal: resolved.hasControllingTerminal,
    readInteractiveConfirm: resolved.readInteractiveConfirm,
  });
  if (refused !== null) return refused;
  const xbriefAbs = resolve(projectRoot, args.xbriefPath);
  const fullPath = existsSync(xbriefAbs) ? xbriefAbs : resolve(args.xbriefPath);
  if (!existsSync(fullPath)) {
    process.stderr.write(`scope_record_intent_constraint: xBRIEF not found: ${args.xbriefPath}\n`);
    return 2;
  }
  if (!isPathInsideRoot(projectRoot, fullPath)) {
    process.stderr.write("scope_record_intent_constraint: xBRIEF path escapes --project-root.\n");
    return 2;
  }

  let payload: unknown;
  const rawText = readFileSync(fullPath, "utf8");
  try {
    payload = JSON.parse(rawText) as unknown;
  } catch (err: unknown) {
    process.stderr.write(`scope_record_intent_constraint: invalid JSON: ${String(err)}\n`);
    return 2;
  }
  const planId = extractPlanId(payload) ?? basename(fullPath, ".xbrief.json");
  const contract = parseIntentConstraintContract(extractIntentConstraintFromPlan(payload));
  if ("error" in contract) {
    process.stderr.write(`scope_record_intent_constraint: ${contract.error}\n`);
    return 2;
  }
  const rel = relative(projectRoot, fullPath).replace(/\\/g, "/");
  const rec = buildIntentConstraintRecord({
    planId,
    xbriefRelPath: rel.startsWith("xbrief/pending/") ? `xbrief/active/${basename(rel)}` : rel,
    constraints: contract.constraints,
    humanApproval: {
      kind: args.kind,
      actor: args.actor,
      mintedAt: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
      mintedVia: args.mintedVia,
    },
  });
  if ("error" in rec) {
    process.stderr.write(`scope_record_intent_constraint: ${rec.error}\n`);
    return 2;
  }
  const path = writeIntentConstraintRecord(projectRoot, rec);
  if (!args.quiet) {
    process.stdout.write(
      `Wrote ${path}\nCommit this record on the merge base before the implementation change PR.\n`,
    );
  }
  return 0;
}

if (isDirectEntrypoint(import.meta.url)) {
  process.exit(run(process.argv.slice(2)));
}
