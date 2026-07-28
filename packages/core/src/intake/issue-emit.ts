import { globSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { referenceTypeMatches } from "@deftai/directive-types";
import { assertWriteTargetSafe, ProjectionContainmentError } from "../fs/projection-containment.js";
import { call } from "../scm/call.js";
import { resolveProjectRoot } from "../scope/project-context.js";
import { resolveProjectRepo } from "../slice/project-context.js";
import type { ScmCallFn } from "./reconcile-issues.js";

export const GITHUB_ISSUE_REF_TYPE = "x-xbrief/github-issue";
export const EXTERNAL_TRUST_LEVEL = "external";

const ISSUE_URL_PATTERN = /https?:\/\/\S+?\/issues\/\d+/;

export class IssueEmitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IssueEmitError";
  }
}

/** Contained durable map: abs vbrief path -> issue URL for in-flight emits (#2871). */
export function pendingEmitLedgerPath(projectRoot: string): string {
  return join(resolve(projectRoot), ".deft-cache", "issue-emit-pending.json");
}

export function loadPendingEmitUrls(projectRoot: string): Record<string, string> {
  const ledger = pendingEmitLedgerPath(projectRoot);
  try {
    assertWriteTargetSafe(projectRoot, ledger);
    const raw = readFileSync(ledger, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      const out: Record<string, string> = {};
      for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
        if (typeof v === "string" && v.length > 0) {
          out[k] = v;
        }
      }
      return out;
    }
  } catch {
    // Missing or unreadable ledger is empty.
  }
  return {};
}

export function savePendingEmitUrl(projectRoot: string, vbriefAbsPath: string, url: string): void {
  const ledger = pendingEmitLedgerPath(projectRoot);
  assertWriteTargetSafe(projectRoot, ledger);
  mkdirSync(dirname(ledger), { recursive: true });
  const map = loadPendingEmitUrls(projectRoot);
  map[resolve(vbriefAbsPath)] = url;
  assertWriteTargetSafe(projectRoot, ledger);
  writeFileSync(ledger, `${JSON.stringify(map, null, 2)}\n`, "utf8");
}

export function clearPendingEmitUrl(projectRoot: string, vbriefAbsPath: string): void {
  const ledger = pendingEmitLedgerPath(projectRoot);
  const key = resolve(vbriefAbsPath);
  const map = loadPendingEmitUrls(projectRoot);
  if (!(key in map)) {
    return;
  }
  delete map[key];
  try {
    assertWriteTargetSafe(projectRoot, ledger);
    mkdirSync(dirname(ledger), { recursive: true });
    writeFileSync(ledger, `${JSON.stringify(map, null, 2)}\n`, "utf8");
  } catch {
    // Best-effort clear; next successful stamp still works via existingGithubIssueRef.
  }
}

export function loadVbrief(path: string): Record<string, unknown> {
  const data = JSON.parse(readFileSync(path, "utf8")) as unknown;
  return data !== null && typeof data === "object" && !Array.isArray(data)
    ? (data as Record<string, unknown>)
    : {};
}

/**
 * Resolve project root and refuse unsafe write targets before any emit side-effect.
 * Callers that create remote issues MUST invoke this before `fileIssue` so a
 * containment refusal cannot leave an orphan GitHub issue (#2869 / #2871).
 *
 * ⊗ Do not fall back to `dirname(path)` as the containment root — that trusts a
 * possibly-symlinked parent and would re-open the escape (Greptile P1 on #2871).
 */
export function assertVbriefWriteTargetSafe(path: string, projectRoot?: string | null): string {
  const absPath = resolve(path);
  // Resolve root only from explicit projectRoot, DEFT_PROJECT_ROOT, or cwd walk-up.
  // Never start discovery from dirname(absPath) — that trusts a possibly-symlinked parent
  // of the write target as the containment root (Greptile/SLizard P1 on #2871).
  const root =
    projectRoot !== undefined && projectRoot !== null && projectRoot.length > 0
      ? resolve(projectRoot)
      : resolveProjectRoot(null);
  if (root === null) {
    throw new ProjectionContainmentError(
      `projection write refused: could not resolve project root for ${absPath}; pass projectRoot or run from a project checkout`,
      {
        projectDir: process.cwd(),
        targetPath: absPath,
        offendingPath: absPath,
      },
    );
  }
  assertWriteTargetSafe(root, absPath);
  return root;
}

