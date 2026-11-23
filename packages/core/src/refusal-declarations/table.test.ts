import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  DECLARATION_TABLE_PATH,
  findRefusalDeclaration,
  loadRefusalDeclarations,
  normalizeDeclarations,
  parseDeclarationTableSource,
  REFUSAL_DECLARATION_ROWS,
  rowsWithoutRemedyCase,
} from "./table.js";

const REPO_ROOT = join(__dirname, "..", "..", "..", "..");

describe("refusal declaration table (#6281 item 1)", () => {
  it("a row with no declared mode loads as warn", () => {
    const rows = loadRefusalDeclarations([
      { id: "new-gate", gate: "new gate (#1)", remedy: ["deft verify:thing --fix"] },
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.mode).toBe("warn");
    expect(rows[0]?.exception).toBeNull();
  });

  it("keeps id, gate, mode, remedy and exception", () => {
    const rows = loadRefusalDeclarations([
      {
        id: "g",
        gate: "gate g",
        mode: "enforce",
        remedy: ["a --x 1", "b"],
        exception: "security fix",
      },
    ]);
    expect(rows[0]).toEqual({
      id: "g",
      gate: "gate g",
      mode: "enforce",
      remedy: ["a --x 1", "b"],
      exception: "security fix",
      deferred: null,
    });
  });

  it("keeps a deferred reason and drops a blank one", () => {
    const rows = loadRefusalDeclarations([
      { id: "d", gate: "g", remedy: ["x"], deferred: " needs review; #1 " },
      { id: "e", gate: "g", remedy: ["x"], deferred: "  " },
    ]);
    expect(rows.map((r) => r.deferred)).toEqual(["needs review; #1", null]);
    expect(
      normalizeDeclarations([{ id: "f", gate: "g", remedy: ["x"], deferred: 1 }]).invalid,
    ).toEqual(["f"]);
  });

  it("drops malformed rows and names them, never throws", () => {
    const result = normalizeDeclarations([
      null,
      [],
      { id: "", gate: "g", remedy: ["x"] },
      { id: "no-gate", remedy: ["x"] },
      { id: "no-remedy", gate: "g", remedy: [] },
      { id: "bad-mode", gate: "g", remedy: ["x"], mode: "shadow" },
      { id: "bad-exception", gate: "g", remedy: ["x"], exception: 3 },
      { id: "ok", gate: "g", remedy: ["x", 4, " "], exception: "  " },
    ]);
    expect(result.rows.map((r) => r.id)).toEqual(["ok"]);
    expect(result.rows[0]?.remedy).toEqual(["x"]);
    expect(result.rows[0]?.exception).toBeNull();
    expect(result.invalid).toEqual([
      "row 1",
      "row 2",
      "row 3",
      "no-gate",
      "no-remedy",
      "bad-mode",
      "bad-exception",
    ]);
  });

  it("finds a row by id or returns null", () => {
    expect(findRefusalDeclaration("hooks-installed")?.mode).toBe("enforce");
    expect(findRefusalDeclaration("not-a-row")).toBeNull();
  });

  it("every shipped enforce row carries an exception reason (item 3)", () => {
    for (const row of loadRefusalDeclarations()) {
      if (row.mode === "enforce") {
        expect(row.exception, `row ${row.id}`).not.toBeNull();
      }
    }
  });

  it("the shipped table is all well-formed", () => {
    expect(normalizeDeclarations(REFUSAL_DECLARATION_ROWS).invalid).toEqual([]);
  });

  it("the table file's marker block parses to the same rows (census baseline read)", () => {
    const source = readFileSync(join(REPO_ROOT, DECLARATION_TABLE_PATH), "utf8");
    expect(parseDeclarationTableSource(source)).toEqual(loadRefusalDeclarations());
  });

  it("returns null for a source with no markers, no array or bad JSON", () => {
    expect(parseDeclarationTableSource("export const X = 1;")).toBeNull();
    expect(
      parseDeclarationTableSource(
        "/* refusal-declarations:begin */ 1 /* refusal-declarations:end */",
      ),
    ).toBeNull();
    expect(
      parseDeclarationTableSource(
        "/* refusal-declarations:begin */ [{id: 1}] /* refusal-declarations:end */",
      ),
    ).toBeNull();
    expect(
      parseDeclarationTableSource(
        '/* refusal-declarations:begin */ [{"a": 1}, 2] /* refusal-declarations:end */',
      ),
    ).toEqual([]);
  });

  it("parses a source whose block is an object as no table", () => {
    expect(
      parseDeclarationTableSource(
        'x = /* refusal-declarations:begin */ [ ] {"a": [1]} /* refusal-declarations:end */',
      ),
    ).toBeNull();
  });

  it("lists rows with no remedy case", () => {
    const rows = loadRefusalDeclarations([
      { id: "a", gate: "g", remedy: ["x"] },
      { id: "b", gate: "g", remedy: ["x"] },
    ]);
    expect(rowsWithoutRemedyCase(rows, ["a"])).toEqual(["b"]);
    expect(rowsWithoutRemedyCase(rows, new Set(["a", "b"]))).toEqual([]);
  });
});

describe("acceptance command rows (#6886 item 7)", () => {
  it("activation and cwd-grammar rows warn; run-time containment enforces with its exception", () => {
    expect(findRefusalDeclaration("acceptance-record-activate")?.mode).toBe("warn");
    expect(findRefusalDeclaration("acceptance-cwd-grammar")?.mode).toBe("warn");
    const containment = findRefusalDeclaration("acceptance-cwd-containment");
    expect(containment?.mode).toBe("enforce");
    expect(containment?.exception).toBe(
      "an acceptance command must not be spawned outside the repository",
    );
    const dependency = findRefusalDeclaration("acceptance-cwd-dependency");
    expect(dependency?.mode).toBe("enforce");
    expect(dependency?.exception).toBe(
      "an acceptance command must not run from installed dependencies or a dot folder",
    );
    for (const id of [
      "acceptance-record-activate",
      "acceptance-cwd-grammar",
      "acceptance-cwd-containment",
      "acceptance-cwd-dependency",
    ]) {
      expect(findRefusalDeclaration(id)?.remedy).toEqual(["deft verify:ac --capture-only"]);
    }
  });
});
