/**
 * Cohort form of the declared record writers (#6937 / #7031).
 *
 * `scope:record-observable-scope` and `scope:record-intent-constraint` take
 * several brief paths or `--manifest <launch-manifest>`. Every brief is loaded,
 * validated and built first; the whole frozen set is printed; then exactly the
 * printed records are written, each with a declared stamp naming the verb.
 * There is no terminal step (#7031): the cohort writes from any shell, an
 * agent's included. A cohort run never overwrites a record: a matching record
 * is left untouched, and one that would change (or does not parse) refuses the
 * whole set before any write. A failed run removes only the records it
 * created. `cohortDigest` is bookkeeping that ties the records to one run, not
 * proof of a human: the record's control is the merge that lands it.
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
import { approvers, containedWrite, resolveContainedTarget } from "@deftai/directive-core";
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
import { buildCeremonyLink, formatCeremonyOutput } from "./approvers-link.js";
import { type HumanPresenceMintSeams, refuseMintWhileUatActive } from "./human-presence-mint.js";
import { isPathInsideRoot } from "./scope-record-approved-scope.js";

export type CohortRecordKind = "observable-scope" | "intent-constraint";

/**
 * Test seams for the cohort form. The human-presence seams stay in the type so
 * existing callers compile; the declared writers no longer read them (#7031).
 */
export interface RecordCohortSeams extends HumanPresenceMintSeams {
  /** Runs just before each new record is published (tests force a failure here). */
  readonly beforePublish?: (recordAbs: string) => void;
  /** Repository slug for `cohortDigest` (default: origin remote). */
  readonly repo?: string | null;
  /** Hard-link publish step (tests simulate a file system without hard links). */
  readonly link?: (from: string, to: string) => void;
  /** Injected signed level (tests). Absent: the record verb resolves it. */
  readonly approvalLevel?: approvers.SignedLevel;
}

export interface RecordCohortArgs {
  readonly projectRoot: string;
  readonly briefPaths: readonly string[];
  readonly manifest: string | null;
  /** Declared-by display name; may name an agent (#7031). */
  readonly actor: string;
  readonly quiet: boolean;
  /** Set only at the signed level (#6945). Absent keeps the declared writer. */
  readonly signed?: {
    readonly level: Extract<approvers.SignedLevel, { readonly ok: true }>;
    readonly phase: "request" | "assertion";
    readonly approval?: approvers.RecordApproval;
  };
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
    `Change a record with the single-story form: \`deft ${spec.verb} -- <brief>\` ` +
    "(one brief path)."
  );
}

