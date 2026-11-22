/**
 * Cohort form of the human-presence record mints (#6937).
 *
 * `scope:record-observable-scope` and `scope:record-intent-constraint` take
 * several brief paths or `--manifest <launch-manifest>`. Every brief is loaded,
 * validated and built first; the whole frozen set is printed; the typed mint is
 * asked once; then exactly the printed records are written. A cohort run never
 * overwrites a record: a matching record is left untouched, and one that would
 * change (or does not parse) refuses the whole set before the prompt. A failed
 * run removes only the records it created. `cohortDigest` is bookkeeping that
 * ties the records to one approval, not proof of a human: CI cannot tell a mint
 * from a file an agent wrote, so the record's control is the merge that lands it.
 */
import { createHash, randomBytes } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, relative, resolve } from "node:path";
import { containedWrite, resolveContainedTarget } from "@deftai/directive-core";
import { resolveRepo } from "@deftai/directive-core/dist/triage/queue/repo.js";
import {
  buildIntentConstraintRecord,
  extractIntentConstraintFromPlan,
  intentConstraintRecordPath,
  intentConstraintRecordRel,
  parseIntentConstraintContract,
  parseIntentConstraintRecord,
} from "@deftai/directive-core/intent-constraint";
import {
  buildObservableScopeRecord,
  extractObservableChangeFromPlan,
  observableScopeRecordPath,
  observableScopeRecordRel,
  parseObservableChangeContract,
  parseObservableScopeRecord,
} from "@deftai/directive-core/observable-scope";
import {
  type HumanPresenceMintSeams,
  mintArgsAfterVerb,
  refuseMintWhileUatActive,
  refuseNonInteractiveMint,
  resolveHumanPresenceMintSeams,
} from "./human-presence-mint.js";
import { isPathInsideRoot } from "./scope-record-approved-scope.js";

export type CohortRecordKind = "observable-scope" | "intent-constraint";

/** Test seams for the cohort form, beside the human-presence seams. */
export interface RecordCohortSeams extends HumanPresenceMintSeams {
  /** Runs just before each new record is published (tests force a failure here). */
  readonly beforePublish?: (recordAbs: string) => void;
  /** Repository slug for `cohortDigest` (default: origin remote). */
  readonly repo?: string | null;
  /** Hard-link publish step (tests simulate a file system without hard links). */
  readonly link?: (from: string, to: string) => void;
}

export interface RecordCohortArgs {
  readonly argv: readonly string[];
  readonly projectRoot: string;
  readonly briefPaths: readonly string[];
  readonly manifest: string | null;
  readonly actor: string;
  readonly kind: string;
  readonly mintedVia: string;
  readonly quiet: boolean;
  readonly confirm: boolean;
}

interface ParsedContract {
  readonly changeKind: string | null;
  /** Full contract payload: what the record authorizes. */
  readonly payload: Record<string, unknown>;
  readonly lines: readonly string[];
}

interface ParsedRecordKey {
  readonly planId: string;
  readonly xbriefRelPath: string;
  readonly contractDigest: string;
  readonly changeKind: string | null;
}

interface KindSpec {
  readonly verb: string;
  readonly errPrefix: string;
  readonly contractLabel: string;
  extract(payload: unknown): unknown;
  parseContract(raw: unknown): ParsedContract | { error: string };
  build(input: {
    planId: string;
    xbriefRelPath: string;
    contract: ParsedContract;
    humanApproval: { kind: string; actor: string; mintedAt: string; mintedVia: string };
  }): { record: object; contractDigest: string } | { error: string };
  recordRel(planId: string): string;
  recordPath(projectRoot: string, planId: string): string;
  parseRecord(raw: unknown): ParsedRecordKey | { error: string };
}