/**
 * Persist an xBRIEF/vBRIEF JSON document. Gates the write target so a leaf or
 * parent-directory symlink cannot divert the stamped file outside the project (#2869).
 */
export function writeVbrief(
  path: string,
  data: Record<string, unknown>,
  projectRoot?: string | null,
): void {
  assertVbriefWriteTargetSafe(path, projectRoot);
  writeFileSync(resolve(path), `${JSON.stringify(data, null, 2)}\n`, "utf8");
}

export function vbriefTitle(data: Record<string, unknown>): string {
  const plan = (data.plan ?? {}) as Record<string, unknown>;
  const title = plan.title;
  if (typeof title === "string" && title.trim().length > 0) {
    return title.trim();
  }
  const info = (data.vBRIEFInfo ?? {}) as Record<string, unknown>;
  const desc = info.description;
  if (typeof desc === "string" && desc.trim().length > 0) {
    return desc.trim();
  }
  return "Untitled vBRIEF";
}

export function existingGithubIssueRef(data: Record<string, unknown>): string | null | undefined {
  const plan = (data.plan ?? {}) as Record<string, unknown>;
  const refs = plan.references;
  if (!Array.isArray(refs)) {
    return undefined;
  }
  for (const ref of refs) {
    if (ref !== null && typeof ref === "object" && !Array.isArray(ref)) {
      const obj = ref as Record<string, unknown>;
      if (referenceTypeMatches(String(obj.type ?? ""), "github-issue")) {
        const uri = obj.uri ?? obj.url;
        return typeof uri === "string" && uri.length > 0 ? uri : "";
      }
    }
  }
  return undefined;
}

export function addGithubIssueReference(
  data: Record<string, unknown>,
  url: string,
): Record<string, unknown> {
  const plan = (data.plan ?? {}) as Record<string, unknown>;
  data.plan = plan;
  const refs = Array.isArray(plan.references) ? plan.references : [];
  refs.push({
    uri: url,
    type: GITHUB_ISSUE_REF_TYPE,
    TrustLevel: EXTERNAL_TRUST_LEVEL,
  });
  plan.references = refs;
  return data;
}

export function renderIssueBody(data: Record<string, unknown>): string {
  const plan = (data.plan ?? {}) as Record<string, unknown>;
  const narratives = (plan.narratives ?? {}) as Record<string, unknown>;
  const parts: string[] = [];

  const desc = narratives.Description;
  if (typeof desc === "string" && desc.trim().length > 0) {
    parts.push(`## Description\n\n${desc.trim()}`);
  }

  const acceptanceLines: string[] = [];
  const planAcceptance = narratives.Acceptance;
  if (typeof planAcceptance === "string" && planAcceptance.trim().length > 0) {
    acceptanceLines.push(planAcceptance.trim());
  }
  const items = plan.items;
  if (Array.isArray(items)) {
    for (const item of items) {
      if (item === null || typeof item !== "object" || Array.isArray(item)) {
        continue;
      }
      const itemObj = item as Record<string, unknown>;
      const narrative = (itemObj.narrative ?? {}) as Record<string, unknown>;
      const acc = narrative.Acceptance;
      if (typeof acc === "string" && acc.trim().length > 0) {
        const itemTitle = String(itemObj.title ?? "").trim();
        if (itemTitle.length > 0) {
          acceptanceLines.push(`- **${itemTitle}**: ${acc.trim()}`);
        } else {
          acceptanceLines.push(`- ${acc.trim()}`);
        }
      }
    }
  }
  if (acceptanceLines.length > 0) {
    parts.push(`## Acceptance\n\n${acceptanceLines.join("\n")}`);
  }

  const traces = narratives.Traces;
  if (typeof traces === "string" && traces.trim().length > 0) {
    parts.push(`## Traces\n\n${traces.trim()}`);
  }

  if (parts.length === 0) {
    return `Scope vBRIEF: ${vbriefTitle(data)}\n`;
  }
  return `${parts.join("\n\n")}\n`;
}

export function renderUmbrellaBody(
  entries: readonly [string, Record<string, unknown>][],
  intro?: string | null,
): string {
  const lines: string[] = [];
  if (intro !== undefined && intro !== null && intro.trim().length > 0) {
    lines.push(intro.trim(), "");
  }
  lines.push("## Tracked vBRIEFs", "");
  for (const [displayPath, data] of entries) {
    lines.push(`- [ ] ${vbriefTitle(data)} (\`${displayPath}\`)`);
  }
  return `${lines.join("\n")}\n`;
}

