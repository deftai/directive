/**
 * triage:show default + operator brief renderers (#1128 / #2890).
 *
 * Default format mirrors the pre-Python-removal `render_show` surface.
 * `--format=operator` emits a pasteable Phase 3 candidate brief backbone;
 * the agent still owns lean (not invented here).
 */

import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { CACHE_DIR_NAME, CACHE_SOURCE_GITHUB_ISSUE } from "./constants.js";

/** Loose audit row for show renderers (actions + queue shapes both work). */
export type ShowAuditRow = {
  readonly decision?: string;
  readonly timestamp?: string;
  readonly actor?: string;
  readonly reason?: string;
  readonly issue_number?: number;
  readonly repo?: string;
};

/** One cached issue with body fields needed by show/operator formats. */
export interface CachedIssueDetail {
  readonly number: number;
  readonly title: string;
  readonly state: string;
  readonly labels: readonly string[];
  readonly updatedAt: string;
  readonly body: string;
  readonly htmlUrl: string | null;
}

function parseLabels(raw: unknown): readonly string[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  const labels: string[] = [];
  for (const item of raw) {
    if (typeof item === "object" && item !== null) {
      const name = (item as Record<string, unknown>).name;
      if (typeof name === "string") {
        labels.push(name);
      }
    } else if (typeof item === "string") {
      labels.push(item);
    }
  }
  return labels;
}

/** Collapse CR/LF so cached attacker text cannot break markdown bullets (P2). */
export function oneLine(value: string): string {
  return value.replace(/\r?\n/gu, " ").trim();
}

/**
 * Resolve a safe issue link. Always construct the canonical github.com path for
 * `owner/name#N` rather than trusting payload URL substrings (CodeQL
 * incomplete-url-substring-sanitization).
 */
export function resolveIssueHtmlUrl(repo: string, number: number): string {
  return `https://github.com/${repo}/issues/${number}`;
}

/** Load a single cached issue (include closed) or null on miss. */
export function loadCachedIssueDetail(
  repo: string,
  number: number,
  options: {
    readonly projectRoot: string;
    /** Absolute/relative path to `.deft-cache` root (CLI `--cache-root`). */
    readonly cacheRoot?: string | null;
    readonly source?: string;
  } = {
    projectRoot: process.cwd(),
  },
): CachedIssueDetail | null {
  if (!repo.includes("/")) {
    throw new Error(`repo must be 'owner/name'; got '${repo}'`);
  }
  const parts = repo.split("/", 2);
  const owner = parts[0];
  const name = parts[1];
  if (owner === undefined || name === undefined || owner.length === 0 || name.length === 0) {
    throw new Error(`repo must be 'owner/name'; got '${repo}'`);
  }
  const source = options.source ?? CACHE_SOURCE_GITHUB_ISSUE;
  const cacheBase =
    options.cacheRoot !== null && options.cacheRoot !== undefined && options.cacheRoot.length > 0
      ? resolve(options.cacheRoot)
      : join(resolve(options.projectRoot), CACHE_DIR_NAME);
  const entryDir = join(cacheBase, source, owner, name, String(number));
  const rawPath = join(entryDir, "raw.json");
  if (!existsSync(rawPath)) {
    return null;
  }
  let payload: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(readFileSync(rawPath, { encoding: "utf8" }));
    if (typeof parsed !== "object" || parsed === null) {
      return null;
    }
    payload = parsed as Record<string, unknown>;
  } catch {
    return null;
  }
  const n = typeof payload.number === "number" ? payload.number : number;
  const stateRaw = payload.state ?? "open";
  const state = typeof stateRaw === "string" ? stateRaw.toLowerCase() : "open";
  const title = typeof payload.title === "string" ? payload.title : "";
  const body = typeof payload.body === "string" ? payload.body : "";
  const updatedAt =
    typeof payload.updated_at === "string"
      ? payload.updated_at
      : typeof payload.updatedAt === "string"
        ? payload.updatedAt
        : "";
  return {
    number: n,
    title,
    state,
    labels: parseLabels(payload.labels),
    updatedAt,
    body,
    htmlUrl: resolveIssueHtmlUrl(repo, n),
  };
}

