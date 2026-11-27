#!/usr/bin/env node
/**
 * CLI for scope:record-approved-scope (#3205).
 *
 * Deposits a human-origin approved-scope digest under
 * `.deft/approved-scope/<plan-id>.json` so verify:scope-provenance can
 * authorize pending→active and operator-approved expansion without same-PR
 * self-authorization.
 */
import { spawnSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, relative, resolve, sep } from "node:path";
import { scopeProvenance, slice } from "@deftai/directive-core";
import {
  appendDelegationAudit,
  DELEGATED_ACTION_CHAT_LINE_PREFIX,
  DELEGATED_AUTHORITY_MAX_EXPIRY_HOURS,
  DELEGATED_TOTP_PROVENANCE,
  DELEGATION_SCHEMA_VERSION,
  type DelegatedCompletion,
  isDelegationIdLive,
  readLiveDelegation,
  resolveDelegationStoreRoot,
} from "@deftai/directive-core/authz";
import { verifyDocsImpactBodyFile } from "@deftai/directive-core/dist/docs/docs-impact.js";
import { buildDelegatedApprovalStamp } from "@deftai/directive-core/dist/scope-provenance/digest.js";
import { evaluateOnePrScopeProofGate, resolveDeliveryBranch } from "@deftai/directive-core/policy";
import { isDirectEntrypoint } from "./entrypoint.js";
import {
  type HumanPresenceMintSeams,
  mintArgsAfterVerb,
  refuseMintWhileUatActive,
  refuseNonInteractiveMint,
  resolveHumanPresenceMintSeams,
} from "./human-presence-mint.js";
import {
  type CohortWriteSeams,
  formatCohortNext,
  formatCohortPlan,
  prepareCohortMint,
  readCohortManifest,
  writeCohortPairs,
} from "./scope-record-approved-scope-cohort.js";

/** True when `candidate` is the same as or a descendant of `root` after realpath. */
export function isPathInsideRoot(root: string, candidate: string): boolean {
  let rootReal: string;
  let candReal: string;
  try {
    rootReal = realpathSync(root);
    // realpathSync fails if path does not exist; fall back to resolve for missing targets
    candReal = existsSync(candidate) ? realpathSync(candidate) : resolve(candidate);
  } catch {
    return false;
  }
  const rel = relative(rootReal, candReal);
  if (rel === "") return true;
  if (
    rel.startsWith(`..${sep}`) ||
    rel === ".." ||
    rel.startsWith("../") ||
    rel.startsWith("..\\")
  ) {
    return false;
  }
  // Absolute relative() means different drive/root (win32)
  if (resolve(rel) === rel && rel.includes(":")) return false;
  return !rel.startsWith("..");
}

const { computeAuthHashV1, isHumanApprovalStamp, mintApprovedScopeArtifacts } = scopeProvenance;

export interface ParsedArgs {
  projectRoot: string;
  xbriefPath: string;
  actor: string;
  kind: string;
  /** Optional override for recorded xbriefRelPath (defaults: pending→active map). */
  xbriefRelPath: string;
  quiet: boolean;
  /** Explicit operator confirm for the #3110 human-presence mint (#3384). */
  confirm: boolean;
  /** Complete a previously opened harness-attended request (#7279). */
  requestId: string;
  /** Optional owner/name seed for preimage approvedRepos (#3385 R5). */
  repo: string;
  /** Repeatable `--add-path` widen requests (#6643); empty means the plain mint. */
  addPaths: string[];
  /** `--manifest <file>` cohort mint (#7083); empty means one brief. */
  manifest: string;
  /** Typed `--help` / `-h` (#4203); run() prints usage on stdout and exits 0. */
  help?: boolean;
  error?: string;
}

function usage(): string {
  return (
    "usage: scope:record-approved-scope -- <xbrief-path> --actor <name> --confirm " +
    "[--kind operator] [--project-root <dir>] [--xbrief-rel-path <posix>] [--repo owner/name] " +
    "[--add-path <p> ...] [--quiet]\n" +
    "       scope:record-approved-scope -- --manifest <file> --actor <name> --confirm " +
    "[--kind operator] [--project-root <dir>] [--repo owner/name] [--quiet]\n" +
    "  Writes .deft/approved-scope/<plan-id>.json and <plan-id>.intent.json (#3205 / #3384 / #3385).\n" +
    "  --add-path (repeatable, #6643) widens the brief's file_scope through a brief-only PR cut from " +
    "the delivery tip in a temporary checkout; the bound worktree is not changed.\n" +
    "  --manifest (#7083) takes a JSON array of { xbrief_path, worktree_path } rows, prints " +
    "each story's plan id, brief, worktree, file_scope, acceptance and intent digest, asks for " +
    "the typed mint once, and writes each record pair into that story's worktree.\n" +
    "  --actor is display only and never authorizes mint. Mint requires a real TTY, " +
    "controlling terminal, --confirm, and typed phrase mint (#3110). Under agent/CI " +
    "markers, open a harness-attended request and confirm via controlling-TTY phrase or " +
    "host-authenticated user-event (--request-id); markers may stay set; bare chat-yes " +
    "is request-open only (#7279)."
  );
}

