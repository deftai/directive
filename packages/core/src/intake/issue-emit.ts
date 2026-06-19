import { globSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { call } from "../scm/call.js";
import { resolveProjectRoot } from "../scope/project-context.js";
import { resolveProjectRepo } from "../slice/project-context.js";
import type { ScmCallFn } from "./reconcile-issues.js";

export const GITHUB_ISSUE_REF_TYPE = "x-vbrief/github-issue";
export const EXTERNAL_TRUST_LEVEL = "external";

const ISSUE_URL_PATTERN = /https?:\/\/\S+?\/issues\/\d+/;

export class IssueEmitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IssueEmitError";
  }
}

export function loadVbrief(path: string): Record<string, unknown> {
  const data = JSON.parse(readFileSync(path, "utf8")) as unknown;
  return data !== null && typeof data === "object" && !Array.isArray(data)
    ? (data as Record<string, unknown>)
    : {};
}

export function writeVbrief(path: string, data: Record<string, unknown>): void {
  writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`, "utf8");
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
      if (obj.type === GITHUB_ISSUE_REF_TYPE) {
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

  const body = renderIssueBody(data);
  const url = fileIssue(options.repo, title, body, options.scmCall);
  addGithubIssueReference(data, url);
  writeVbrief(path, data);
  return { result: "created", vbrief: shown, url, title };
}

export function emitPerVbrief(
  paths: string[],
  options: {
    repo: string;
    scmCall?: ScmCallFn;
    noNetwork?: boolean;
    displayPaths?: string[] | null;
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

  const body = renderUmbrellaBody(pending.map(([, disp, data]) => [disp, data]));
  const url = fileIssue(options.repo, umbrellaTitle, body, options.scmCall);

  const written: { vbrief: string; result: string }[] = [];
  for (const [path, disp, data] of pending) {
    addGithubIssueReference(data, url);
    writeVbrief(path, data);
    written.push({ vbrief: disp, result: "created" });
  }

  return { result: "created", url, title: umbrellaTitle, vbriefs: [...written, ...already] };
}

export function expandPatterns(patterns: string[], root: string | null = null): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const pattern of patterns) {
    const candidate = root !== null && !pattern.startsWith("/") ? join(root, pattern) : pattern;
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
      });
      summary = { mode: "umbrella", no_network: noNetwork, umbrella: action };
    } else if (args.perVbrief) {
      const actions = emitPerVbrief(paths, { repo, noNetwork, displayPaths: display });
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
