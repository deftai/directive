import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  computeRefusalCensus,
  formatRefusalCensusLines,
  type GitRunner,
  readPreviousReleaseBaseline,
  refusalCensusForProject,
} from "./census.js";
import { DECLARATION_TABLE_PATH, loadRefusalDeclarations } from "./table.js";

const REPO_ROOT = join(__dirname, "..", "..", "..", "..");

const rows = (list: readonly Record<string, unknown>[]) => loadRefusalDeclarations(list);

const tableSource = (list: readonly Record<string, unknown>[]) =>
  `export const R = /* refusal-declarations:begin */ ${JSON.stringify(list)} /* refusal-declarations:end */;`;

function fakeGit(map: Record<string, string | null>): GitRunner {
  return (_root, args) => {
    const key = args.join(" ");
    const value = map[key];
    return value === undefined || value === null ? { ok: false } : { ok: true, stdout: value };
  };
}

const DESCRIBE = "describe --tags --abbrev=0 --match v[0-9]* HEAD";
const LS = (tag: string) => `ls-tree --name-only ${tag} -- ${DECLARATION_TABLE_PATH}`;
const SHOW = (tag: string) => `show ${tag}:${DECLARATION_TABLE_PATH}`;

describe("refusal census (#6281 item 4)", () => {
  it("a row absent from a read baseline, enforce and no exception, is listed as having no warn release", () => {
    const census = computeRefusalCensus(
      rows([{ id: "g", gate: "g", mode: "enforce", remedy: ["x"] }]),
      { label: "v1.0.0", rows: [] },
    );
    expect(census.baselineRead).toBe(true);
    expect(census.rows.map((r) => r.state)).toEqual(["absent"]);
    const text = formatRefusalCensusLines(census).join("\n");
    expect(text).toContain("- g (enforce): new in this release with no warn release");
  });

  it("a row that was warn at the baseline and is enforce now is listed as warned in the previous release", () => {
    const census = computeRefusalCensus(
      rows([{ id: "g", gate: "g", mode: "enforce", remedy: ["x"] }]),
      { label: "v1.0.0", rows: rows([{ id: "g", gate: "g", remedy: ["x"] }]) },
    );
    expect(census.rows.map((r) => r.state)).toEqual(["warned"]);
    expect(formatRefusalCensusLines(census).join("\n")).toContain(
      "- g (enforce): warned in the previous release",
    );
  });

  it("a baseline that cannot be read lists each current row as unknown", () => {
    const census = computeRefusalCensus(
      rows([
        { id: "a", gate: "g", mode: "enforce", remedy: ["x"] },
        { id: "b", gate: "g", remedy: ["x"] },
      ]),
      { label: "previous release tag not found", rows: null },
    );
    expect(census.baselineRead).toBe(false);
    expect(census.rows.map((r) => [r.row.id, r.state])).toEqual([
      ["a", "unknown"],
      ["b", "unknown"],
    ]);
    const text = formatRefusalCensusLines(census).join("\n");
    expect(text).toContain("a (enforce): unknown (baseline not read)");
    expect(text).not.toContain("no warn release");
  });

  it("does not list unchanged rows, enforce rows that stayed enforce, or relaxed rows", () => {
    const before = rows([
      { id: "same", gate: "g", remedy: ["x"] },
      { id: "stay", gate: "g", mode: "enforce", remedy: ["x"], exception: "e" },
      { id: "relax", gate: "g", mode: "enforce", remedy: ["x"], exception: "e" },
    ]);
    const now = rows([
      { id: "same", gate: "g", remedy: ["y"] },
      { id: "stay", gate: "g", mode: "enforce", remedy: ["y"], exception: "e" },
      { id: "relax", gate: "g", remedy: ["x"] },
    ]);
    const census = computeRefusalCensus(now, { label: "v1", rows: before });
    expect(census.rows).toEqual([]);
    expect(formatRefusalCensusLines(census)).toEqual([
      "  Declared refusals: baseline v1.",
      "  No declared refusal is new or changed since the baseline.",
    ]);
  });

  it("prints the baseline, new warn rows and named exceptions", () => {
    const census = computeRefusalCensus(
      rows([
        { id: "w", gate: "g", remedy: ["x"] },
        { id: "e", gate: "g", mode: "enforce", remedy: ["x"], exception: "security fix" },
      ]),
      { label: "v2.0.0", rows: [] },
    );
    const lines = formatRefusalCensusLines(census);
    expect(lines[0]).toBe("  Declared refusals: baseline v2.0.0.");
    expect(lines).toContain("  - w (warn): new in this release, warn only");
    expect(lines).toContain(
      "  - e (enforce): new in this release, enforce by named exception; exception: security fix",
    );
    expect(lines.at(-1)).toContain("warn-first release, or a named exception");
  });

  it("prints every changed row when there are more than 20", () => {
    const many = Array.from({ length: 27 }, (_, i) => ({
      id: `g${i}`,
      gate: "g",
      mode: "enforce",
      remedy: ["x"],
    }));
    const lines = formatRefusalCensusLines(
      computeRefusalCensus(rows(many), { label: "v1", rows: [] }),
    );
    for (let i = 0; i < 27; i += 1) {
      expect(lines.some((l) => l.startsWith(`  - g${i} (enforce)`))).toBe(true);
    }
  });
});

