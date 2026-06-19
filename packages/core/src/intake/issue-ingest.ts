import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { cacheGet } from "../cache/operations.js";
import { type CompletedProcess, call } from "../scm/call.js";
import { resolveProjectRoot } from "../scope/project-context.js";
import { resolveProjectRepo } from "../slice/project-context.js";
import { slugify, TODAY } from "../vbrief-build/build.js";
import { EMITTED_VBRIEF_VERSION } from "../vbrief-build/constants.js";
import {
  findAcHeading,
  parseCheckboxItems,
  parseListItems,
  sliceAcSection,
  stripCodeBlocks,
} from "./markdown-scanners.js";
import {
  detectRepo,
  extractReferencesFromVbrief,
  fetchOpenIssues,
  GITHUB_ISSUE_REF_TYPES,
  LIFECYCLE_FOLDERS,
  parseIssueNumber,
  type ScmCallFn,
} from "./reconcile-issues.js";

export const INGEST_STATUSES = ["proposed", "pending", "active"] as const;
export type IngestStatus = (typeof INGEST_STATUSES)[number];

const STATUS_MAP: Record<IngestStatus, [string, string]> = {
  proposed: ["proposed", "proposed"],
  pending: ["pending", "pending"],
  active: ["active", "running"],
};

const CONTROL_CHAR_LABELS: Record<string, string> = {
  "\b": "U+0008 backspace",
  "\t": "U+0009 tab",
  "\v": "U+000B vertical tab",
  "\f": "U+000C form feed",
};

const ORIGIN_URL_PATTERN = /https?:\/\/github\.com\/[^/\s]+\/[^/\s]+\/issues\/(\d+)/;
const ORIGIN_BARE_PATTERN = /issue\s*#(\d+)/i;