/**
 * Map pending/ → active/ for path-bound approval records.
 * Returns null when the source cannot be expressed as a repo-relative path under projectRoot
 * (absolute outside-root paths must not be stamped into xbriefRelPath — #3205 Greptile).
 */
export function resolveApprovalXbriefRelPath(
  sourceRelOrAbs: string,
  projectRoot: string,
  override?: string,
): string | null {
  if (override !== undefined && override.trim().length > 0) {
    const o = override.replace(/\\/g, "/").replace(/^\.\//, "");
    if (o.startsWith("/") || /^[A-Za-z]:\//.test(o)) return null;
    return o;
  }
  const root = resolve(projectRoot);
  const abs = resolve(
    sourceRelOrAbs.includes(":") ||
      sourceRelOrAbs.startsWith("/") ||
      sourceRelOrAbs.startsWith("\\")
      ? sourceRelOrAbs
      : join(root, sourceRelOrAbs),
  );
  // Lexical + realpath containment (symlink to outside root must fail closed — #3205 Greptile).
  if (!isPathInsideRoot(root, abs)) {
    return null;
  }
  let rel = relative(root, abs).replace(/\\/g, "/");
  if (rel.length === 0 || rel.startsWith("../") || rel === "..") {
    return null;
  }
  try {
    if (existsSync(abs) && lstatSync(abs).isSymbolicLink() && !isPathInsideRoot(root, abs)) {
      return null;
    }
  } catch {
    return null;
  }
  // Normalize pending → active for future-active binding (issue #3205 multi-PR).
  if (rel.startsWith("xbrief/pending/")) {
    rel = `xbrief/active/${basename(rel)}`;
  } else if (rel.startsWith("vbrief/pending/")) {
    rel = `vbrief/active/${basename(rel)}`;
  }
  return rel;
}

export function parseArgs(argv: string[]): ParsedArgs {
  const parsed: ParsedArgs = {
    projectRoot: ".",
    xbriefPath: "",
    actor: "",
    kind: "operator",
    xbriefRelPath: "",
    quiet: false,
    confirm: false,
    requestId: "",
    repo: "",
    addPaths: [],
    manifest: "",
  };
  const positionals: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--") {
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      return { ...parsed, help: true };
    }
    if (arg === "--quiet") {
      parsed.quiet = true;
    } else if (arg === "--confirm") {
      parsed.confirm = true;
    } else if (arg === "--request-id" || arg === "--requestId") {
      const value = argv[i + 1];
      if (value === undefined || value === "--") {
        return { ...parsed, error: "argument --request-id: expected one argument" };
      }
      parsed.requestId = value;
      i += 1;
    } else if (arg?.startsWith("--request-id=")) {
      parsed.requestId = arg.slice("--request-id=".length);
    } else if (arg?.startsWith("--requestId=")) {
      parsed.requestId = arg.slice("--requestId=".length);
    } else if (arg === "--project-root") {
      const value = argv[i + 1];
      if (value === undefined || value === "--") {
        return { ...parsed, error: "argument --project-root: expected one argument" };
      }
      parsed.projectRoot = value;
      i += 1;
    } else if (arg?.startsWith("--project-root=")) {
      parsed.projectRoot = arg.slice("--project-root=".length);
    } else if (arg === "--actor") {
      const value = argv[i + 1];
      if (value === undefined || value === "--") {
        return { ...parsed, error: "argument --actor: expected one argument" };
      }
      parsed.actor = value;
      i += 1;
    } else if (arg?.startsWith("--actor=")) {
      const value = arg.slice("--actor=".length);
      if (value.length === 0 || value === "--") {
        return { ...parsed, error: "argument --actor: expected one argument" };
      }
      parsed.actor = value;
    } else if (arg === "--kind") {
      const value = argv[i + 1];
      if (value === undefined || value === "--") {
        return { ...parsed, error: "argument --kind: expected one argument" };
      }
      parsed.kind = value;
      i += 1;
    } else if (arg?.startsWith("--kind=")) {
      const value = arg.slice("--kind=".length);
      if (value.length === 0 || value === "--") {
        return { ...parsed, error: "argument --kind: expected one argument" };
      }
      parsed.kind = value;
    } else if (arg === "--xbrief-rel-path") {
      const value = argv[i + 1];
      if (value === undefined || value === "--") {
        return { ...parsed, error: "argument --xbrief-rel-path: expected one argument" };
      }
      parsed.xbriefRelPath = value;
      i += 1;
    } else if (arg?.startsWith("--xbrief-rel-path=")) {
      parsed.xbriefRelPath = arg.slice("--xbrief-rel-path=".length);
    } else if (arg === "--repo") {
      const value = argv[i + 1];
      if (value === undefined || value === "--") {
        return { ...parsed, error: "argument --repo: expected one argument" };
      }
      parsed.repo = value;
      i += 1;
    } else if (arg?.startsWith("--repo=")) {
      parsed.repo = arg.slice("--repo=".length);
    } else if (arg === "--add-path") {
      const value = argv[i + 1];
      if (value === undefined || value === "--") {
        return { ...parsed, error: "argument --add-path: expected one argument" };
      }
      parsed.addPaths.push(value);
      i += 1;
    } else if (arg?.startsWith("--add-path=")) {
      const value = arg.slice("--add-path=".length);
      if (value.length === 0 || value === "--") {
        return { ...parsed, error: "argument --add-path: expected one argument" };
      }
      parsed.addPaths.push(value);
    } else if (arg === "--manifest") {
      const value = argv[i + 1];
      if (value === undefined || value === "--") {
        return { ...parsed, error: "argument --manifest: expected one argument" };
      }
      parsed.manifest = value;
      i += 1;
    } else if (arg?.startsWith("--manifest=")) {
      parsed.manifest = arg.slice("--manifest=".length);
    } else if (arg?.startsWith("-")) {
      return { ...parsed, error: `unrecognized argument: ${arg}` };
    } else if (arg !== undefined) {
      positionals.push(arg);
    }
  }
  if (parsed.help) {
    return parsed;
  }
  if (parsed.manifest.length > 0) {
    if (positionals.length > 0) {
      return {
        ...parsed,
        error: "--manifest takes no xBRIEF path; name the briefs in the manifest",
      };
    }
    if (parsed.addPaths.length > 0) {
      return {
        ...parsed,
        error: "--add-path stays single-brief; it cannot be used with --manifest",
      };
    }
    if (parsed.xbriefRelPath.length > 0) {
      return { ...parsed, error: "--xbrief-rel-path cannot be used with --manifest" };
    }
    if (parsed.actor.trim().length === 0) {
      return {
        ...parsed,
        error: `argument --actor is required (human operator identity)\n${usage()}`,
      };
    }
    return parsed;
  }
  if (positionals.length === 0) {
    return { ...parsed, error: `missing xBRIEF path\n${usage()}` };
  }
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
  return parsed;
}