const OBSERVABLE_SPEC: KindSpec = {
  verb: "scope:record-observable-scope",
  errPrefix: "scope_record_observable_scope",
  contractLabel: 'plan["x-directive/observableChange"]',
  extract: extractObservableChangeFromPlan,
  parseContract(raw) {
    const parsed = parseObservableChangeContract(raw);
    if ("error" in parsed) return parsed;
    const payload = {
      allowedChanges: parsed.allowedChanges,
      mustPreserve: parsed.mustPreserve ?? [],
    };
    return {
      changeKind: parsed.changeKind,
      payload,
      lines: [
        `changeKind: ${parsed.changeKind}`,
        `allowedChanges: ${JSON.stringify(payload.allowedChanges)}`,
        `mustPreserve: ${JSON.stringify(payload.mustPreserve)}`,
      ],
    };
  },
  build({ planId, xbriefRelPath, contract, humanApproval }) {
    const p = contract.payload as {
      allowedChanges: Parameters<typeof buildObservableScopeRecord>[0]["allowedChanges"];
      mustPreserve: Parameters<typeof buildObservableScopeRecord>[0]["allowedChanges"];
    };
    const rec = buildObservableScopeRecord({
      planId,
      xbriefRelPath,
      allowedChanges: p.allowedChanges,
      mustPreserve: p.mustPreserve.length > 0 ? p.mustPreserve : undefined,
      changeKind: contract.changeKind as "fields-only" | "layout-authorized",
      humanApproval,
    });
    if ("error" in rec) return rec;
    return { record: rec, contractDigest: rec.contractDigest };
  },
  recordRel: observableScopeRecordRel,
  recordPath: observableScopeRecordPath,
  parseRecord(raw) {
    const rec = parseObservableScopeRecord(raw);
    if ("error" in rec) return rec;
    return {
      planId: rec.planId,
      xbriefRelPath: rec.xbriefRelPath,
      contractDigest: rec.contractDigest,
      changeKind: rec.changeKind,
    };
  },
};

const INTENT_SPEC: KindSpec = {
  verb: "scope:record-intent-constraint",
  errPrefix: "scope_record_intent_constraint",
  contractLabel: 'plan["x-directive/intentConstraint"]',
  extract: extractIntentConstraintFromPlan,
  parseContract(raw) {
    const parsed = parseIntentConstraintContract(raw);
    if ("error" in parsed) return parsed;
    return {
      changeKind: null,
      payload: { constraints: parsed.constraints },
      lines: [`constraints: ${JSON.stringify(parsed.constraints)}`],
    };
  },
  build({ planId, xbriefRelPath, contract, humanApproval }) {
    const rec = buildIntentConstraintRecord({
      planId,
      xbriefRelPath,
      constraints: (
        contract.payload as {
          constraints: Parameters<typeof buildIntentConstraintRecord>[0]["constraints"];
        }
      ).constraints,
      humanApproval,
    });
    if ("error" in rec) return rec;
    return { record: rec, contractDigest: rec.contractDigest };
  },
  recordRel: intentConstraintRecordRel,
  recordPath: intentConstraintRecordPath,
  parseRecord(raw) {
    const rec = parseIntentConstraintRecord(raw);
    if ("error" in rec) return rec;
    return {
      planId: rec.planId,
      xbriefRelPath: rec.xbriefRelPath,
      contractDigest: rec.contractDigest,
      changeKind: null,
    };
  },
};

function specFor(kind: CohortRecordKind): KindSpec {
  return kind === "observable-scope" ? OBSERVABLE_SPEC : INTENT_SPEC;
}

/** One entry of the canonical list that `cohortDigest` hashes. */
export interface CohortDigestEntry {
  readonly kind: CohortRecordKind;
  readonly planId: string;
  readonly xbriefRelPath: string;
  readonly changeKind: string | null;
  readonly contract: Record<string, unknown>;
}

/**
 * sha256 over the sorted list of record kind, plan id, brief path, changeKind
 * and full contract payload, plus the repository slug. Input order does not
 * change it. Bookkeeping only: it ties records to one approval.
 */
export function computeCohortDigest(
  entries: readonly CohortDigestEntry[],
  repo: string | null,
): string {
  const records = entries
    .map((e) => ({
      kind: e.kind,
      planId: e.planId,
      xbriefRelPath: e.xbriefRelPath,
      changeKind: e.changeKind,
      contract: e.contract,
    }))
    .sort((a, b) => {
      const ka = `${a.kind}\u0000${a.planId}\u0000${a.xbriefRelPath}`;
      const kb = `${b.kind}\u0000${b.planId}\u0000${b.xbriefRelPath}`;
      return ka < kb ? -1 : ka > kb ? 1 : 0;
    });
  const canonical = `${JSON.stringify({ repo: repo ?? "", records })}\n`;
  return `sha256:${createHash("sha256").update(canonical, "utf8").digest("hex")}`;
}

function extractPlanId(payload: unknown): string | null {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) return null;
  const plan = (payload as Record<string, unknown>).plan;
  if (plan === null || typeof plan !== "object" || Array.isArray(plan)) return null;
  const id = (plan as Record<string, unknown>).id;
  return typeof id === "string" && id.trim().length > 0 ? id.trim() : null;
}

function resolveInput(projectRoot: string, path: string): string {
  const underRoot = resolve(projectRoot, path);
  return existsSync(underRoot) ? underRoot : resolve(path);
}

