/**
 * Refusal declaration table (#6281).
 *
 * A new consumer-visible refusal is declared here: an `id`, a `mode`
 * (`warn` or `enforce`), a `remedy` (the commands to run, in order, with every
 * argument they need) and an optional `exception` reason. A row with no `mode`
 * is `warn`, so a new refusal warns for at least one release before it refuses.
 * Turning a row to `enforce` is a one-line change in a later release with its
 * own CHANGELOG entry. A row that ships as `enforce` with no `warn` release
 * carries an `exception` reason, and its CHANGELOG entry states that reason.
 *
 * The rows between the begin and end markers are strict JSON: the release
 * census reads this file at the previous release tag and parses that block
 * (`parseDeclarationTableSource`), so keep the keys quoted.
 *
 * Every row needs a refusal-state case in `remedy-runs.test.ts`, which runs the
 * printed remedy exactly as printed and retries the refused operation.
 */

export type RefusalMode = "warn" | "enforce";

export interface RefusalDeclaration {
  readonly id: string;
  /** Short name of the gate and its origin issue. */
  readonly gate: string;
  readonly mode: RefusalMode;
  /** Commands to run, in order, each with every argument it needs. */
  readonly remedy: readonly string[];
  readonly exception: string | null;
  /**
   * Set only when the remedy cannot run exactly as printed yet: why, and the
   * issue that owns the runnable form. The line says so; the remedy test
   * checks the reason instead of running the commands.
   */
  readonly deferred: string | null;
}

/** A row as written in the table: `mode`, `exception` and `deferred` may be omitted. */
export interface RawRefusalDeclaration {
  readonly id: string;
  readonly gate: string;
  readonly mode?: RefusalMode;
  readonly remedy: readonly string[];
  readonly exception?: string;
  readonly deferred?: string;
}

export const DECLARATION_TABLE_BEGIN = "refusal-declarations:begin";
export const DECLARATION_TABLE_END = "refusal-declarations:end";

/** Repo-relative path of this file; the census reads it at the previous release tag. */
export const DECLARATION_TABLE_PATH = "packages/core/src/refusal-declarations/table.ts";

// biome-ignore format: the rows are parsed as strict JSON from past releases.
export const REFUSAL_DECLARATION_ROWS: readonly RawRefusalDeclaration[] = /* refusal-declarations:begin */ [
  {
    "id": "pre-pr-push-gate",
    "gate": "bound pre-PR push gate (#5804)",
    "mode": "enforce",
    "remedy": [
      "deft pre-pr:run --repo <owner/name> --base-sha <merge-base-sha> --head-sha {head} --tree-hash <head-tree-sha> --body-file <pr-body-file> --approved-revision <brief-revision-sha>",
      "deft pre-pr:run --observe-command --run-id <run-id> --phase <phase> --command <command> --exit-code <n>",
      "deft pre-pr:run --observe-semantic --run-id <run-id> --phase <phase> --reviewed-file <path> --supplied-contents-hash <hex>",
      "deft pre-pr:run --complete --run-id <run-id>",
      "git push"
    ],
    "exception": "existing refusal that refused before this table existed; seed row from #5977",
    "deferred": "fill the angle-bracket values and observe every phase in deft-directive-pre-pr skill order; the semantic phases need your own review, so no printed form can stand in for it; a one-command pre-PR is #5933 (operator ruling on #6281, 2026-11-17)"
  },
  {
    "id": "setup-hook-files",
    "gate": "setup: project-root .githooks/ hook files (#2530)",
    "mode": "enforce",
    "remedy": ["directive install --repair --yes"],
    "exception": "existing refusal that refused before this table existed; seed row from #5977 with a remedy that runs as printed"
  },
  {
    "id": "hooks-installed",
    "gate": "verify:hooks-installed (#1463)",
    "mode": "enforce",
    "remedy": ["directive install --repair --yes"],
    "exception": "existing refusal that refused before this table existed; seed row from #5977 with a remedy that runs as printed"
  },
  {
    "id": "extra-path-not-admitted",
    "gate": "extra-path budget: test or fixture add, delete or rename, and glob-matched or other-class paths outside file_scope (#6221)",
    "remedy": ["deft verify:scope-provenance"],
    "deferred": "the fix is a brief edit (name the path in file_scope on a widened brief that lands on the base, or move the path to a follow-up story); no printed command can make it for you; owned by #6221"
  },
  {
    "id": "extra-paths-over-budget",
    "gate": "extra-path budget: undeclared extra paths past the allowance (#6221)",
    "remedy": ["deft verify:scope-provenance"],
    "deferred": "the fix is a brief edit (split the extra paths to a follow-up story, or land a widened brief on the base); no printed command can make it for you; owned by #6221"
  },
  {
    "id": "declaration-hides-axis",
    "gate": "verify:scope-provenance: a declaration changed after activation hides a strict acceptance axis (#6591)",
    "remedy": ["deft verify:scope-provenance"],
    "deferred": "the fix is a brief edit in the same change (remove the added declaration, or record the evidence the clause requires); no printed command can make it for you; owned by #6591"
  },
  {
    "id": "acceptance-record-activate",
    "gate": "scope:activate and xbrief:activate: an acceptance command record that verify:ac would refuse before any run, or an unpromoted capture (#6886)",
    "remedy": ["deft verify:ac --capture-only"],
    "deferred": "the fix is a brief edit (replace a refused command with an admitted form, record a capture in plan.metadata.swarm.verify_commands only after reading it and confirming it runs only this repository's own tests, or record it in plan.metadata.literal_acceptance_not_commands); the printed command only lists each record and its reason; owned by #6886"
  },
  {
    "id": "acceptance-cwd-grammar",
    "gate": "scope:activate, xbrief:activate and verify:ac: an acceptance command cwd outside the plain relative-path grammar (#6886)",
    "remedy": ["deft verify:ac --capture-only"],
    "deferred": "the fix is a brief edit (write the cwd as a relative path inside the repository, such as web); the printed command only lists each record and its cwd; owned by #6886"
  },
  {
    "id": "acceptance-cwd-containment",
    "gate": "verify:ac: an acceptance command whose real working directory is missing, outside the repository or inside node_modules (#6886, #7223)",
    "mode": "enforce",
    "remedy": ["deft verify:ac --capture-only"],
    "exception": "an acceptance command must not be spawned outside the repository",
    "deferred": "the fix is a brief edit (point the cwd at an existing directory inside the repository) or creating that directory; the printed command only lists each record and its cwd; owned by #6886"
  },
  {
    "id": "acceptance-cwd-dependency",
    "gate": "verify:ac (activation prints the would-refuse line): an acceptance command cwd with a node_modules or leading-dot segment (#7223)",
    "mode": "enforce",
    "remedy": ["deft verify:ac --capture-only"],
    "exception": "an acceptance command must not run from installed dependencies or a dot folder",
    "deferred": "the fix is a brief edit (point the cwd at one of the repository's own directories); the printed command only lists each record and its reason; owned by #7223"
  }
] /* refusal-declarations:end */;

