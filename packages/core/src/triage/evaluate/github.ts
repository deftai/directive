import {
  type RunGhApiFn,
  restIssueListPaginated,
  restIssueView,
  runGhApi,
  splitRepo,
} from "../../scm/gh-rest.js";
import type { GithubCensus, GithubIssueSnapshot, GithubPullSnapshot } from "./types.js";

const DUPLICATE_RE = /duplicate of\s+#(\d+)/iu;
const MENTION_RE = /(?:#|issues\/)(\d+)\b/gu;

function labelsOf(raw: Record<string, unknown>): string[] {
  const labels = raw.labels;
  if (!Array.isArray(labels)) {
    return [];
  }
  const out: string[] = [];
  for (const item of labels) {
    if (typeof item === "string") {
      out.push(item);
      continue;
    }
    if (item !== null && typeof item === "object" && "name" in item) {
      const name = (item as { name?: unknown }).name;
      if (typeof name === "string") {
        out.push(name);
      }
    }
  }
  return out;
}

function duplicateOf(title: string, body: string, labels: readonly string[]): number | null {
  const match = DUPLICATE_RE.exec(`${title}\n${body}`);
  if (match?.[1] !== undefined) {
    return Number.parseInt(match[1], 10);
  }
  if (labels.some((label) => label.toLowerCase().includes("duplicate"))) {
    const hash = /#(\d+)/u.exec(title);
    if (hash?.[1] !== undefined) {
      return Number.parseInt(hash[1], 10);
    }
  }
  return null;
}

export function snapshotFromIssuePayload(raw: Record<string, unknown>): GithubIssueSnapshot {
  const number =
    typeof raw.number === "number" ? raw.number : Number.parseInt(String(raw.number), 10);
  const state = raw.state === "closed" ? "closed" : "open";
  const title = typeof raw.title === "string" ? raw.title : "";
  const body = typeof raw.body === "string" ? raw.body : "";
  const labels = labelsOf(raw);
  const htmlUrl = typeof raw.html_url === "string" ? raw.html_url : null;
  return {
    number,
    state,
    title,
    body,
    labels,
    htmlUrl,
    pullRequest: raw.pull_request !== undefined && raw.pull_request !== null,
    duplicateOf: duplicateOf(title, body, labels),
  };
}

function mentionsFrom(text: string): number[] {
  const found = new Set<number>();
  for (const match of text.matchAll(MENTION_RE)) {
    if (match[1] !== undefined) {
      found.add(Number.parseInt(match[1], 10));
    }
  }
  return [...found];
}

export function snapshotFromPullPayload(raw: Record<string, unknown>): GithubPullSnapshot {
  const number =
    typeof raw.number === "number" ? raw.number : Number.parseInt(String(raw.number), 10);
  const title = typeof raw.title === "string" ? raw.title : "";
  const body = typeof raw.body === "string" ? raw.body : "";
  return {
    number,
    title,
    body,
    htmlUrl: typeof raw.html_url === "string" ? raw.html_url : null,
    mentions: mentionsFrom(`${title}\n${body}`),
  };
}

export interface GithubSeams {
  readonly runGhApiFn?: RunGhApiFn;
}

function listOpenPulls(repo: string, seams: GithubSeams): GithubPullSnapshot[] {
  const [owner, name] = splitRepo(repo);
  const endpoint = `repos/${owner}/${name}/pulls`;
  const runner = seams.runGhApiFn ?? runGhApi;
  const result = runner([
    endpoint,
    "--method",
    "GET",
    "--raw-field",
    "state=open",
    "--raw-field",
    "per_page=100",
  ]);
  if (result.returncode !== 0) {
    throw new Error(`GET ${endpoint} failed: ${result.stderr.trim() || "no stderr"}`);
  }
  const parsed = JSON.parse(result.stdout.trim() || "[]") as unknown;
  if (!Array.isArray(parsed)) {
    return [];
  }
  return parsed
    .filter((item): item is Record<string, unknown> => item !== null && typeof item === "object")
    .map((item) => snapshotFromPullPayload(item));
}

/** GET-only GitHub census. Parent-owned. Never POST/PATCH/PUT/DELETE. */
export function collectGithubCensus(
  repo: string,
  issues: readonly number[],
  seams: GithubSeams = {},
): GithubCensus {
  const views: Record<number, GithubIssueSnapshot> = {};
  for (const n of issues) {
    const raw = restIssueView(repo, n, { runGhApiFn: seams.runGhApiFn });
    views[n] = snapshotFromIssuePayload(raw);
  }
  const openIssues = restIssueListPaginated(
    repo,
    { state: "open", excludePulls: true, perPage: 100 },
    { runGhApiFn: seams.runGhApiFn },
  ).map((raw) => snapshotFromIssuePayload(raw));
  const openPulls = listOpenPulls(repo, seams);
  return { issues: views, openIssues, openPulls };
}

export function defaultGithubReader(seams: GithubSeams = {}): {
  viewIssue: (repo: string, n: number) => GithubIssueSnapshot;
  listOpenIssues: (repo: string) => GithubIssueSnapshot[];
  listOpenPulls: (repo: string) => GithubPullSnapshot[];
} {
  return {
    viewIssue: (repo, n) =>
      snapshotFromIssuePayload(restIssueView(repo, n, { runGhApiFn: seams.runGhApiFn })),
    listOpenIssues: (repo) =>
      restIssueListPaginated(
        repo,
        { state: "open", excludePulls: true, perPage: 100 },
        {
          runGhApiFn: seams.runGhApiFn,
        },
      ).map((raw) => snapshotFromIssuePayload(raw)),
    listOpenPulls: (repo) => listOpenPulls(repo, seams),
  };
}

export function pullsMentioning(
  pulls: readonly GithubPullSnapshot[],
  issue: number,
): GithubPullSnapshot[] {
  return pulls.filter((pull) => pull.mentions.includes(issue) || pull.number === issue);
}