/** Brief paths named by a launch manifest (`xbrief_path`, legacy `vbrief_path`). */
function manifestBriefPaths(
  projectRoot: string,
  manifest: string,
): { paths: (string | null)[] } | { error: string } {
  const abs = resolveInput(projectRoot, manifest);
  if (!existsSync(abs)) return { error: `launch manifest not found: ${manifest}` };
  let payload: unknown;
  try {
    payload = JSON.parse(readFileSync(abs, "utf8")) as unknown;
  } catch (err: unknown) {
    return { error: `launch manifest is not valid JSON: ${String(err)}` };
  }
  if (!Array.isArray(payload)) return { error: "launch manifest must be a JSON array" };
  const paths: (string | null)[] = [];
  for (const entry of payload) {
    const rec =
      entry !== null && typeof entry === "object" && !Array.isArray(entry)
        ? (entry as Record<string, unknown>)
        : {};
    const rel =
      typeof rec.xbrief_path === "string"
        ? rec.xbrief_path
        : typeof rec.vbrief_path === "string"
          ? rec.vbrief_path
          : "";
    paths.push(rel.trim().length > 0 ? rel.trim() : null);
  }
  if (paths.length === 0) return { error: "launch manifest names no briefs" };
  return { paths };
}

interface CohortTarget {
  readonly planId: string;
  readonly briefRel: string;
  readonly xbriefRelPath: string;
  readonly recordRel: string;
  readonly recordAbs: string;
  readonly contract: ParsedContract;
  readonly contractDigest: string;
  readonly record: object;
}

function singleStoryHint(spec: KindSpec): string {
  return (
    `Change an approved record with the single-story form: \`deft ${spec.verb} -- <brief> ` +
    "--actor <name> --confirm` (one brief path)."
  );
}