/** Default triage:show text (audit/cache oriented). */
export function renderShow(options: {
  readonly issue: CachedIssueDetail | null;
  readonly repo: string;
  readonly number: number;
  readonly latestDecision: ShowAuditRow | null;
  readonly history: readonly ShowAuditRow[];
  readonly inActiveXbrief: boolean;
}): string {
  const lines: string[] = [];
  lines.push(`triage:show -- ${options.repo}#${options.number}`);
  if (options.issue === null) {
    lines.push("");
    lines.push("  (issue not present in local cache)");
    lines.push("  Run `task triage:bootstrap` to populate, or check the repo slug.");
    return lines.join("\n");
  }
  const labels = options.issue.labels.map(oneLine);
  lines.push(`  title:      ${oneLine(options.issue.title)}`);
  lines.push(`  state:      ${oneLine(options.issue.state)}`);
  lines.push(`  labels:     ${labels.length > 0 ? labels.join(", ") : "<none>"}`);
  lines.push(`  updated_at: ${oneLine(options.issue.updatedAt)}`);
  lines.push("");
  lines.push(`  active xBRIEF reference: ${options.inActiveXbrief ? "yes" : "no"}`);
  if (options.latestDecision !== null) {
    const d = options.latestDecision;
    lines.push(
      `  latest decision: ${oneLine(String(d.decision ?? "?"))} at ${oneLine(String(d.timestamp ?? "?"))} by ${oneLine(String(d.actor ?? "?"))}`,
    );
    if (typeof d.reason === "string" && d.reason.length > 0) {
      lines.push(`    reason: ${oneLine(d.reason)}`);
    }
  } else {
    lines.push("  latest decision: <none -- untriaged>");
  }
  if (options.history.length > 0) {
    lines.push("");
    lines.push(`  history (${options.history.length} entries, oldest first):`);
    for (const entry of options.history) {
      const decision = oneLine(String(entry.decision ?? "?")).padEnd(14);
      lines.push(
        `    - ${oneLine(String(entry.timestamp ?? "?"))} ${decision} by ${oneLine(String(entry.actor ?? "?"))}`,
      );
    }
  }
  return lines.join("\n");
}

/** Collapse blank lines and trim for summary extraction. */
function normalizeBody(body: string): string {
  return body.replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim();
}

/**
 * Extract a short problem/context summary (2–5 lines) from issue body.
 * Prefers text before the first `##` section; falls back to leading paragraphs.
 */
