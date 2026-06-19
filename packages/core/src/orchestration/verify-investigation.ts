/**
 * Deterministic validator for forensic investigation ledgers (#1621).
 * Port of scripts/verify_investigation.py.
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

export const REQUIRED_WAVES = ["1", "2", "3", "4"] as const;

export interface Finding {
  readonly code: string;
  readonly message: string;
}

export interface ValidationResult {
  hard_failures: Finding[];
  soft_warnings: Finding[];
}

export class LedgerConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LedgerConfigError";
  }
}

export function validationOk(result: ValidationResult): boolean {
  return result.hard_failures.length === 0;
}

type ClaimTuple = [Record<string, unknown>, Record<string, unknown> | null];

function iterClaims(items: unknown[]): ClaimTuple[] {
  const out: ClaimTuple[] = [];

  function walk(node: Record<string, unknown>, branch: Record<string, unknown> | null): void {
    const children = node.items;
    if (!Array.isArray(children)) {
      return;
    }
    for (const child of children) {
      if (typeof child !== "object" || child === null || Array.isArray(child)) {
        continue;
      }
      out.push([child as Record<string, unknown>, branch]);
      walk(child as Record<string, unknown>, branch);
    }
  }

  for (const top of items) {
    if (typeof top !== "object" || top === null || Array.isArray(top)) {
      continue;
    }
    walk(top as Record<string, unknown>, top as Record<string, unknown>);
  }
  return out;
}

function claimMeta(claim: Record<string, unknown>): Record<string, unknown> {
  const meta = claim.metadata;
  if (typeof meta !== "object" || meta === null || Array.isArray(meta)) {
    return {};
  }
  const xclaim = (meta as Record<string, unknown>)["x-claim"];
  if (typeof xclaim === "object" && xclaim !== null && !Array.isArray(xclaim)) {
    return xclaim as Record<string, unknown>;
  }
  return {};
}

function evidenceRefs(xclaim: Record<string, unknown>): string[] {
  const refs = xclaim.evidenceRefs;
  if (!Array.isArray(refs)) {
    return [];
  }
  return refs.map((r) => String(r));
}

/** Load + structurally validate a ledger file. */
export function loadLedger(path: string): Record<string, unknown> {
  if (!existsSync(path)) {
    throw new LedgerConfigError(`ledger not found: ${path}`);
  }
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (exc: unknown) {
    throw new LedgerConfigError(
      `ledger unreadable: ${path}: ${String((exc as Error).message ?? exc)}`,
    );
  }
  let data: unknown;
  try {
    data = JSON.parse(raw) as unknown;
  } catch (exc: unknown) {
    throw new LedgerConfigError(`ledger is not valid JSON: ${path}: ${String(exc)}`);
  }
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    throw new LedgerConfigError(`ledger root is not an object: ${path}`);
  }
  const obj = data as Record<string, unknown>;
  const plan = obj.plan;
  if (typeof plan !== "object" || plan === null || Array.isArray(plan)) {
    throw new LedgerConfigError(`ledger missing 'plan' object: ${path}`);
  }
  const planObj = plan as Record<string, unknown>;
  if (!Array.isArray(planObj.items)) {
    throw new LedgerConfigError(`ledger missing 'plan.items' array: ${path}`);
  }
  const meta = planObj.metadata;
  const xinv =
    typeof meta === "object" && meta !== null && !Array.isArray(meta)
      ? (meta as Record<string, unknown>)["x-investigation"]
      : null;
  const profile =
    typeof xinv === "object" && xinv !== null && !Array.isArray(xinv)
      ? (xinv as Record<string, unknown>).profile
      : null;
  if (profile !== "forensic-research-v1") {
    throw new LedgerConfigError(
      `ledger is not a forensic-research-v1 profile (got ${JSON.stringify(profile)}): ${path}`,
    );
  }
  return obj;
}