export function fileIssue(
  repo: string,
  title: string,
  body: string,
  scmCall: ScmCallFn = call,
): string {
  const tmpDir = mkdtempSync(join(tmpdir(), "deft-issue-emit-"));
  const bodyPath = join(tmpDir, "body.md");
  try {
    writeFileSync(bodyPath, body, "utf8");
    const result = scmCall(
      "github-issue",
      "issue",
      ["create", "--repo", repo, "--title", title, "--body-file", bodyPath],
      { timeout: 60 },
    );
    if (result.returncode !== 0) {
      throw new IssueEmitError(
        `gh issue create failed (exit ${result.returncode}): ${(result.stderr ?? "").trim()}`,
      );
    }
    const stdout = (result.stdout ?? "").trim();
    const match = ISSUE_URL_PATTERN.exec(stdout);
    if (match?.[0]) {
      return match[0];
    }
    if (stdout.length > 0) {
      return stdout;
    }
    throw new IssueEmitError("gh issue create succeeded but emitted no issue URL on stdout");
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

export interface EmitAction {
  result: "created" | "dryrun" | "skipped";
  vbrief: string;
  url?: string | null;
  title?: string;
}

export function emitSingle(
  path: string,
  options: {
    repo: string;
    scmCall?: ScmCallFn;
    noNetwork?: boolean;
    displayPath?: string | null;
    projectRoot?: string | null;
  },
): EmitAction {
  const shown = options.displayPath ?? path;
  const data = loadVbrief(path);
  const existing = existingGithubIssueRef(data);
  if (existing !== undefined) {
    return {
      result: "skipped",
      vbrief: shown,
      url: typeof existing === "string" && existing.length > 0 ? existing : null,
      title: vbriefTitle(data),
    };
  }

  const title = vbriefTitle(data);
  if (options.noNetwork) {
    return { result: "dryrun", vbrief: shown, url: null, title };
  }

  // Atomic emit contract (#2871 / Greptile):
  // 1) Resolve a trusted project root (never dirname of target).
  // 2) Reconcile any prior pending URL for this path (retry after partial failure).
  // 3) Pre-persist current payload so the write path is proven.
  // 4) Create remote issue, immediately record URL in a contained pending ledger.
  // 5) Stamp the vbrief; clear pending on success.
  const root = assertVbriefWriteTargetSafe(path, options.projectRoot);
  const absPath = resolve(path);
  const pending = loadPendingEmitUrls(root);
  const priorUrl = pending[absPath];
  if (typeof priorUrl === "string" && priorUrl.length > 0) {
    addGithubIssueReference(data, priorUrl);
    writeVbrief(path, data, root);
    clearPendingEmitUrl(root, absPath);
    return { result: "created", vbrief: shown, url: priorUrl, title };
  }

  writeVbrief(path, data, root);
  const body = renderIssueBody(data);
  assertVbriefWriteTargetSafe(path, root);
  const url = fileIssue(options.repo, title, body, options.scmCall);
  // Durable URL ledger BEFORE vbrief stamp — retry will reconcile without re-create.
  // Never lose the URL if ledger or stamp fails: return/throw always includes it (#2871).
  try {
    savePendingEmitUrl(root, absPath, url);
  } catch (ledgerErr) {
    try {
      addGithubIssueReference(data, url);
      writeVbrief(path, data, root);
      return { result: "created", vbrief: shown, url, title };
    } catch (stampErr) {
      throw new IssueEmitError(
        "created " +
          url +
          " but failed to persist local records: " +
          String(ledgerErr) +
          " / " +
          String(stampErr),
      );
    }
  }
  addGithubIssueReference(data, url);
  writeVbrief(path, data, root);
  clearPendingEmitUrl(root, absPath);
  return { result: "created", vbrief: shown, url, title };
}

export function emitPerVbrief(
  paths: string[],
  options: {
    repo: string;
    scmCall?: ScmCallFn;
    noNetwork?: boolean;
    displayPaths?: string[] | null;
    projectRoot?: string | null;
  },
): EmitAction[] {
  const shown = options.displayPaths ?? paths;
  const actions: EmitAction[] = [];
  for (let i = 0; i < paths.length; i += 1) {
    actions.push(
      emitSingle(paths[i] as string, {
        ...options,
        displayPath: shown[i] as string,
      }),
    );
  }
  return actions;
}

export interface UmbrellaAction {
  result: "created" | "dryrun" | "skipped";
  url: string | null;
  title: string;
  vbriefs: { vbrief: string; result: string }[];
}

function defaultUmbrellaTitle(count: number): string {
  const noun = count === 1 ? "vBRIEF" : "vBRIEFs";
  return `Umbrella: ${count} tracked ${noun}`;
}

export function emitUmbrella(
  paths: string[],
  options: {
    repo: string;
    scmCall?: ScmCallFn;
    noNetwork?: boolean;
    title?: string | null;
    displayPaths?: string[] | null;
    projectRoot?: string | null;
  },
): UmbrellaAction {
  const shown = options.displayPaths ?? paths;
  const loaded: [string, string, Record<string, unknown>][] = [];
  for (let i = 0; i < paths.length; i += 1) {
    loaded.push([paths[i] as string, shown[i] as string, loadVbrief(paths[i] as string)]);
  }

  const pending = loaded.filter(([, , data]) => existingGithubIssueRef(data) === undefined);
  const already = loaded
    .filter(([, , data]) => existingGithubIssueRef(data) !== undefined)
    .map(([, disp]) => ({ vbrief: disp, result: "skipped" }));

  const umbrellaTitle = options.title ?? defaultUmbrellaTitle(loaded.length);

  if (pending.length === 0) {
    return { result: "skipped", url: null, title: umbrellaTitle, vbriefs: already };
  }

  if (options.noNetwork) {
    return {
      result: "dryrun",
      url: null,
      title: umbrellaTitle,
      vbriefs: [...pending.map(([, disp]) => ({ vbrief: disp, result: "dryrun" })), ...already],
    };
  }

  // Umbrella emit: reconcile pending URLs, pre-persist, create once, stamp all (#2871).
  const root =
    options.projectRoot !== undefined &&
    options.projectRoot !== null &&
    options.projectRoot.length > 0
      ? resolve(options.projectRoot)
      : assertVbriefWriteTargetSafe(String(pending[0]?.[0] || ""), options.projectRoot);

  const written: { vbrief: string; result: string }[] = [];
  const stillNeedRemote: [string, string, Record<string, unknown>][] = [];
  for (const [path, disp, data] of pending) {
    const absPath = resolve(path);
    const prior = loadPendingEmitUrls(root)[absPath];
    if (typeof prior === "string" && prior.length > 0) {
      addGithubIssueReference(data, prior);
      writeVbrief(path, data, root);
      clearPendingEmitUrl(root, absPath);
      written.push({ vbrief: disp, result: "created" });
    } else {
      writeVbrief(path, data, root);
      stillNeedRemote.push([path, disp, data]);
    }
  }

  if (stillNeedRemote.length === 0) {
    return {
      result: "created",
      url: null,
      title: umbrellaTitle,
      vbriefs: [...written, ...already],
    };
  }

  const body = renderUmbrellaBody(stillNeedRemote.map(([, disp, data]) => [disp, data]));
  const url = fileIssue(options.repo, umbrellaTitle, body, options.scmCall);
  for (const [path, ,] of stillNeedRemote) {
    savePendingEmitUrl(root, path, url);
  }
  for (const [path, disp, data] of stillNeedRemote) {
    addGithubIssueReference(data, url);
    writeVbrief(path, data, root);
    clearPendingEmitUrl(root, path);
    written.push({ vbrief: disp, result: "created" });
  }

  return { result: "created", url, title: umbrellaTitle, vbriefs: [...written, ...already] };
}

export function expandPatterns(patterns: string[], root: string | null = null): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const pattern of patterns) {
    const candidate = root !== null && !isAbsolute(pattern) ? join(root, pattern) : pattern;
    let matches = globSync(candidate).sort();
    if (matches.length === 0) {
      try {
        readFileSync(candidate);
        matches = [candidate];
      } catch {
        matches = [];
      }
    }
    for (const match of matches) {
      const resolved = resolve(match);
      if (seen.has(resolved)) {
        continue;
      }
      seen.add(resolved);
      out.push(match);
    }
  }
  return out;
}