export function extractBodySummary(body: string, maxLines = 5): string {
  const text = normalizeBody(body);
  if (text.length === 0) {
    return "(thin body / no summary)";
  }
  // Drop leading H1/title lines
  let rest = text.replace(/^#[^\n]*\n+/u, "");
  // Prefer content before first ## heading (often Summary/Description)
  const firstSection = rest.search(/^##\s+/mu);
  if (firstSection > 0) {
    rest = rest.slice(0, firstSection).trim();
  } else if (firstSection === 0) {
    // Body starts with ## — take the first section body
    const next = rest.search(/\n##\s+/u);
    const block = next === -1 ? rest : rest.slice(0, next);
    rest = block.replace(/^##[^\n]*\n?/u, "").trim();
  }
  const paragraphs = rest
    .split(/\n{2,}/u)
    .map((p) => p.replace(/\s+/gu, " ").trim())
    .filter((p) => p.length > 0 && !p.startsWith("#"));
  if (paragraphs.length === 0) {
    const lines = rest
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0 && !l.startsWith("#"));
    if (lines.length === 0) {
      return "(thin body / no summary)";
    }
    return lines.slice(0, maxLines).join("\n");
  }
  const out: string[] = [];
  for (const para of paragraphs) {
    if (out.length >= maxLines) break;
    // Soft-wrap long paragraphs into ~100-char lines for pasteability
    if (para.length <= 120) {
      out.push(para);
    } else {
      const words = para.split(/\s+/u);
      let line = "";
      for (const w of words) {
        const next = line.length === 0 ? w : `${line} ${w}`;
        if (next.length > 100 && line.length > 0) {
          out.push(line);
          line = w;
          if (out.length >= maxLines) break;
        } else {
          line = next;
        }
      }
      if (line.length > 0 && out.length < maxLines) {
        out.push(line);
      }
    }
  }
  return out.slice(0, maxLines).join("\n");
}

/**
 * Extract acceptance-criteria bullets from body, or a thin-body note.
 * Looks for AC / Acceptance headings and checkbox / bullet lists under them.
 */
export function extractAcceptanceCriteria(body: string): readonly string[] {
  const text = normalizeBody(body);
  if (text.length === 0) {
    return [];
  }
  const headingRe =
    /^#{1,3}\s*(?:acceptance\s*criteria|acceptance|ac\b|success\s*criteria)[^\n]*$/imu;
  const match = headingRe.exec(text);
  if (match === null || match.index === undefined) {
    // Loose: checkbox list near top without a heading
    const loose: string[] = [];
    for (const line of text.split("\n")) {
      const m = /^\s*[-*]\s*\[[ xX]\]\s+(.+)$/u.exec(line);
      if (m?.[1] !== undefined) {
        loose.push(m[1].trim());
      }
    }
    return loose.slice(0, 12);
  }
  const after = text.slice(match.index + match[0].length);
  // Stop only at a next ## (H2) peer section — keep ### subsections (A/B/C…) inside AC.
  const nextPeer = after.search(/\n##\s+\S/u);
  const section = nextPeer === -1 ? after : after.slice(0, nextPeer);
  const bullets: string[] = [];
  for (const line of section.split("\n")) {
    const checkbox = /^\s*[-*]\s*\[[ xX]\]\s+(.+)$/u.exec(line);
    if (checkbox?.[1] !== undefined) {
      bullets.push(checkbox[1].trim());
      continue;
    }
    // Prefer checkboxes under AC; plain bullets are also accepted
    const bullet = /^\s*[-*]\s+(.+)$/u.exec(line);
    if (bullet?.[1] !== undefined) {
      // Skip nested subsection-only markers that are just headings-as-bullets
      bullets.push(bullet[1].trim());
      continue;
    }
    const numbered = /^\s*\d+[.)]\s+(.+)$/u.exec(line);
    if (numbered?.[1] !== undefined) {
      bullets.push(numbered[1].trim());
    }
  }
  return bullets.slice(0, 12);
}

/** Operator-facing pasteable brief backbone for Phase 3 decisions (#2890 / #3116). */
export function renderOperatorBrief(options: {
  readonly issue: CachedIssueDetail | null;
  readonly repo: string;
  readonly number: number;
  readonly latestDecision: ShowAuditRow | null;
  readonly inActiveXbrief: boolean;
}): string {
  const lines: string[] = [];
  lines.push(`triage:show --format=operator -- ${options.repo}#${options.number}`);
  if (options.issue === null) {
    lines.push("");
    lines.push("  (issue not present in local cache)");
    lines.push("  Run `task triage:bootstrap` / re-sync per Phase 0, or check the repo slug.");
    return lines.join("\n");
  }
  const issue = options.issue;
  const link = issue.htmlUrl ?? resolveIssueHtmlUrl(options.repo, options.number);
  const labels = issue.labels.length > 0 ? issue.labels.map(oneLine).join(", ") : "<none>";
  // URL-first lead line (#3116): canonical issue URL before title/body fields.
  lines.push(oneLine(link));
  lines.push(`#${options.number}  ${oneLine(issue.title)}`);
  lines.push(`labels:  ${labels}`);
  lines.push(
    "validity: (agent-owned — still-open | partial | likely-shipped | needs-re-scope + evidence)",
  );
  lines.push("");
  lines.push("summary:");
  for (const line of extractBodySummary(issue.body).split("\n")) {
    lines.push(`  ${oneLine(line)}`);
  }
  lines.push("");
  const ac = extractAcceptanceCriteria(issue.body);
  if (ac.length === 0) {
    lines.push("acceptance criteria: (thin body / no AC)");
  } else {
    lines.push("acceptance criteria:");
    for (const item of ac) {
      lines.push(`  - ${oneLine(item)}`);
    }
  }
  lines.push("");
  if (options.latestDecision !== null) {
    const d = options.latestDecision;
    lines.push(
      `latest decision: ${oneLine(String(d.decision ?? "?"))} at ${oneLine(String(d.timestamp ?? "?"))} by ${oneLine(String(d.actor ?? "?"))}`,
    );
  } else {
    lines.push("latest decision: <none -- untriaged>");
  }
  lines.push(`active xBRIEF: ${options.inActiveXbrief ? "yes" : "no"}`);
  lines.push("");
  lines.push("lean: (agent-owned — not filled by triage:show)");
  return lines.join("\n");
}