describe("previous release baseline read", () => {
  it("reads the table at the newest reachable release tag", () => {
    const git = fakeGit({
      [DESCRIBE]: "v1.2.3\n",
      [LS("v1.2.3")]: `${DECLARATION_TABLE_PATH}\n`,
      [SHOW("v1.2.3")]: tableSource([{ id: "g", gate: "g", remedy: ["x"] }]),
    });
    const read = readPreviousReleaseBaseline("/repo", git);
    expect(read.label).toBe("v1.2.3");
    expect(read.rows?.map((r) => [r.id, r.mode])).toEqual([["g", "warn"]]);
  });

  it("a tag without the table file is a read baseline with no rows", () => {
    const read = readPreviousReleaseBaseline(
      "/repo",
      fakeGit({ [DESCRIBE]: "v1.0.0", [LS("v1.0.0")]: "" }),
    );
    expect(read).toEqual({ label: "v1.0.0 (no table at that tag)", rows: [] });
  });

  it("no tag, an unreadable tree, a failed show or an unparseable table is unread", () => {
    expect(readPreviousReleaseBaseline("/repo", fakeGit({})).rows).toBeNull();
    expect(readPreviousReleaseBaseline("/repo", fakeGit({ [DESCRIBE]: "  " })).rows).toBeNull();
    expect(
      readPreviousReleaseBaseline("/repo", fakeGit({ [DESCRIBE]: "v1", [LS("v1")]: null })),
    ).toEqual({ label: "v1 (table not readable)", rows: null });
    expect(
      readPreviousReleaseBaseline(
        "/repo",
        fakeGit({ [DESCRIBE]: "v1", [LS("v1")]: DECLARATION_TABLE_PATH }),
      ),
    ).toEqual({ label: "v1 (table not readable)", rows: null });
    expect(
      readPreviousReleaseBaseline(
        "/repo",
        fakeGit({ [DESCRIBE]: "v1", [LS("v1")]: DECLARATION_TABLE_PATH, [SHOW("v1")]: "junk" }),
      ),
    ).toEqual({ label: "v1 (table not parseable)", rows: null });
  });

  it("censuses a project with an injected git runner and table", () => {
    const census = refusalCensusForProject("/repo", {
      git: fakeGit({}),
      current: rows([{ id: "g", gate: "g", remedy: ["x"] }]),
    });
    expect(census.baselineRead).toBe(false);
    expect(census.rows.map((r) => r.state)).toEqual(["unknown"]);
  });

  it("runs against this repository with the real git runner", () => {
    const census = refusalCensusForProject(REPO_ROOT);
    expect(typeof census.baseline).toBe("string");
    expect(census.baseline.length).toBeGreaterThan(0);
  });

  it("a directory that is not a repository is an unread baseline", () => {
    const census = refusalCensusForProject(join(REPO_ROOT, "..", "no-such-dir-6281"));
    expect(census.baselineRead).toBe(false);
  });
});