function isMode(value: unknown): value is RefusalMode {
  return value === "warn" || value === "enforce";
}

/**
 * Normalize raw rows: a row with no `mode` is `warn`; an absent or empty
 * `exception` is null. Malformed rows are dropped and reported, never thrown.
 */
export function normalizeDeclarations(rows: readonly unknown[]): {
  readonly rows: readonly RefusalDeclaration[];
  readonly invalid: readonly string[];
} {
  const out: RefusalDeclaration[] = [];
  const invalid: string[] = [];
  rows.forEach((raw, index) => {
    const row =
      typeof raw === "object" && raw !== null && !Array.isArray(raw)
        ? (raw as Record<string, unknown>)
        : null;
    const id = typeof row?.id === "string" ? row.id.trim() : "";
    const gate = typeof row?.gate === "string" ? row.gate.trim() : "";
    const remedy = Array.isArray(row?.remedy)
      ? row.remedy.filter((c): c is string => typeof c === "string" && c.trim().length > 0)
      : [];
    const mode = row?.mode === undefined ? "warn" : row.mode;
    if (
      row === null ||
      id.length === 0 ||
      gate.length === 0 ||
      remedy.length === 0 ||
      !isMode(mode) ||
      (row.exception !== undefined && typeof row.exception !== "string") ||
      (row.deferred !== undefined && typeof row.deferred !== "string")
    ) {
      invalid.push(id.length > 0 ? id : `row ${index + 1}`);
      return;
    }
    const exception =
      typeof row.exception === "string" && row.exception.trim().length > 0
        ? row.exception.trim()
        : null;
    const deferred =
      typeof row.deferred === "string" && row.deferred.trim().length > 0
        ? row.deferred.trim()
        : null;
    out.push({ id, gate, mode, remedy, exception, deferred });
  });
  return { rows: out, invalid };
}

/** The current table, normalized. */
export function loadRefusalDeclarations(
  rows: readonly unknown[] = REFUSAL_DECLARATION_ROWS,
): readonly RefusalDeclaration[] {
  return normalizeDeclarations(rows).rows;
}

/** Find one declared row by id, or null. */
export function findRefusalDeclaration(
  id: string,
  rows: readonly RefusalDeclaration[] = loadRefusalDeclarations(),
): RefusalDeclaration | null {
  return rows.find((row) => row.id === id) ?? null;
}

/**
 * Parse the strict-JSON block of a table file (this file at any revision).
 * Returns null when the markers are missing or the block is not a JSON array.
 */
export function parseDeclarationTableSource(text: string): readonly RefusalDeclaration[] | null {
  // The last begin marker is the block; the marker constants above it also contain the text.
  const begin = text.lastIndexOf(DECLARATION_TABLE_BEGIN);
  const end = text.indexOf(DECLARATION_TABLE_END, begin + 1);
  if (begin < 0 || end < 0) {
    return null;
  }
  const open = text.indexOf("[", begin);
  const close = text.lastIndexOf("]", end);
  if (open < 0 || close < open) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.slice(open, close + 1));
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) {
    return null;
  }
  return normalizeDeclarations(parsed).rows;
}

/** Row ids that have no refusal-state case in the remedy test (#6281 item 5). */
export function rowsWithoutRemedyCase(
  rows: readonly RefusalDeclaration[],
  caseIds: Iterable<string>,
): readonly string[] {
  const known = new Set(caseIds);
  return rows.filter((row) => !known.has(row.id)).map((row) => row.id);
}