const CROSS_REF_PATTERNS: readonly [string, RegExp][] = [
  ["x-vbrief/closes", /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+#(\d+)\b/i],
  ["x-vbrief/blocks", /\bblocked[\s-]+by\s+#(\d+)\b/i],
  ["x-vbrief/refs", /\b(?:refs?|references?|see\s+also|related(?:\s+to)?)\s+#(\d+)\b/i],
];

function hasNonIndentationPrefix(text: string, index: number): boolean {
  const lineStart = text.lastIndexOf("\n", index) + 1;
  for (let i = lineStart; i < index; i += 1) {
    const ch = text[i];
    if (ch !== " " && ch !== "\t") {
      return true;
    }
  }
  return false;
}

export function bodyControlCharacterLabels(body: string): string[] {
  const labels: string[] = [];
  const seen = new Set<string>();
  for (let index = 0; index < body.length; index += 1) {
    const char = body[index] as string;
    if (char === "\t" && !hasNonIndentationPrefix(body, index)) {
      continue;
    }
    let label = CONTROL_CHAR_LABELS[char];
    if (label === undefined) {
      const code = char.charCodeAt(0);
      if (code < 32 && char !== "\n" && char !== "\r") {
        label = `U+${code.toString(16).padStart(4, "0").toUpperCase()} control character`;
      }
    }
    if (label !== undefined && !seen.has(label)) {
      seen.add(label);
      labels.push(label);
    }
  }
  return labels;
}

export function warnBodyControlCharacters(number: number, body: string): void {
  const labels = bodyControlCharacterLabels(body);
  if (labels.length === 0) {
    return;
  }
  process.stderr.write(
    `Warning: issue #${number} body contains unexpected control characters (${labels.join(", ")}); preserving Overview verbatim, but verify_encoding will flag the generated vBRIEF narrative.\n`,
  );
}

export function extractPlanItems(body: string): Record<string, string>[] {
  if (body.length === 0) {
    return [];
  }
  const text = stripCodeBlocks(body);
  const checkboxItems = parseCheckboxItems(text);
  if (checkboxItems.length > 0) {
    return checkboxItems.map((item) => ({ title: item.title, status: item.status }));
  }
  return extractAcSectionItems(text);
}

export function extractAcSectionItems(text: string): Record<string, string>[] {
  const heading = findAcHeading(text);
  if (heading === null) {
    return [];
  }
  const sectionText = sliceAcSection(text, heading);
  return parseListItems(sectionText).map((item) => ({
    title: item.title,
    status: item.status,
  }));
}

export function extractCrossRefs(
  body: string,
  repoUrl: string,
  exclude: ReadonlySet<number> = new Set(),
): Record<string, string>[] {
  if (body.length === 0 || repoUrl.length === 0) {
    return [];
  }
  const text = stripCodeBlocks(body);
  const refs: Record<string, string>[] = [];
  const seen = new Set<string>();

  for (const [refType, pattern] of CROSS_REF_PATTERNS) {
    const re = new RegExp(pattern.source, `${pattern.flags}g`);
    for (const match of text.matchAll(re)) {
      const number = Number.parseInt(match[1] as string, 10);
      if (!exclude.has(number)) {
        const key = `${refType}:${number}`;
        if (!seen.has(key)) {
          seen.add(key);
          refs.push({
            uri: `${repoUrl}/issues/${number}`,
            type: refType,
            title: `Issue #${number}`,
          });
        }
      }
    }
  }
  return refs;
}

export function provenanceIssueNumber(data: Record<string, unknown>): number | null {
  const plan = (data.plan ?? {}) as Record<string, unknown>;
  const narratives = (plan.narratives ?? {}) as Record<string, unknown>;
  const origin = narratives.Origin;
  const info = (data.vBRIEFInfo ?? {}) as Record<string, unknown>;
  const description = info.description;

  for (const text of [origin, description]) {
    if (typeof text !== "string" || text.length === 0) {
      continue;
    }
    let m = ORIGIN_URL_PATTERN.exec(text);
    if (m?.[1]) {
      return Number.parseInt(m[1], 10);
    }
    m = ORIGIN_BARE_PATTERN.exec(text);
    if (m?.[1]) {
      return Number.parseInt(m[1], 10);
    }
  }
  return null;
}

export function scanProvenanceRefs(vbriefDir: string): Map<number, string[]> {
  const issueToVbriefs = new Map<number, string[]>();

  for (const folder of LIFECYCLE_FOLDERS) {
    const folderPath = join(vbriefDir, folder);
    try {
      if (!statSync(folderPath).isDirectory()) {
        continue;
      }
    } catch {
      continue;
    }
    const files = readdirSync(folderPath)
      .filter((f) => f.endsWith(".vbrief.json"))
      .sort();
    for (const filename of files) {
      let data: Record<string, unknown>;
      try {
        data = JSON.parse(readFileSync(join(folderPath, filename), "utf8")) as Record<
          string,
          unknown
        >;
      } catch {
        continue;
      }

      const refs = extractReferencesFromVbrief(data);
      const githubRefs: [Record<string, unknown>, number][] = [];
      for (const ref of refs) {
        if (!GITHUB_ISSUE_REF_TYPES.has(String(ref.type ?? ""))) {
          continue;
        }
        const num = parseIssueNumber(ref);
        if (num !== null) {
          githubRefs.push([ref, num]);
        }
      }
      if (githubRefs.length === 0) {
        continue;
      }

      const provenanceNum = provenanceIssueNumber(data);
      let ownerNum: number;
      if (provenanceNum !== null) {
        if (!githubRefs.some(([, num]) => num === provenanceNum)) {
          continue;
        }
        ownerNum = provenanceNum;
      } else {
        ownerNum = githubRefs[0]?.[1] as number;
      }

      const relPath = `${folder}/${filename}`;
      const existing = issueToVbriefs.get(ownerNum) ?? [];
      existing.push(relPath);
      issueToVbriefs.set(ownerNum, existing);
    }
  }
  return issueToVbriefs;
}

export function buildIssueVbrief(
  issue: Record<string, unknown>,
  status: IngestStatus,
  repoUrl: string,
): [Record<string, unknown>, string] {
  const number = Number(issue.number);
  const title =
    (typeof issue.title === "string" && issue.title.length > 0
      ? issue.title
      : `Issue #${number}`) || `Issue #${number}`;
  const url =
    (typeof issue.url === "string" && issue.url.length > 0 ? issue.url : "") ||
    (repoUrl.length > 0 ? `${repoUrl}/issues/${number}` : "");
  const bodyRaw = issue.body;
  const bodyStr = typeof bodyRaw === "string" && bodyRaw.length > 0 ? bodyRaw : "";
  const labelsRaw = issue.labels;
  const labelNames: string[] = [];
  if (Array.isArray(labelsRaw)) {
    for (const lbl of labelsRaw) {
      if (typeof lbl === "string") {
        labelNames.push(lbl);
      } else if (lbl !== null && typeof lbl === "object" && !Array.isArray(lbl)) {
        const name = (lbl as Record<string, unknown>).name;
        if (typeof name === "string" && name.length > 0) {
          labelNames.push(name);
        }
      }
    }
  }

  const [folder, planStatus] = STATUS_MAP[status];
  const narratives: Record<string, string> = {
    Description: title,
    Origin: url.length > 0 ? `Ingested from ${url}` : `Ingested from issue #${number}`,
  };
  if (bodyStr.length > 0) {
    warnBodyControlCharacters(number, bodyStr);
    narratives.Overview = bodyStr;
  }
  if (labelNames.length > 0) {
    narratives.Labels = labelNames.join(", ");
  }

  const planItems = bodyStr.length > 0 ? extractPlanItems(bodyStr) : [];
  const plan: Record<string, unknown> = {
    title,
    status: planStatus,
    narratives,
    items: planItems,
  };
  if (labelNames.length > 0) {
    plan.tags = [...labelNames];
  }

  if (url.length > 0) {
    const references: Record<string, string>[] = [
      {
        uri: url,
        type: "x-vbrief/github-issue",
        title: `Issue #${number}: ${title}`,
      },
    ];
    if (bodyStr.length > 0 && repoUrl.length > 0) {
      references.push(...extractCrossRefs(bodyStr, repoUrl, new Set([number])));
    }
    plan.references = references;
  }

  return [
    {
      vBRIEFInfo: {
        version: EMITTED_VBRIEF_VERSION,
        description: `Scope vBRIEF ingested from GitHub issue #${number}`,
      },
      plan,
    },
    folder,
  ];
}

export function targetFilename(number: number, title: string): string {
  const slug = slugify(title) || `issue-${number}`;
  return `${TODAY}-${number}-${slug}.vbrief.json`;
}

export interface FetchIssueOptions {
  readonly cwd?: string | null;
  readonly cacheRoot?: string | null;
  readonly scmCall?: ScmCallFn;
}

export function fetchFromCache(
  repo: string,
  number: number,
  options: FetchIssueOptions = {},
): Record<string, unknown> | null {
  const key = `${repo}/${number}`;
  try {
    const result = cacheGet("github-issue", key, {
      cacheRoot: options.cacheRoot ?? undefined,
      allowStale: false,
    });
    const rawPath = join(result.entryDir, "raw.json");
    const issue = JSON.parse(readFileSync(rawPath, "utf8")) as Record<string, unknown>;
    if (typeof issue.html_url === "string" && issue.html_url.length > 0) {
      issue.url = issue.html_url;
    }
    return issue;
  } catch {
    return null;
  }
}

export function fetchSingleIssue(
  repo: string,
  number: number,
  options: FetchIssueOptions = {},
): Record<string, unknown> | null {
  const scmCall = options.scmCall ?? call;
  let result: CompletedProcess;
  try {
    result = scmCall("github-issue", "api", [`repos/${repo}/issues/${number}`], {
      timeout: 30,
      cwd: options.cwd ?? undefined,
    });
  } catch {
    process.stderr.write("Error: gh CLI not found. Install GitHub CLI.\n");
    return null;
  }

  if (result.returncode !== 0) {
    process.stderr.write(`Error: gh CLI failed fetching #${number}: ${result.stderr.trim()}\n`);
    return null;
  }
  try {
    const issue = JSON.parse(result.stdout) as Record<string, unknown>;
    if (typeof issue.html_url === "string" && issue.html_url.length > 0) {
      issue.url = issue.html_url;
    }
    return issue;
  } catch {
    process.stderr.write(`Error: failed to parse gh CLI output for #${number}.\n`);
    return null;
  }
}

export function fetchIssue(
  repo: string,
  number: number,
  options: FetchIssueOptions = {},
): Record<string, unknown> | null {
  const cached = fetchFromCache(repo, number, options);
  if (cached !== null) {
    return cached;
  }
  return fetchSingleIssue(repo, number, options);
}

export type IngestResult = "created" | "dryrun" | "duplicate";

export function ingestOne(
  issue: Record<string, unknown>,
  options: {
    vbriefDir: string;
    status: IngestStatus;
    repoUrl: string;
    dryRun?: boolean;
    existingRefs?: Map<number, string[]>;
  },
): [IngestResult, string | null, string] {
  const number = Number(issue.number);
  const refs = options.existingRefs ?? scanProvenanceRefs(options.vbriefDir);
  if (refs.has(number)) {
    const existing = refs.get(number)?.[0] ?? "";
    return [
      "duplicate",
      join(options.vbriefDir, existing),
      `#${number} already ingested at ${existing}`,
    ];
  }

  const [vbrief, folder] = buildIssueVbrief(issue, options.status, options.repoUrl);
  const filename = targetFilename(number, String(issue.title ?? ""));
  const target = join(options.vbriefDir, folder, filename);

  if (options.dryRun) {
    return ["dryrun", target, `DRY-RUN would write ${folder}/${filename}`];
  }

  mkdirSync(join(options.vbriefDir, folder), { recursive: true });
  writeFileSync(target, `${JSON.stringify(vbrief, null, 2)}\n`, "utf8");
  return ["created", target, `CREATED ${folder}/${filename}`];
}

export function ingestBulk(
  issues: Record<string, unknown>[],
  options: {
    vbriefDir: string;
    status: IngestStatus;
    repoUrl: string;
    label?: string | null;
    dryRun?: boolean;
  },
): Record<string, string[] | number> {
  let filtered = issues;
  if (options.label !== undefined && options.label !== null) {
    filtered = issues.filter((issue) => {
      const labels = issue.labels;
      if (!Array.isArray(labels)) {
        return false;
      }
      for (const lbl of labels) {
        const name =
          typeof lbl === "string"
            ? lbl
            : lbl !== null && typeof lbl === "object"
              ? String((lbl as Record<string, unknown>).name ?? "")
              : "";
        if (name === options.label) {
          return true;
        }
      }
      return false;
    });
  }

  const refs = scanProvenanceRefs(options.vbriefDir);
  const summary: Record<string, string[] | number> = {
    created: [],
    duplicate: [],
    dryrun: [],
  };

  for (const issue of filtered) {
    const [result, path, _msg] = ingestOne(issue, { ...options, existingRefs: refs });
    const rel = path !== null ? path.replace(`${options.vbriefDir}/`, "").replace(/\\/g, "/") : "";
    (summary[result] as string[]).push(rel);
    if (result === "created" && path !== null) {
      const num = Number(issue.number);
      const existing = refs.get(num) ?? [];
      existing.push(rel);
      refs.set(num, existing);
    }
  }
  summary.total = filtered.length;
  return summary;
}

export function resolveRepoUrl(repo: string): string {
  if (repo.length === 0) {
    return "";
  }
  if (repo.startsWith("http://") || repo.startsWith("https://")) {
    return repo.replace(/\/$/, "");
  }
  if (/^[^/]+\/[^/]+$/.test(repo)) {
    return `https://github.com/${repo}`;
  }
  return "";
}

export interface IssueIngestCliArgs {
  number?: number | null;
  all?: boolean;
  label?: string | null;
  status?: IngestStatus;
  dryRun?: boolean;
  vbriefDir?: string;
  repo?: string | null;
  projectRoot?: string | null;
}

export function issueIngestMain(args: IssueIngestCliArgs): number {
  if ((args.number === undefined || args.number === null) && !args.all) {
    process.stderr.write("Error: Provide an issue number or --all\n");
    return 2;
  }
  if (args.number !== undefined && args.number !== null && args.all) {
    process.stderr.write("Error: Use either a single issue number OR --all, not both\n");
    return 2;
  }

  const vbriefDir = resolve(args.vbriefDir ?? "./vbrief");
  mkdirSync(vbriefDir, { recursive: true });

  const projectRoot = resolveProjectRoot(args.projectRoot ?? undefined);
  let repo = resolveProjectRepo(args.repo ?? undefined, projectRoot);
  if (repo === null) {
    repo = detectRepo();
  }
  if (repo === null) {
    process.stderr.write(
      "Error: could not detect repo. Pass --repo OWNER/NAME, set $DEFT_PROJECT_REPO, or run from a directory tree whose git remote origin is the consumer repo (#538).\n",
    );
    return 2;
  }
  const repoUrl = resolveRepoUrl(repo);
  const status = args.status ?? "proposed";

  if (args.all) {
    const issues = fetchOpenIssues(repo, { cwd: projectRoot });
    if (issues === null) {
      return 2;
    }
    const summary = ingestBulk(issues, {
      vbriefDir,
      status,
      repoUrl,
      label: args.label,
      dryRun: args.dryRun,
    });
    const created = summary.created as string[];
    const duplicate = summary.duplicate as string[];
    const dryrun = summary.dryrun as string[];
    process.stdout.write(
      `issue:ingest bulk summary: ${created.length} created, ${duplicate.length} duplicate, ${dryrun.length} dry-run (total considered: ${summary.total})\n`,
    );
    for (const entry of created) {
      process.stdout.write(`  CREATED ${entry}\n`);
    }
    for (const entry of dryrun) {
      process.stdout.write(`  DRY-RUN ${entry}\n`);
    }
    for (const entry of duplicate) {
      process.stdout.write(`  SKIP    ${entry} (already has scope vBRIEF)\n`);
    }
    return 0;
  }

  const issue = fetchIssue(repo, args.number as number, { cwd: projectRoot });
  if (issue === null) {
    return 2;
  }
  const [result, _path, msg] = ingestOne(issue, {
    vbriefDir,
    status,
    repoUrl,
    dryRun: args.dryRun,
  });
  process.stdout.write(`${msg}\n`);
  return result === "duplicate" ? 1 : 0;
}

export function ingestSingleForAccept(
  n: number,
  repo: string,
  options: {
    projectRoot?: string | null;
    status?: IngestStatus;
    cacheRoot?: string | null;
  } = {},
): [IngestResult, string | null] {
  const root = resolve(options.projectRoot ?? process.cwd());
  const vbriefDir = resolve(root, "vbrief");
  mkdirSync(vbriefDir, { recursive: true });
  const repoUrl = resolveRepoUrl(repo);
  const issue = fetchIssue(repo, n, {
    cwd: root,
    cacheRoot: options.cacheRoot,
  });
  if (issue === null) {
    throw new Error(
      `failed to fetch GitHub issue #${n} from ${repo} (unified cache miss + live gh api fetch failed; see stderr)`,
    );
  }
  const [result, path] = ingestOne(issue, {
    vbriefDir,
    status: options.status ?? "proposed",
    repoUrl,
  });
  return [result, path];
}