/** Apply validator checklist to loaded ledger dict. */
export function validateLedger(data: Record<string, unknown>): ValidationResult {
  const result: ValidationResult = { hard_failures: [], soft_warnings: [] };
  const plan = data.plan as Record<string, unknown>;
  const items = plan.items as unknown[];
  const meta = plan.metadata;
  const xinv =
    typeof meta === "object" && meta !== null && !Array.isArray(meta)
      ? ((meta as Record<string, unknown>)["x-investigation"] as Record<string, unknown>)
      : {};

  let waves = xinv.wavesCompleted;
  if (typeof waves !== "object" || waves === null || Array.isArray(waves)) {
    waves = {};
  }
  const wavesObj = waves as Record<string, unknown>;
  const missing = REQUIRED_WAVES.filter((w) => wavesObj[w] !== true);
  if (missing.length > 0) {
    result.hard_failures.push({
      code: "HF-WAVES",
      message: `wavesCompleted is missing ${missing.join(", ")} -- falsifier (3) + red-team (4) MUST run before close`,
    });
  }

  if (plan.status === "running") {
    result.hard_failures.push({
      code: "HF-STATUS",
      message: "plan.status is still 'running' -- set it to completed/failed before close",
    });
  }

  const refIds = new Set<string>();
  const references = plan.references;
  if (Array.isArray(references)) {
    for (const ref of references) {
      if (typeof ref === "object" && ref !== null && !Array.isArray(ref)) {
        const val = (ref as Record<string, unknown>).id;
        if (typeof val === "string") {
          refIds.add(val);
        }
      }
    }
  }

  const claims = iterClaims(items);
  for (const [claim] of claims) {
    const cid = typeof claim.id === "string" ? claim.id : "<no-id>";
    const cstatus = claim.status;
    const isBranch = Array.isArray(claim.items) && claim.items.length > 0;
    if (isBranch) {
      continue;
    }
    const xclaim = claimMeta(claim);
    const refs = evidenceRefs(xclaim);

    if (cstatus === "failed") {
      if (!xclaim.ruledOutReason || refs.length === 0) {
        result.hard_failures.push({
          code: "HF-FAILED-CLAIM",
          message: `claim ${cid} is 'failed' but missing ruledOutReason and/or evidenceRefs (proof-required disproval)`,
        });
      }
    } else if (cstatus === "completed") {
      if (refs.length === 0) {
        result.hard_failures.push({
          code: "HF-COMPLETED-CLAIM",
          message: `claim ${cid} is 'completed' but cites no evidenceRefs (evidence before narrative)`,
        });
      }
    } else if (cstatus === "blocked") {
      result.soft_warnings.push({
        code: "SW-BLOCKED",
        message: `claim ${cid} is 'blocked' (unknown) -- residual uncertainty on a live branch`,
      });
    }

    for (const ref of refs) {
      if (!refIds.has(ref)) {
        result.hard_failures.push({
          code: "HF-DANGLING-EV",
          message: `claim ${cid} cites evidence ref ${JSON.stringify(ref)} not present in plan.references`,
        });
      }
    }
  }

  const invalidatesTargets = new Set<string>();
  const edges = plan.edges;
  if (Array.isArray(edges)) {
    for (const edge of edges) {
      if (typeof edge === "object" && edge !== null && !Array.isArray(edge)) {
        const e = edge as Record<string, unknown>;
        if (e.type === "invalidates" && typeof e.to === "string") {
          invalidatesTargets.add(e.to);
        }
      }
    }
  }

  let completedBranches = 0;
  for (const top of items) {
    if (typeof top !== "object" || top === null || Array.isArray(top)) {
      continue;
    }
    const branch = top as Record<string, unknown>;
    const bid = typeof branch.id === "string" ? branch.id : "<no-id>";
    const bstatus = branch.status;
    if (bstatus === "failed" && !invalidatesTargets.has(bid)) {
      result.hard_failures.push({
        code: "HF-BRANCH-NO-EDGE",
        message: `branch ${bid} is 'failed' but has no invalidates edge -- a branch is ruled out only by a falsified child claim`,
      });
    }
    if (bstatus === "completed") {
      completedBranches += 1;
    }
  }

  if (completedBranches > 1) {
    result.soft_warnings.push({
      code: "SW-MULTI-SURVIVOR",
      message: `${completedBranches} branches are 'completed' -- multiple surviving theories; note in Outcome`,
    });
  }

  return result;
}