function refuseBeforePrompt(spec: KindSpec, problems: readonly string[], hint: boolean): number {
  const lines = problems.map((p) => `  - ${p}`).join("\n");
  process.stderr.write(
    `${spec.errPrefix}: refusing the whole cohort before the prompt; nothing was written:\n${lines}\n` +
      (hint ? `${singleStoryHint(spec)}\n` : ""),
  );
  return 2;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** A record this run published: its bytes and file identity at publish time. */
interface PublishedRecord {
  readonly path: string;
  readonly data: string;
  readonly ino: bigint | null;
}

function fileIno(path: string): bigint | null {
  try {
    return lstatSync(path, { bigint: true }).ino;
  } catch {
    return null;
  }
}

/**
 * Rollback removes a published record only while it is still this run's file:
 * same file identity and the same bytes. A record another writer replaced or
 * rewrote since is left alone.
 */
function removeIfStillOurs(rec: PublishedRecord): boolean {
  try {
    const st = lstatSync(rec.path, { bigint: true });
    if (!st.isFile() || (rec.ino !== null && st.ino !== rec.ino)) return false;
    if (readFileSync(rec.path, "utf8") !== rec.data) return false;
    unlinkSync(rec.path);
    return true;
  } catch {
    return false;
  }
}

function isExistsError(err: unknown): boolean {
  return (err as NodeJS.ErrnoException).code === "EEXIST";
}

/**
 * O_EXCL create for file systems without hard links. A file this call opened
 * and then failed to fill is removed; a file another writer created is never
 * touched, because the open itself fails for it.
 */
function createExclusive(target: string, data: string): string | null {
  let fd: number;
  try {
    fd = openSync(target, "wx", 0o644);
  } catch (err: unknown) {
    return isExistsError(err) ? `${target} already exists` : errorText(err);
  }
  let failure: string | null = null;
  try {
    writeFileSync(fd, data, "utf8");
    fsyncSync(fd);
  } catch (err: unknown) {
    failure = errorText(err);
  }
  try {
    closeSync(fd);
  } catch (err: unknown) {
    failure ??= errorText(err);
  }
  if (failure !== null) {
    try {
      unlinkSync(target);
    } catch {
      // already gone
    }
  }
  return failure;
}

/**
 * Exclusive publish: write a temp file, then link it into place. The link
 * fails when the target exists, so the never-overwrite rule holds in the write
 * itself. Where the file system has no hard links, an O_EXCL create keeps it.
 * Returns an error text, or null when this call created the target.
 */
function publishExclusive(
  root: string,
  targetAbs: string,
  data: string,
  link: (from: string, to: string) => void,
): string | null {
  let tmp: string | null = null;
  try {
    mkdirSync(dirname(targetAbs), { recursive: true });
    const target = resolveContainedTarget(root, targetAbs);
    tmp = `${target}.${randomBytes(6).toString("hex")}.next.tmp`;
    containedWrite({ root, target: tmp, data, mode: "create", mutation: false });
    try {
      link(tmp, target);
    } catch (err: unknown) {
      if (isExistsError(err)) return `${targetAbs} already exists`;
      return createExclusive(target, data);
    }
    return null;
  } catch (err: unknown) {
    return errorText(err);
  } finally {
    if (tmp !== null) {
      try {
        unlinkSync(tmp);
      } catch {
        // temp already gone
      }
    }
  }
}

/** Run the cohort form for one record kind (#6937). Returns the exit code. */
export function runRecordCohort(
  kind: CohortRecordKind,
  args: RecordCohortArgs,
  seams: RecordCohortSeams = {},
): number {
  const spec = specFor(kind);
  const projectRoot = resolve(args.projectRoot);
  const uat = refuseMintWhileUatActive(spec.verb, projectRoot);
  if (uat !== null) return uat;

  let inputs: (string | null)[];
  const fromManifest = args.manifest !== null;
  if (args.manifest !== null) {
    const listed = manifestBriefPaths(projectRoot, args.manifest);
    if ("error" in listed) return refuseBeforePrompt(spec, [listed.error], false);
    inputs = listed.paths;
  } else {
    inputs = [...args.briefPaths];
  }

  const problems: string[] = [];
  const skipped: string[] = [];
  const seen = new Set<string>();
  const loaded: { planId: string; briefRel: string; contract: ParsedContract }[] = [];
  for (const [index, input] of inputs.entries()) {
    if (input === null) {
      problems.push(`launch manifest entry ${String(index + 1)} has no xbrief_path`);
      continue;
    }
    const abs = resolveInput(projectRoot, input);
    if (seen.has(abs)) continue;
    seen.add(abs);
    if (!existsSync(abs)) {
      problems.push(`xBRIEF not found: ${input}`);
      continue;
    }
    if (!isPathInsideRoot(projectRoot, abs)) {
      problems.push(`xBRIEF path escapes --project-root: ${input}`);
      continue;
    }
    const briefRel = relative(projectRoot, abs).replace(/\\/g, "/");
    let payload: unknown;
    try {
      payload = JSON.parse(readFileSync(abs, "utf8")) as unknown;
    } catch (err: unknown) {
      problems.push(`${briefRel}: invalid JSON: ${String(err)}`);
      continue;
    }
    const raw = spec.extract(payload);
    if (raw === undefined && fromManifest) {
      skipped.push(briefRel);
      continue;
    }
    const contract = spec.parseContract(raw);
    if ("error" in contract) {
      problems.push(`${briefRel}: ${contract.error}`);
      continue;
    }
    loaded.push({
      planId: extractPlanId(payload) ?? basename(abs, ".xbrief.json"),
      briefRel,
      contract,
    });
  }
  if (problems.length > 0) return refuseBeforePrompt(spec, problems, false);

  const mintedAt = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  const targets: CohortTarget[] = [];
  for (const item of loaded) {
    const xbriefRelPath = item.briefRel.startsWith("xbrief/pending/")
      ? `xbrief/active/${basename(item.briefRel)}`
      : item.briefRel;
    const built = spec.build({
      planId: item.planId,
      xbriefRelPath,
      contract: item.contract,
      humanApproval: { kind: args.kind, actor: args.actor, mintedAt, mintedVia: args.mintedVia },
    });
    if ("error" in built) {
      problems.push(`${item.briefRel}: ${built.error}`);
      continue;
    }
    targets.push({
      planId: item.planId,
      briefRel: item.briefRel,
      xbriefRelPath,
      recordRel: spec.recordRel(item.planId),
      recordAbs: spec.recordPath(projectRoot, item.planId),
      contract: item.contract,
      contractDigest: built.contractDigest,
      record: built.record,
    });
  }
  if (problems.length > 0) return refuseBeforePrompt(spec, problems, false);

  const byFile = new Map<string, CohortTarget[]>();
  for (const t of targets) byFile.set(t.recordRel, [...(byFile.get(t.recordRel) ?? []), t]);
  for (const [file, group] of byFile) {
    if (group.length > 1) {
      problems.push(
        `plan ids ${group.map((t) => JSON.stringify(t.planId)).join(", ")} map to one record file ${file}`,
      );
    }
  }
  if (problems.length > 0) return refuseBeforePrompt(spec, problems, false);

  const fresh: CohortTarget[] = [];
  const already: CohortTarget[] = [];
  for (const t of targets) {
    if (!existsSync(t.recordAbs)) {
      fresh.push(t);
      continue;
    }
    let existing: ParsedRecordKey | { error: string };
    try {
      existing = spec.parseRecord(JSON.parse(readFileSync(t.recordAbs, "utf8")) as unknown);
    } catch (err: unknown) {
      existing = { error: `invalid JSON: ${String(err)}` };
    }
    if ("error" in existing) {
      problems.push(`existing record ${t.recordRel} does not parse (${existing.error})`);
      continue;
    }
    const changed: string[] = [];
    if (existing.planId !== t.planId) changed.push("plan id");
    if (existing.xbriefRelPath !== t.xbriefRelPath) changed.push("brief path");
    if (existing.changeKind !== t.contract.changeKind) changed.push("changeKind");
    if (existing.contractDigest !== t.contractDigest) changed.push("contract");
    if (changed.length > 0) {
      problems.push(`existing record ${t.recordRel} would change (${changed.join(", ")})`);
      continue;
    }
    already.push(t);
  }
  if (problems.length > 0) return refuseBeforePrompt(spec, problems, true);

  const repo = seams.repo !== undefined ? seams.repo : resolveRepo(null, projectRoot);
  const cohortDigest = computeCohortDigest(
    fresh.map((t) => ({
      kind,
      planId: t.planId,
      xbriefRelPath: t.xbriefRelPath,
      changeKind: t.contract.changeKind,
      contract: t.contract.payload,
    })),
    repo,
  );

  const out: string[] = [];
  if (fresh.length > 0) {
    out.push(
      `${spec.verb} cohort: ${String(fresh.length)} record(s) to write after one typed mint ` +
        `(cohortDigest ${cohortDigest}, repository ${repo ?? "unresolved"}):`,
    );
    fresh.forEach((t, i) => {
      out.push(`  ${String(i + 1)}. plan id: ${t.planId}`);
      out.push(`     record: ${t.recordRel}`);
      out.push(`     brief: ${t.xbriefRelPath}`);
      for (const line of t.contract.lines) out.push(`     ${line}`);
    });
  }
  for (const t of already) {
    out.push(
      `Already recorded (left untouched, not re-approved): ${t.recordRel} (${t.xbriefRelPath})`,
    );
  }
  for (const s of skipped) out.push(`Skipped (no ${spec.contractLabel}): ${s}`);
  if (fresh.length === 0) {
    out.push(`${spec.verb} cohort: nothing to write; no prompt.`);
    process.stdout.write(`${out.join("\n")}\n`);
    return 0;
  }
  out.push(
    "CI cannot tell a mint from a file an agent wrote: the record's control is the merge that lands it.",
  );
  process.stdout.write(`${out.join("\n")}\n`);

  const resolved = resolveHumanPresenceMintSeams(seams);
  const refused = refuseNonInteractiveMint({
    verb: spec.verb,
    confirm: args.confirm,
    isTty: resolved.isTty,
    environ: resolved.environ,
    hasControllingTerminal: resolved.hasControllingTerminal,
    readInteractiveConfirm: resolved.readInteractiveConfirm,
    operatorStop: {
      projectRoot,
      args: mintArgsAfterVerb(args.argv, null),
      record: resolved.recordOperatorStop,
    },
  });
  if (refused !== null) return refused;

  const created: PublishedRecord[] = [];
  for (const t of fresh) {
    const data = `${JSON.stringify({ ...t.record, cohortDigest }, null, 2)}\n`;
    let failure: string | null;
    try {
      seams.beforePublish?.(t.recordAbs);
      failure = publishExclusive(projectRoot, t.recordAbs, data, seams.link ?? linkSync);
    } catch (err: unknown) {
      failure = errorText(err);
    }
    if (failure === null) {
      created.push({ path: t.recordAbs, data, ino: fileIno(t.recordAbs) });
      continue;
    }
    const removed = created.filter(removeIfStillOurs).length;
    process.stderr.write(
      `${spec.errPrefix}: writing ${t.recordRel} failed (${failure}); removed the ` +
        `${String(removed)} record(s) this run created and still owned; ` +
        "pre-existing records are untouched.\n",
    );
    return 1;
  }
  if (!args.quiet) {
    process.stdout.write(
      `${fresh.map((t) => `Wrote ${t.recordAbs}`).join("\n")}\n` +
        "Commit these records in the activation PR that adds their briefs, or on the merge base " +
        "before the change PRs; the merge that lands them is their control.\n",
    );
  }
  return 0;
}