export function isNoNetwork(dryRun: boolean): boolean {
  return dryRun || process.env.DEFT_NO_NETWORK === "1";
}

export function displayPath(path: string, projectRoot: string | null): string {
  if (projectRoot !== null) {
    try {
      return relative(resolve(projectRoot), resolve(path));
    } catch {
      // fall through
    }
  }
  return path;
}

export interface IssueEmitCliArgs {
  patterns: string[];
  umbrella?: boolean;
  perVbrief?: boolean;
  title?: string | null;
  dryRun?: boolean;
  json?: boolean;
  repo?: string | null;
  projectRoot?: string | null;
}

export function issueEmitMain(args: IssueEmitCliArgs): number {
  if (args.patterns.length === 0) {
    process.stderr.write("Error: Provide a vBRIEF path or glob(s) to emit\n");
    return 2;
  }
  if (args.title !== undefined && args.title !== null && !args.umbrella) {
    process.stderr.write("Error: --title is only valid with --umbrella\n");
    return 2;
  }

  const projectRoot = resolveProjectRoot(args.projectRoot ?? undefined);
  const paths = expandPatterns(args.patterns, projectRoot);
  if (paths.length === 0) {
    process.stderr.write(`Error: no vBRIEF files matched ${JSON.stringify(args.patterns)}.\n`);
    return 2;
  }

  const noNetwork = isNoNetwork(args.dryRun ?? false);
  let repo = "";
  if (!noNetwork) {
    repo = resolveProjectRepo(args.repo ?? undefined, projectRoot) ?? "";
    if (repo.length === 0) {
      process.stderr.write(
        "Error: could not detect repo. Pass --repo OWNER/NAME, set $DEFT_PROJECT_REPO, or run from the consumer repo (#538).\n",
      );
      return 2;
    }
  }

  const display = paths.map((p) => displayPath(p, projectRoot));

  try {
    let summary: Record<string, unknown>;
    if (args.umbrella) {
      const action = emitUmbrella(paths, {
        repo,
        noNetwork,
        title: args.title,
        displayPaths: display,
        projectRoot,
      });
      summary = { mode: "umbrella", no_network: noNetwork, umbrella: action };
    } else if (args.perVbrief) {
      const actions = emitPerVbrief(paths, {
        repo,
        noNetwork,
        displayPaths: display,
        projectRoot,
      });
      summary = { mode: "per-vbrief", no_network: noNetwork, actions };
    } else {
      if (paths.length !== 1) {
        process.stderr.write(
          `Error: single mode expects exactly one vBRIEF; matched ${paths.length}. Use --umbrella or --per-vbrief for globs.\n`,
        );
        return 2;
      }
      const action = emitSingle(paths[0] as string, {
        repo,
        noNetwork,
        displayPath: display[0],
        projectRoot,
      });
      summary = { mode: "single", no_network: noNetwork, actions: [action] };
    }

    if (args.json) {
      process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
    } else {
      printSummary(summary);
    }
    return 0;
  } catch (exc) {
    process.stderr.write(`Error: ${String(exc)}\n`);
    return 2;
  }
}