function refuseBeforePrompt(spec: KindSpec, problems: readonly string[], hint: boolean): number {
  const lines = problems.map((p) => `  - ${p}`).join("\n");
  process.stderr.write(
    `${spec.errPrefix}: refusing the whole cohort; nothing was written:\n${lines}\n` +
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

/**
 * Signed level (#6945): `--request` prints the ceremony link and writes
 * nothing. `--assertion` verifies the blob against the merge-base trust file
 * and writes exactly the frozen set, replacing a record whose old approval
 * no longer verifies. Records carry no `cohortDigest`: that key is refused
 * at the signed level.
 */
function runSigned(
  kind: CohortRecordKind,
  spec: KindSpec,
  projectRoot: string,
  args: RecordCohortArgs,
  targets: readonly CohortTarget[],
): number {
  const signed = args.signed;
  if (signed === undefined) return 2;
  if (targets.length === 0) {
    process.stderr.write(`${spec.errPrefix}: no records to approve.\n`);
    return 2;
  }
  const entries = targets.map((target) =>
    approvers.buildRecordApprovalEntry({
      kind,
      planId: target.planId,
      xbriefRelPath: target.xbriefRelPath,
      recordRel: target.recordRel,
      changeKind: kind === "intent-constraint" ? null : target.contract.changeKind,
      contractDigest: target.contractDigest,
    }),
  );
  if (signed.phase === "request") {
    const origin = signed.level.trust.body.rp.origins[0];
    if (origin === undefined) {
      process.stderr.write(`${spec.errPrefix}: trust file has no ceremony origin.\n`);
      return 2;
    }
    const link = buildCeremonyLink(origin, {
      schema: "deft.ceremony-request.v1",
      mode: "approve",
      repo: signed.level.repo,
      rp: signed.level.trust.body.rp,
      entries,
      credentialIds: signed.level.trust.body.approvers.map((approver) => approver.credentialId),
    });
    if ("error" in link) {
      process.stderr.write(`${spec.errPrefix}: ${link.error}\n`);
      return 2;
    }
    process.stdout.write(`${formatCeremonyOutput(link)}\n`);
    return 0;
  }
  const approval = signed.approval;
  if (approval === undefined) {
    process.stderr.write(`${spec.errPrefix}: --assertion needs a blob.\n`);
    return 2;
  }
  if (
    approval.payload.repo !== signed.level.repo ||
    approval.payload.entries.length !== entries.length ||
    entries.some((entry) => !approvers.payloadHasEntry(approval.payload, entry))
  ) {
    process.stderr.write(
      `${spec.errPrefix}: the assertion is not an approval of exactly this set. ` +
        `${approvers.SIGNED_APPROVAL_CLAIM}\n`,
    );
    return 1;
  }
  let approver = "";
  const rows: { target: CohortTarget; data: string }[] = [];
  for (const target of targets) {
    const withApproval = { ...target.record, approval };
    const result = approvers.verifyRecordApproval({
      kind,
      record: withApproval,
      recordRel: target.recordRel,
      planId: target.planId,
      xbriefRelPath: target.xbriefRelPath,
      changeKind: kind === "intent-constraint" ? null : target.contract.changeKind,
      contractDigest: target.contractDigest,
      repo: signed.level.repo,
      body: signed.level.trust.body,
    });
    if (!result.ok) {
      process.stderr.write(
        `${spec.errPrefix}: ${target.recordRel} is not approved: ${result.reason}. ${approvers.SIGNED_APPROVAL_CLAIM}\n`,
      );
      return 1;
    }
    approver = result.approver;
    rows.push({ target, data: `${JSON.stringify(withApproval, null, 2)}\n` });
  }
  const previous = new Map<string, string | null>();
  for (const row of rows) {
    previous.set(
      row.target.recordAbs,
      existsSync(row.target.recordAbs) ? readFileSync(row.target.recordAbs, "utf8") : null,
    );
  }
  const written: string[] = [];
  for (const row of rows) {
    try {
      mkdirSync(dirname(row.target.recordAbs), { recursive: true });
      containedWrite({
        root: projectRoot,
        target: row.target.recordAbs,
        data: row.data,
        mode: previous.get(row.target.recordAbs) === null ? "create" : "replace",
        mutation: false,
      });
      written.push(row.target.recordAbs);
    } catch (err: unknown) {
      for (const path of written) {
        const prior = previous.get(path);
        try {
          if (prior === null || prior === undefined) unlinkSync(path);
          else {
            containedWrite({
              root: projectRoot,
              target: path,
              data: prior,
              mode: "replace",
              mutation: false,
            });
          }
        } catch {
          // best-effort restore
        }
      }
      process.stderr.write(
        `${spec.errPrefix}: writing ${row.target.recordRel} failed (${errorText(err)}); ` +
          "restored records this run changed.\n",
      );
      return 1;
    }
  }
  if (!args.quiet) {
    process.stdout.write(
      `${written.map((path) => `Wrote ${path}`).join("\n")}\n` +
        `Signed level: approved by ${approver}. ${approvers.SIGNED_APPROVAL_CLAIM}\n`,
    );
  }
  return 0;
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
      humanApproval: { kind: "declared", actor: args.actor, mintedAt, mintedVia: spec.verb },
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

  if (args.signed !== undefined) {
    return runSigned(kind, spec, projectRoot, args, targets);
  }

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
      `${spec.verb} cohort: ${String(fresh.length)} declared record(s) to write ` +
        `(cohortDigest ${cohortDigest}, repository ${repo ?? "unresolved"}, declared by ${args.actor}):`,
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
    out.push(`${spec.verb} cohort: nothing to write.`);
    process.stdout.write(`${out.join("\n")}\n`);
    return 0;
  }
  out.push(
    "A declared record is a declaration, not consent (#7031): the record's control is the merge that lands it.",
  );
  process.stdout.write(`${out.join("\n")}\n`);

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