export interface VerifyInvestigationArgs {
  ledger: string | null;
  projectRoot: string;
  emitJson: boolean;
  error?: string;
}

export function parseVerifyInvestigationArgs(argv: string[]): VerifyInvestigationArgs {
  const parsed: VerifyInvestigationArgs = {
    ledger: null,
    projectRoot: ".",
    emitJson: false,
  };
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--json") {
      parsed.emitJson = true;
    } else if (arg === "--ledger") {
      parsed.ledger = argv[i + 1] ?? null;
      i += 1;
    } else if (arg?.startsWith("--ledger=")) {
      parsed.ledger = arg.slice("--ledger=".length);
    } else if (arg === "--project-root") {
      parsed.projectRoot = argv[i + 1] ?? ".";
      i += 1;
    } else if (arg?.startsWith("--project-root=")) {
      parsed.projectRoot = arg.slice("--project-root=".length);
    } else if (arg === "--help" || arg === "-h") {
      return parsed;
    } else if (arg?.startsWith("-")) {
      return { ...parsed, error: `unrecognized argument: ${arg}` };
    } else if (arg !== undefined) {
      positional.push(arg);
    }
  }
  if (parsed.ledger === null && positional.length > 0) {
    parsed.ledger = positional[0] ?? null;
  }
  return parsed;
}

/** Run verify-investigation CLI; returns exit code. */
export function cmdVerifyInvestigation(argv: string[]): number {
  const args = parseVerifyInvestigationArgs(argv);
  if (args.error !== undefined) {
    process.stderr.write(`config error: ${args.error}\n`);
    return 2;
  }
  if (args.ledger === null || args.ledger.length === 0) {
    process.stderr.write("config error: no ledger path given (--ledger <path>)\n");
    return 2;
  }

  let path = args.ledger;
  if (!path.startsWith("/")) {
    path = resolve(args.projectRoot, path);
  } else {
    path = resolve(path);
  }

  let data: Record<string, unknown>;
  try {
    data = loadLedger(path);
  } catch (exc: unknown) {
    const msg = exc instanceof LedgerConfigError ? exc.message : String(exc);
    if (args.emitJson) {
      process.stdout.write(`${JSON.stringify({ exit: 2, error: msg })}\n`);
    } else {
      process.stderr.write(`config error: ${msg}\n`);
    }
    return 2;
  }

  const result = validateLedger(data);

  if (args.emitJson) {
    process.stdout.write(
      `${JSON.stringify({
        exit: validationOk(result) ? 0 : 1,
        hard_failures: result.hard_failures.map((f) => ({ code: f.code, message: f.message })),
        soft_warnings: result.soft_warnings.map((f) => ({ code: f.code, message: f.message })),
      })}\n`,
    );
    return validationOk(result) ? 0 : 1;
  }

  for (const warn of result.soft_warnings) {
    process.stdout.write(`warning [${warn.code}]: ${warn.message}\n`);
  }

  if (validationOk(result)) {
    process.stdout.write(
      `OK investigation ledger passes the validator: ${path} (${result.soft_warnings.length} soft warning(s))\n`,
    );
    return 0;
  }

  process.stderr.write(`investigation ledger NOT close-ready: ${path}\n`);
  for (const fail of result.hard_failures) {
    process.stderr.write(`  hard failure [${fail.code}]: ${fail.message}\n`);
  }
  return 1;
}