function printSummary(summary: Record<string, unknown>): void {
  const mode = String(summary.mode);
  const noNetwork = Boolean(summary.no_network);
  const banner = noNetwork ? "issue:emit plan (no network)" : "issue:emit";
  process.stdout.write(`${banner} -- mode: ${mode}\n`);
  if (mode === "umbrella") {
    const action = summary.umbrella as UmbrellaAction;
    const verbs: Record<string, string> = {
      created: "FILED umbrella",
      dryrun: "WOULD FILE umbrella",
      skipped: "SKIP umbrella (already tracked)",
    };
    const url = action.url ? ` -> ${action.url}` : "";
    process.stdout.write(`  ${verbs[action.result]}: ${action.title}${url}\n`);
    for (const child of action.vbriefs) {
      process.stdout.write(`    - ${child.result.toUpperCase().padEnd(8)} ${child.vbrief}\n`);
    }
  } else {
    const actions = summary.actions as EmitAction[];
    const verbs: Record<string, string> = {
      created: "FILED",
      dryrun: "WOULD FILE",
      skipped: "SKIP (already tracked)",
    };
    for (const action of actions) {
      const url = action.url ? ` -> ${action.url}` : "";
      process.stdout.write(`  ${verbs[action.result]?.padEnd(22) ?? ""} ${action.vbrief}${url}\n`);
    }
  }
}