/** Local ref in the temporary clone that names the fetched delivery tip. */
const WIDEN_BASE_REF = "refs/deft/widen-base";

/** Process seams for the `--add-path` widen flow (#6643); tests inject fakes. */
export interface WidenSeams {
  git?: (cwd: string, args: string[]) => ToolResult;
  gh?: (cwd: string, args: string[]) => ToolResult;
  makeTempDir?: () => string;
  removeDir?: (dir: string) => void;
  /** Runs `verify:docs-impact --body-file` on the generated PR body; 0 passes. */
  verifyBody?: (bodyFile: string, root: string, baseRef: string) => number;
}

interface ToolResult {
  status: number;
  stdout: string;
  stderr: string;
}

function spawnTool(bin: string, cwd: string, args: string[]): ToolResult {
  const r = spawnSync(bin, args, { cwd, encoding: "utf8" });
  return {
    status: r.status ?? 1,
    stdout: r.stdout ?? "",
    stderr: r.stderr ?? r.error?.message ?? "",
  };
}

/** Normalize one `--add-path` value to a repo-relative posix path, or null when unsafe. */
export function normalizeAddPath(value: string): string | null {
  const v = value.trim().replace(/\\/g, "/").replace(/^\.\//, "");
  if (v.length === 0 || v.startsWith("/") || /^[A-Za-z]:/.test(v)) return null;
  if (v.split("/").some((seg) => seg === ".." || seg === "" || seg === ".")) return null;
  return v;
}

/**
 * Widen a story's `file_scope` from its bound worktree without writing there (#6643).
 * Works in a temporary clone of the delivery tip, mints the record and preimage for the
 * widened brief, pushes `widen/<plan-id>` and opens a brief-only PR. The caller has already
 * passed the human-presence mint gate; no checkout, branch or PR is made before it.
 */
function runWiden(input: {
  projectRoot: string;
  xbriefRelPath: string;
  payload: unknown;
  addPaths: string[];
  stamp: { kind: string; actor: string; mintedAt: string; mintedVia: string };
  repo: string;
  quiet: boolean;
  seams: WidenSeams;
}): number {
  const git = input.seams.git ?? ((cwd, args) => spawnTool("git", cwd, args));
  const gh = input.seams.gh ?? ((cwd, args) => spawnTool("gh", cwd, args));
  const fail = (msg: string): number => {
    process.stderr.write(`scope_record_approved_scope: --add-path: ${msg}\n`);
    return 1;
  };
  const added: string[] = [];
  for (const raw of input.addPaths) {
    const n = normalizeAddPath(raw);
    if (n === null) {
      process.stderr.write(
        `scope_record_approved_scope: --add-path must be a repo-relative path without '..': ${raw}\n`,
      );
      return 2;
    }
    if (!added.includes(n)) added.push(n);
  }
  const planId = scopeProvenance.extractPlanId(input.payload);
  if (planId === null) return fail("the brief has no plan.id");
  const origin = git(input.projectRoot, ["remote", "get-url", "origin"]);
  if (origin.status !== 0) return fail(`no origin remote (${origin.stderr.trim()})`);
  const originUrl = origin.stdout.trim();
  const delivery = resolveDeliveryBranch(input.projectRoot).branch;
  // Strict ref shape: never starts with `-`, no `..`, so it cannot read as a git option (#6643).
  if (!/^[A-Za-z0-9_][A-Za-z0-9._/-]*$/.test(delivery) || delivery.includes("..")) {
    return fail(`delivery branch name is not a plain ref name: ${delivery}`);
  }
  const safeId = planId.replace(/[^a-zA-Z0-9._-]/g, "_");
  const recordRel = `.deft/approved-scope/${safeId}.json`;
  const intentRel = scopeProvenance.approvedScopeIntentRel(planId);
  // A fresh branch per run: a retained branch from an earlier widen cannot block the push.
  const branch = `widen/${safeId}-${Date.now().toString(36)}`;
  const gitConfigValue = (key: string): string | null => {
    const r = git(input.projectRoot, ["config", "--get", key]);
    const v = r.stdout.trim();
    return r.status === 0 && v.length > 0 ? v : null;
  };
  const userName = gitConfigValue("user.name");
  const userEmail = gitConfigValue("user.email");
  const identityArgs = [
    ...(userName !== null ? ["-c", `user.name=${userName}`] : []),
    ...(userEmail !== null ? ["-c", `user.email=${userEmail}`] : []),
  ];
  const tmp = (input.seams.makeTempDir ?? (() => mkdtempSync(join(tmpdir(), "deft-widen-"))))();
  const cleanup =
    input.seams.removeDir ?? ((d: string) => rmSync(d, { recursive: true, force: true }));
  try {
    const clone = git(input.projectRoot, [
      "clone",
      "--quiet",
      "--shared",
      "--no-checkout",
      "--",
      input.projectRoot,
      tmp,
    ]);
    if (clone.status !== 0) return fail(`temporary clone failed (${clone.stderr.trim()})`);
    for (const args of [
      ["remote", "set-url", "--", "origin", originUrl],
      // Fully qualified ref: a tag of the same name cannot be selected.
      ["fetch", "--quiet", "--", "origin", `refs/heads/${delivery}`],
      ["checkout", "--quiet", "--detach", "FETCH_HEAD"],
      // A ref the body check can resolve in this clone (FETCH_HEAD is not one it accepts).
      ["update-ref", WIDEN_BASE_REF, "FETCH_HEAD"],
    ]) {
      const r = git(tmp, args);
      if (r.status !== 0) return fail(`git ${args[0]} failed (${r.stderr.trim()})`);
    }
    const briefAbs = join(tmp, input.xbriefRelPath);
    if (!existsSync(briefAbs)) {
      return fail(`${input.xbriefRelPath} is not on origin/${delivery}; activate it first`);
    }
    const tipRaw = readFileSync(briefAbs, "utf8");
    const tipParsed = scopeProvenance.parseJsonRejectingDuplicateKeys(tipRaw);
    if (!tipParsed.ok) return fail(tipParsed.error);
    const tipPayload = tipParsed.value as Record<string, unknown>;
    if (scopeProvenance.extractPlanId(tipPayload) !== planId) {
      return fail("the delivery-tip brief has a different plan.id");
    }
    const plan = tipPayload.plan as Record<string, unknown>;
    const metadata = (plan.metadata ?? {}) as Record<string, unknown>;
    const swarm = (metadata.swarm ?? {}) as Record<string, unknown>;
    const merged: unknown[] = Array.isArray(swarm.file_scope) ? [...swarm.file_scope] : [];
    // The approval pair rides in the PR only at merge-base `onePrScopeProof: mint`. At any other
    // level a brief-only change is what the gate admits; a co-changed record is refused as
    // self-authorizing-scope-expansion, and proceed writes no digest (#4956).
    let pdRaw: string | null = null;
    try {
      pdRaw = readFileSync(join(tmp, "xbrief", "PROJECT-DEFINITION.xbrief.json"), "utf8");
    } catch {
      pdRaw = null;
    }
    const withPair =
      evaluateOnePrScopeProofGate({ baseRaw: pdRaw, headRaw: pdRaw }).kind === "mint";
    for (const p of withPair ? [...added, recordRel, intentRel] : added) {
      if (!merged.includes(p)) merged.push(p);
    }
    swarm.file_scope = merged;
    metadata.swarm = swarm;
    plan.metadata = metadata;
    let nextRaw = `${JSON.stringify(tipPayload, null, 2)}\n`;
    if (tipRaw.includes("\r\n")) nextRaw = nextRaw.replace(/\n/g, "\r\n");
    writeFileSync(briefAbs, nextRaw, "utf8");
    if (withPair) {
      const repoSeed = slice.resolveProjectRepo(
        input.repo.length > 0 ? input.repo : undefined,
        tmp,
      );
      const authHashV1 = computeAuthHashV1(tipPayload, input.xbriefRelPath);
      try {
        mintApprovedScopeArtifacts({
          xbriefRelPath: input.xbriefRelPath,
          payload: tipPayload,
          rawText: nextRaw,
          projectRoot: tmp,
          humanApproval: input.stamp,
          ...(authHashV1 !== null ? { authHashV1 } : {}),
          extract: { projectRoot: tmp, approvedReposSeed: repoSeed !== null ? [repoSeed] : [] },
        });
      } catch (err: unknown) {
        return fail(String(err));
      }
    }
    const title = `chore(xbrief): widen file_scope for ${planId}`;
    const staged = withPair ? [input.xbriefRelPath, recordRel, intentRel] : [input.xbriefRelPath];
    for (const args of [
      ["checkout", "--quiet", "-b", branch],
      ["add", "-f", "--", ...staged],
      [...identityArgs, "commit", "--quiet", "-m", `${title}\n\nAdds: ${added.join(", ")}`],
    ]) {
      const r = git(tmp, args);
      if (r.status !== 0) {
        const verb = args.includes("commit") ? "commit" : args[0];
        return fail(`git ${verb} failed (${r.stderr.trim()})`);
      }
    }
    const bodyPath = join(tmp, ".widen-pr-body.txt");
    writeFileSync(
      bodyPath,
      [
        "## Summary",
        "",
        `Brief-only widen of the file scope for \`${planId}\`. Added paths:`,
        ...added.map((p) => `- \`${p}\``),
        "",
        "## Documentation impact",
        "",
        "change_class: none",
        "surfaces: none",
        `rationale: "Lifecycle only: one brief${withPair ? ", its approval record and its intent preimage change" : " changes"}."`,
        "",
      ].join("\n"),
      "utf8",
    );
    // Explicit --body-file skips the PR template: check the declaration on these same bytes.
    const verifyBody =
      input.seams.verifyBody ??
      ((file: string, root: string, baseRef: string) =>
        verifyDocsImpactBodyFile(file, root, { baseRef }));
    const bodyCode = verifyBody(bodyPath, tmp, WIDEN_BASE_REF);
    if (bodyCode !== 0) {
      return fail(
        `verify:docs-impact --body-file failed (exit ${String(bodyCode)}); nothing was pushed`,
      );
    }
    const pushed = git(tmp, ["push", "--quiet", "--", "origin", `HEAD:refs/heads/${branch}`]);
    if (pushed.status !== 0) return fail(`git push failed (${pushed.stderr.trim()})`);
    const pr = gh(tmp, [
      "pr",
      "create",
      "--base",
      delivery,
      "--head",
      branch,
      "--title",
      title,
      "--body-file",
      bodyPath,
    ]);
    if (pr.status !== 0) {
      return fail(`gh pr create failed (${pr.stderr.trim()}); branch ${branch} was pushed`);
    }
    if (!input.quiet) {
      process.stdout.write(
        `scope_record_approved_scope: widen PR ${pr.stdout.trim()}\n` +
          `  added: ${added.join(", ")}\n` +
          "  The bound worktree was not changed. After the PR merges, rebase the story.\n",
      );
    }
    return 0;
  } finally {
    cleanup(tmp);
  }
}

/** Approved-scope stamp: human (`isHumanApprovalStamp`) or delegated (#7420). */
type ApprovalStamp = {
  kind: string;
  actor: string;
  mintedAt: string;
  mintedVia: string;
  delegationId?: string;
  expiresAt?: string;
};

/**
 * Delegated stamp for a delegated completion (#7420 B4): expiry is the
 * earliest of the delegation's expiry and the delegated-authority cap. Null
 * when the delegation is no longer live (nothing is written then).
 */
export function delegatedApprovalStampFor(
  projectRoot: string,
  completion: DelegatedCompletion,
  base: ApprovalStamp,
  now: Date = new Date(),
  delegationStoreRoot?: string,
): ApprovalStamp | null {
  if (completion.verb !== "scope:record-approved-scope" || completion.template !== null) {
    return null;
  }
  const live = readLiveDelegation(projectRoot, {
    now,
    ...(delegationStoreRoot !== undefined ? { storeRoot: delegationStoreRoot } : {}),
  });
  if (!isDelegationIdLive(live, completion.delegationId) || live === null) return null;
  const capMs = now.getTime() + DELEGATED_AUTHORITY_MAX_EXPIRY_HOURS * 3600 * 1000;
  const expiresMs = Math.min(Date.parse(live.expiresAt), capMs);
  if (!(expiresMs > now.getTime())) return null;
  return buildDelegatedApprovalStamp({
    actor: base.actor,
    delegationId: completion.delegationId,
    expiresAt: new Date(expiresMs).toISOString().replace(/\.\d{3}Z$/, "Z"),
    mintedAt: now.toISOString().replace(/\.\d{3}Z$/, "Z"),
  }) as ApprovalStamp;
}

/** Audit line plus one chat line for a delegated approved-scope write (#7420 B8). */
function announceDelegatedStamp(
  projectRoot: string,
  planId: string,
  completion: DelegatedCompletion,
  stamp: ApprovalStamp,
  mode: "mint" | "widen",
): void {
  appendDelegationAudit(resolveDelegationStoreRoot(projectRoot), {
    schemaVersion: DELEGATION_SCHEMA_VERSION,
    ts: stamp.mintedAt,
    event: "delegated-mint",
    provenance: DELEGATED_TOTP_PROVENANCE,
    delegationId: completion.delegationId,
    hostSessionId: completion.hostSessionId,
    detail: `scope:record-approved-scope ${mode} plan=${planId} request=${completion.requestId} expires=${stamp.expiresAt ?? "-"}`,
  });
  process.stdout.write(
    `${DELEGATED_ACTION_CHAT_LINE_PREFIX} scope:record-approved-scope ${mode} for ${planId} ` +
      `under delegation ${completion.delegationId} (stamp ${stamp.kind}, expires ${stamp.expiresAt ?? "-"}; ` +
      "only the scope-provenance fence accepts it, and only while the delegation is live).\n",
  );
}

export function run(
  argv: string[],
  seams: HumanPresenceMintSeams = {},
  widenSeams: WidenSeams = {},
  cohortSeams: CohortWriteSeams = {},
): number {
  const args = parseArgs(argv);
  if (args.help) {
    process.stdout.write(`${usage()}\n`);
    return 0;
  }
  if (args.error !== undefined) {
    process.stderr.write(`scope_record_approved_scope: ${args.error}\n`);
    return 2;
  }
  const projectRoot = resolve(args.projectRoot);
  if (args.manifest.length > 0) {
    return runCohort(argv, args, projectRoot, seams, cohortSeams);
  }
  const xbriefAbs = resolve(projectRoot, args.xbriefPath);
  if (!existsSync(xbriefAbs)) {
    // Also try absolute path as given
    const alt = resolve(args.xbriefPath);
    if (!existsSync(alt)) {
      process.stderr.write(`scope_record_approved_scope: xBRIEF not found: ${args.xbriefPath}\n`);
      return 2;
    }
  }
  const fullPath = existsSync(xbriefAbs) ? xbriefAbs : resolve(args.xbriefPath);
  if (!isPathInsideRoot(projectRoot, fullPath)) {
    process.stderr.write(
      "scope_record_approved_scope: xBRIEF path escapes --project-root " +
        "(symlink or absolute outside-root targets refused) (#3205).\n",
    );
    return 2;
  }
  let raw: string;
  try {
    raw = readFileSync(fullPath, "utf8");
  } catch (err: unknown) {
    process.stderr.write(`scope_record_approved_scope: failed to read xBRIEF: ${String(err)}\n`);
    return 2;
  }
  const parsed = scopeProvenance.parseJsonRejectingDuplicateKeys(raw);
  if (!parsed.ok) {
    process.stderr.write(`scope_record_approved_scope: ${parsed.error}\n`);
    return 2;
  }
  const payload = parsed.value;

  const verb = "scope:record-approved-scope";
  const uatBlocked = refuseMintWhileUatActive(verb, projectRoot);
  if (uatBlocked !== null) return uatBlocked;

  let stamp: ApprovalStamp = {
    kind: args.kind.trim(),
    actor: args.actor.trim(),
    mintedAt: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
    mintedVia: "scope:record-approved-scope",
  };
  if (!isHumanApprovalStamp(stamp)) {
    process.stderr.write(
      "scope_record_approved_scope: refused agent/non-human stamp " +
        `(kind=${stamp.kind}, actor=${stamp.actor}). Use a human operator actor ` +
        "and kind in {operator,human,user,cli,github-user,interactive,renewed-approval} (#3205).\n",
    );
    return 1;
  }

  const xbriefRelPath = resolveApprovalXbriefRelPath(
    fullPath,
    projectRoot,
    args.xbriefRelPath.length > 0 ? args.xbriefRelPath : undefined,
  );
  if (xbriefRelPath === null) {
    process.stderr.write(
      "scope_record_approved_scope: xBRIEF path must resolve under --project-root " +
        "(repo-relative path required for approval binding) (#3205).\n",
    );
    return 2;
  }
  const planId = scopeProvenance.extractPlanId(payload);
  if (planId === null) {
    process.stderr.write("scope_record_approved_scope: the brief has no plan.id\n");
    return 2;
  }
  // Freeze destinations before confirm so harness-attended binding is concrete (#7279).
  const destinations = [
    scopeProvenance.approvedScopeRecordPath(projectRoot, planId),
    scopeProvenance.approvedScopeIntentPath(projectRoot, planId),
  ];
  const resolved = resolveHumanPresenceMintSeams(seams);
  // A live TOTP delegation may complete this request (#7420 B3).
  const delegated: { completion: DelegatedCompletion | null } = { completion: null };
  const mintBlocked = refuseNonInteractiveMint({
    verb,
    confirm: args.confirm,
    isTty: resolved.isTty,
    environ: resolved.environ,
    hasControllingTerminal: resolved.hasControllingTerminal,
    readInteractiveConfirm: resolved.readInteractiveConfirm,
    readHostAuthenticatedConfirm: resolved.readHostAuthenticatedConfirm,
    readDelegatedConfirm: resolved.readDelegatedConfirm,
    operatorStop: {
      projectRoot,
      args: mintArgsAfterVerb(argv, null),
      record: resolved.recordOperatorStop,
    },
    harnessAttended: {
      destinations,
      ...(args.requestId.trim().length > 0 ? { requestId: args.requestId.trim() } : {}),
      delegation: { template: null },
      onDelegatedCompletion: (c) => {
        delegated.completion = c;
      },
    },
  });
  if (mintBlocked !== null) return mintBlocked;
  // Fresh UAT recheck at confirm time (#7279).
  const uatRecheck = refuseMintWhileUatActive(verb, projectRoot);
  if (uatRecheck !== null) return uatRecheck;
  if (delegated.completion !== null) {
    const delegatedStamp = delegatedApprovalStampFor(projectRoot, delegated.completion, stamp);
    if (delegatedStamp === null) {
      process.stderr.write(
        `scope_record_approved_scope: delegation ${delegated.completion.delegationId} ` +
          "is no longer live; nothing written (#7420).\n",
      );
      return 2;
    }
    stamp = delegatedStamp;
  }

  if (args.addPaths.length > 0) {
    const widened = runWiden({
      projectRoot,
      xbriefRelPath,
      payload,
      addPaths: args.addPaths,
      stamp,
      repo: args.repo.trim(),
      quiet: args.quiet,
      seams: widenSeams,
    });
    if (widened === 0 && delegated.completion !== null) {
      announceDelegatedStamp(projectRoot, planId, delegated.completion, stamp, "widen");
    }
    return widened;
  }
  const repoSeed = slice.resolveProjectRepo(
    args.repo.trim().length > 0 ? args.repo.trim() : undefined,
    projectRoot,
  );
  const authHashV1 = computeAuthHashV1(payload, xbriefRelPath);
  // Mint writes record + preimage as one fail-closed pair. A dest-write
  // failure restores the prior pair or leaves neither dest (#3385 residual).
  let minted: ReturnType<typeof mintApprovedScopeArtifacts>;
  try {
    minted = mintApprovedScopeArtifacts({
      xbriefRelPath,
      payload,
      rawText: raw,
      projectRoot,
      humanApproval: stamp,
      // Bind the record to the brief's auth-hash v1 for the one-PR mint level (#6273).
      ...(authHashV1 !== null ? { authHashV1 } : {}),
      extract: {
        projectRoot,
        approvedReposSeed: repoSeed !== null ? [repoSeed] : [],
      },
    });
  } catch (err: unknown) {
    process.stderr.write(`scope_record_approved_scope: ${String(err)}\n`);
    return 1;
  }
  const { record, recordPath, intentPath } = minted;
  if (delegated.completion !== null) {
    announceDelegatedStamp(projectRoot, planId, delegated.completion, stamp, "mint");
  }
  if (!args.quiet) {
    process.stdout.write(
      `scope_record_approved_scope: wrote ${recordPath}\n` +
        `  preimage: ${intentPath}\n` +
        `  planId: ${record.planId}\n` +
        `  xbriefRelPath: ${record.xbriefRelPath}\n` +
        `  fileScopeDigest: ${record.fileScopeDigest}\n` +
        `  intentDigest: ${record.intentDigest ?? ""}\n` +
        `  authHashV1: ${record.authHashV1 ?? ""}\n` +
        `  paths: ${record.fileScope.length}\n` +
        `  humanApproval: ${stamp.kind}/${stamp.actor}\n` +
        "  Read the preimage before you commit. That file is the approved intent (#3385).\n" +
        "  Next: commit record + preimage on the merge base (or a prior PR) before " +
        "activation/expansion in the implementation change set (#3205 / #3385).\n" +
        "  At merge-base onePrScopeProof=mint, the pair may ride in the same PR as the " +
        "brief and its code (#6273 / #6354).\n",
    );
  }
  return 0;
}

/**
 * Cohort mint (#7083): build and freeze every pair, refuse the whole set before the
 * prompt on any refusal, print each story, take the typed mint once, then write each
 * pair into its own worktree. A failed run removes only the files it created.
 */
function runCohort(
  argv: string[],
  args: ParsedArgs,
  projectRoot: string,
  seams: HumanPresenceMintSeams,
  cohortSeams: CohortWriteSeams,
): number {
  const verb = "scope:record-approved-scope";
  const manifest = readCohortManifest(projectRoot, args.manifest);
  if (!manifest.ok) {
    process.stderr.write(`scope_record_approved_scope: --manifest: ${manifest.error}\n`);
    return 2;
  }
  // Every root that receives a pair is checked for an active UAT lease, not only
  // the project root.
  const roots = [
    projectRoot,
    ...manifest.entries.map((entry) => resolve(projectRoot, entry.worktreePath)),
  ];
  for (const root of new Set(roots)) {
    const uatBlocked = refuseMintWhileUatActive(verb, root);
    if (uatBlocked !== null) return uatBlocked;
  }
  const stamp = {
    kind: args.kind.trim(),
    actor: args.actor.trim(),
    mintedAt: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
    mintedVia: "scope:record-approved-scope",
  };
  if (!isHumanApprovalStamp(stamp)) {
    process.stderr.write(
      "scope_record_approved_scope: refused agent/non-human stamp " +
        `(kind=${stamp.kind}, actor=${stamp.actor}) (#3205).\n`,
    );
    return 1;
  }
  const prepared = prepareCohortMint({
    entries: manifest.entries,
    projectRoot,
    stamp,
    repo: args.repo.trim(),
  });
  if (!prepared.ok) {
    process.stderr.write(
      "scope_record_approved_scope: --manifest refused the whole set before the prompt; " +
        `nothing was written:\n${prepared.errors.map((e) => `  - ${e}\n`).join("")}`,
    );
    return 1;
  }
  process.stdout.write(formatCohortPlan(prepared.stories));
  if (prepared.stories.every((s) => s.existing === "identical")) {
    process.stdout.write(
      "scope_record_approved_scope: every pair is already present; nothing to write.\n",
    );
    return 0;
  }
  const destinations = prepared.stories.flatMap((s) => [s.recordPath, s.intentPath]);
  const resolved = resolveHumanPresenceMintSeams(seams);
  const mintBlocked = refuseNonInteractiveMint({
    verb,
    confirm: args.confirm,
    isTty: resolved.isTty,
    environ: resolved.environ,
    hasControllingTerminal: resolved.hasControllingTerminal,
    readInteractiveConfirm: resolved.readInteractiveConfirm,
    readHostAuthenticatedConfirm: resolved.readHostAuthenticatedConfirm,
    operatorStop: {
      projectRoot,
      args: mintArgsAfterVerb(argv, null),
      record: resolved.recordOperatorStop,
    },
    harnessAttended: {
      destinations,
      ...(args.requestId.trim().length > 0 ? { requestId: args.requestId.trim() } : {}),
    },
  });
  if (mintBlocked !== null) return mintBlocked;
  // Fresh UAT recheck across every destination root at confirm time (#7279).
  for (const root of new Set(roots)) {
    const uatRecheck = refuseMintWhileUatActive(verb, root);
    if (uatRecheck !== null) return uatRecheck;
  }
  const written = writeCohortPairs(prepared.stories, cohortSeams);
  if (!written.ok) {
    process.stderr.write(
      `scope_record_approved_scope: --manifest write failed (${written.error}); ` +
        `removed the ${String(written.removed.length)} file(s) this run created.\n`,
    );
    return 1;
  }
  if (!args.quiet) {
    process.stdout.write(formatCohortNext(prepared.stories, written.written));
  }
  return 0;
}

if (isDirectEntrypoint(import.meta.url)) {
  process.exit(run(process.argv.slice(2)));
}
