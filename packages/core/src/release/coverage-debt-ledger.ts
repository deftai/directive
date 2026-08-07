/**
 * Open-issue coverage-debt ledger probes for release Step 5 (#2866 / #3187).
 *
 * Production path uses `gh`; all I/O is seamed for unit tests (no live network).
 */
import { existsSync, mkdtempSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type CoverageDebtIssueProbe,
  extractCoverageDebtCitationsFromChangelog,
  filterOpenCoverageDebtIssues,
  mergeOpenDebtLedger,
} from "./auto-hatch.js";
import { resolveGh } from "./gh.js";
import { defaultWhich, spawnText } from "./spawn.js";
import type { ReleaseSeams, SpawnResult } from "./types.js";

export interface CoverageDebtLedgerSeams {
  readonly spawnText?: ReleaseSeams["spawnText"];
  readonly whichGh?: ReleaseSeams["whichGh"];
  readonly readFile?: ReleaseSeams["readFile"];
  readonly fileExists?: ReleaseSeams["fileExists"];
  /** Override full ledger probe (tests). */
  readonly listOpenDebtIssues?: (repo: string, projectRoot: string) => number[];
  /** Override issue create (tests). */
  readonly createDebtIssue?: (
    repo: string,
    projectRoot: string,
    title: string,
    body: string,
  ) => number;
}

function spawn(
  seams: CoverageDebtLedgerSeams,
  cmd: string,
  args: readonly string[],
  cwd: string,
): SpawnResult {
  const run = seams.spawnText ?? spawnText;
  return run(cmd, args, { cwd, timeoutMs: 60_000, env: { ...process.env } });
}

class LedgerProbeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LedgerProbeError";
  }
}

function listIssuesBySearch(
  ghPath: string,
  repo: string,
  projectRoot: string,
  search: string,
  seams: CoverageDebtLedgerSeams,
): CoverageDebtIssueProbe[] {
  const result = spawn(
    seams,
    ghPath,
    [
      "issue",
      "list",
      "--repo",
      repo,
      "--state",
      "open",
      "--search",
      search,
      "--limit",
      "20",
      "--json",
      "number,title,body,state",
    ],
    projectRoot,
  );
  if (result.status !== 0) {
    throw new LedgerProbeError(
      `coverage-debt ledger search failed (${search}): ${(result.stderr || result.stdout).trim() || `exit ${result.status}`}`,
    );
  }
  try {
    const rows = JSON.parse(result.stdout || "[]") as CoverageDebtIssueProbe[];
    if (!Array.isArray(rows)) {
      throw new LedgerProbeError(`coverage-debt ledger search returned non-array for ${search}`);
    }
    return rows;
  } catch (err) {
    if (err instanceof LedgerProbeError) throw err;
    throw new LedgerProbeError(
      `coverage-debt ledger search unparseable JSON for ${search}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

function viewIssueState(
  ghPath: string,
  repo: string,
  projectRoot: string,
  issue: number,
  seams: CoverageDebtLedgerSeams,
): "OPEN" | "CLOSED" | "UNKNOWN" {
  // Prefer REST via `gh api` (avoids GraphQL issue-view --json).
  const result = spawn(
    seams,
    ghPath,
    ["api", `repos/${repo}/issues/${issue}`, "--jq", ".state"],
    projectRoot,
  );
  if (result.status !== 0) return "UNKNOWN";
  const state = result.stdout.trim().toUpperCase();
  if (state === "OPEN") return "OPEN";
  if (state === "CLOSED") return "CLOSED";
  return "UNKNOWN";
}

/**
 * Probe open coverage-debt ledger: marker searches + CHANGELOG citation scan.
 * Citation numbers whose state is OPEN or UNKNOWN count as unpaid (fail closed).
 *
 * Fail closed: gh marker-search failures throw (do not treat as empty ledger).
 * Missing gh falls through to CHANGELOG citations only (still fail-closed on UNKNOWN).
 */
export function probeOpenCoverageDebtLedger(
  repo: string,
  projectRoot: string,
  seams: CoverageDebtLedgerSeams = {},
): number[] {
  if (seams.listOpenDebtIssues) {
    return seams.listOpenDebtIssues(repo, projectRoot);
  }

  const which = seams.whichGh ?? defaultWhich;
  const ghPath = resolveGh({ whichGh: which, spawnText: seams.spawnText });

  const markerHits =
    ghPath === null
      ? []
      : [
          ...listIssuesBySearch(ghPath, repo, projectRoot, "coverage-debt in:title,body", seams),
          ...listIssuesBySearch(ghPath, repo, projectRoot, "allow-coverage-debt in:body", seams),
        ];
  const fromMarkers = filterOpenCoverageDebtIssues(markerHits);

  const changelogPath = join(projectRoot, "CHANGELOG.md");
  const exists = seams.fileExists ?? ((p: string) => existsSync(p));
  const read = seams.readFile ?? ((p: string) => readFileSync(p, "utf8"));
  let citedOpen: number[] = [];
  if (exists(changelogPath)) {
    try {
      const cited = extractCoverageDebtCitationsFromChangelog(read(changelogPath));
      if (ghPath === null) {
        // Fail closed: cannot confirm closed state without gh.
        citedOpen = cited;
      } else {
        const openRows: CoverageDebtIssueProbe[] = [];
        for (const n of cited) {
          const state = viewIssueState(ghPath, repo, projectRoot, n, seams);
          if (state === "OPEN" || state === "UNKNOWN") {
            openRows.push({ number: n });
          }
        }
        citedOpen = filterOpenCoverageDebtIssues(openRows);
      }
    } catch {
      // ignore unreadable changelog
    }
  }

  return mergeOpenDebtLedger(fromMarkers, citedOpen);
}

/** Create a coverage-debt issue; returns issue number or throws. */
export function createCoverageDebtIssue(
  repo: string,
  projectRoot: string,
  title: string,
  body: string,
  seams: CoverageDebtLedgerSeams = {},
): number {
  if (seams.createDebtIssue) {
    return seams.createDebtIssue(repo, projectRoot, title, body);
  }

  const which = seams.whichGh ?? defaultWhich;
  const ghPath = resolveGh({ whichGh: which, spawnText: seams.spawnText });
  if (ghPath === null) {
    throw new Error("gh CLI not found on PATH — cannot file coverage-debt issue");
  }

  const notesFile = join(mkdtempSync(join(tmpdir(), "deft-coverage-debt-")), "body.md");
  writeFileSync(notesFile, body, { encoding: "utf8" });
  try {
    const result = spawn(
      seams,
      ghPath,
      ["issue", "create", "--repo", repo, "--title", title, "--body-file", notesFile],
      projectRoot,
    );
    if (result.status !== 0) {
      throw new Error(
        `gh issue create failed: ${(result.stderr || result.stdout).trim() || `exit ${result.status}`}`,
      );
    }
    const url = (result.stdout || "").trim();
    const m = /\/issues\/(\d+)\s*$/.exec(url) ?? /\/issues\/(\d+)/.exec(url);
    if (!m) {
      throw new Error(`gh issue create succeeded but no issue URL in stdout: ${url}`);
    }
    return Number.parseInt(m[1] ?? "", 10);
  } finally {
    try {
      unlinkSync(notesFile);
    } catch {
      // best-effort
    }
  }
}
