/**
 * Advisory census of declared refusals for release Check 5 (#6281 item 4).
 *
 * Compares the current table with the table at the previous release tag.
 * Each listed row has one state: warned at the baseline, absent at a baseline
 * that was read, or unknown when the baseline cannot be read. Unknown is never
 * reported as a missing warn release. The census never stops a cut.
 */
import { execFileSync } from "node:child_process";
import {
  DECLARATION_TABLE_PATH,
  loadRefusalDeclarations,
  parseDeclarationTableSource,
  type RefusalDeclaration,
} from "./table.js";

export type CensusRowState = "warned" | "absent" | "unknown";

export interface CensusRow {
  readonly row: RefusalDeclaration;
  readonly state: CensusRowState;
}

export interface RefusalCensus {
  /** What the census compared against, e.g. `v0.129.13`, or why it could not read it. */
  readonly baseline: string;
  readonly baselineRead: boolean;
  readonly rows: readonly CensusRow[];
}

/** A baseline read: the rows at the tag (empty when the file did not exist there), or null. */
export interface BaselineRead {
  readonly label: string;
  readonly rows: readonly RefusalDeclaration[] | null;
}

/**
 * Compare `current` with `baseline` rows. Listed: rows new since the baseline,
 * and rows that were `warn` at the baseline and are `enforce` now. With no
 * readable baseline every current row is listed as unknown.
 */
export function computeRefusalCensus(
  current: readonly RefusalDeclaration[],
  baseline: BaselineRead,
): RefusalCensus {
  if (baseline.rows === null) {
    return {
      baseline: baseline.label,
      baselineRead: false,
      rows: current.map((row) => ({ row, state: "unknown" as const })),
    };
  }
  const before = new Map(baseline.rows.map((row) => [row.id, row]));
  const rows: CensusRow[] = [];
  for (const row of current) {
    const prior = before.get(row.id);
    if (prior === undefined) {
      rows.push({ row, state: "absent" });
    } else if (prior.mode === "warn" && row.mode === "enforce") {
      rows.push({ row, state: "warned" });
    }
  }
  return { baseline: baseline.label, baselineRead: true, rows };
}

export type GitRunner = (
  projectRoot: string,
  args: readonly string[],
) => { readonly ok: true; readonly stdout: string } | { readonly ok: false };

const defaultGit: GitRunner = (projectRoot, args) => {
  try {
    const stdout = execFileSync("git", ["-C", projectRoot, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return { ok: true, stdout };
  } catch {
    return { ok: false };
  }
};

/**
 * Read the table at the previous release tag: the newest `v*` tag reachable
 * from HEAD. A tag where the table file did not exist yet is a read baseline
 * with no rows. Any other failure is an unread baseline.
 */
export function readPreviousReleaseBaseline(
  projectRoot: string,
  git: GitRunner = defaultGit,
): BaselineRead {
  const tag = git(projectRoot, ["describe", "--tags", "--abbrev=0", "--match", "v[0-9]*", "HEAD"]);
  const tagName = tag.ok ? tag.stdout.trim() : "";
  if (tagName.length === 0) {
    return { label: "previous release tag not found", rows: null };
  }
  const listed = git(projectRoot, [
    "ls-tree",
    "--name-only",
    tagName,
    "--",
    DECLARATION_TABLE_PATH,
  ]);
  if (!listed.ok) {
    return { label: `${tagName} (table not readable)`, rows: null };
  }
  if (listed.stdout.trim().length === 0) {
    return { label: `${tagName} (no table at that tag)`, rows: [] };
  }
  const shown = git(projectRoot, ["show", `${tagName}:${DECLARATION_TABLE_PATH}`]);
  if (!shown.ok) {
    return { label: `${tagName} (table not readable)`, rows: null };
  }
  const rows = parseDeclarationTableSource(shown.stdout);
  if (rows === null) {
    return { label: `${tagName} (table not parseable)`, rows: null };
  }
  return { label: tagName, rows };
}

/** Baseline reads with the real git runner, per project root, for this process. */
const defaultBaselineCache = new Map<string, BaselineRead>();

/** Census of the current table against the previous release tag in `projectRoot`. */
export function refusalCensusForProject(
  projectRoot: string,
  options: {
    readonly git?: GitRunner;
    readonly current?: readonly RefusalDeclaration[];
  } = {},
): RefusalCensus {
  let baseline: BaselineRead;
  if (options.git !== undefined) {
    baseline = readPreviousReleaseBaseline(projectRoot, options.git);
  } else {
    // The previous release tag does not move within one process; read it once.
    const cached = defaultBaselineCache.get(projectRoot);
    baseline = cached ?? readPreviousReleaseBaseline(projectRoot);
    defaultBaselineCache.set(projectRoot, baseline);
  }
  return computeRefusalCensus(options.current ?? loadRefusalDeclarations(), baseline);
}

function stateText(entry: CensusRow): string {
  if (entry.state === "unknown") {
    return "unknown (baseline not read)";
  }
  if (entry.state === "warned") {
    return "warned in the previous release";
  }
  if (entry.row.mode === "warn") {
    return "new in this release, warn only";
  }
  return entry.row.exception === null
    ? "new in this release with no warn release"
    : "new in this release, enforce by named exception";
}

/** Census lines for the Check 5 disclosure; every listed row is printed. */
export function formatRefusalCensusLines(census: RefusalCensus): string[] {
  const lines = [`  Declared refusals: baseline ${census.baseline}.`];
  if (census.rows.length === 0) {
    lines.push("  No declared refusal is new or changed since the baseline.");
    return lines;
  }
  for (const entry of census.rows) {
    const exception = entry.row.exception === null ? "" : `; exception: ${entry.row.exception}`;
    lines.push(`  - ${entry.row.id} (${entry.row.mode}): ${stateText(entry)}${exception}`);
  }
  lines.push(
    "  Each new refusal needs a warn-first release, or a named exception stated in its CHANGELOG entry.",
  );
  return lines;
}
