import { describe, expect, it } from "vitest";
import {
  fillRemedyCommand,
  formatDeclaredRefusal,
  formatRemedyCommands,
  parsePrintedRemedy,
} from "./print.js";
import { loadRefusalDeclarations } from "./table.js";

const ROWS = loadRefusalDeclarations([
  { id: "warn-gate", gate: "warn gate (#1)", remedy: ["deft fix --repo {repo}", "deft retry"] },
  {
    id: "enforce-gate",
    gate: "enforce gate (#2)",
    mode: "enforce",
    remedy: ["deft fix --repo {repo}", "deft retry"],
    exception: "security fix",
  },
]);

describe("declared refusal print helper (#6281 item 2)", () => {
  it("warn mode: the work proceeds and one line names the gate id, the remedy and a later refusal", () => {
    const out = formatDeclaredRefusal({
      id: "warn-gate",
      detail: "thing is stale",
      values: { repo: "o/r" },
      rows: ROWS,
    });
    expect(out.declared).toBe(true);
    expect(out.mode).toBe("warn");
    expect(out.proceed).toBe(true);
    expect(out.line.split("\n")).toHaveLength(1);
    expect(out.line).toContain("warn-gate");
    expect(out.line).toContain("can refuse from a later release");
    expect(out.line).toContain("Remedy: `deft fix --repo o/r`, then `deft retry`.");
    expect(out.remedy).toEqual(["deft fix --repo o/r", "deft retry"]);
  });

  it("enforce mode: the refusal line names the gate id and the same remedy", () => {
    const warn = formatDeclaredRefusal({
      id: "warn-gate",
      detail: "x",
      values: { repo: "o/r" },
      rows: ROWS,
    });
    const out = formatDeclaredRefusal({
      id: "enforce-gate",
      detail: "thing is stale.",
      values: { repo: "o/r" },
      rows: ROWS,
    });
    expect(out.proceed).toBe(false);
    expect(
      out.line.startsWith("❌ deft gate enforce-gate (enforce gate (#2)) refused: thing is stale."),
    ).toBe(true);
    expect(out.line).not.toContain("later release");
    expect(out.remedy).toEqual(warn.remedy);
    expect(parsePrintedRemedy(out.line)).toEqual(parsePrintedRemedy(warn.line));
  });

  it("enforce mode on an install that never ran the warn release prints the same gate id and remedy", () => {
    // The helper keeps no local warn state: the line is a function of the row only.
    const first = formatDeclaredRefusal({ id: "enforce-gate", detail: "d", rows: ROWS });
    const again = formatDeclaredRefusal({ id: "enforce-gate", detail: "d", rows: ROWS });
    expect(again).toEqual(first);
    expect(first.line).toContain("enforce-gate");
    expect(parsePrintedRemedy(first.line)).toEqual(["deft fix --repo {repo}", "deft retry"]);
  });

  it("an id outside the table still prints one refusal line", () => {
    const out = formatDeclaredRefusal({ id: "nope", detail: "d", rows: ROWS });
    expect(out.declared).toBe(false);
    expect(out.proceed).toBe(false);
    expect(out.line).toBe("❌ deft gate nope (undeclared refusal): d.");
    expect(parsePrintedRemedy(out.line)).toEqual([]);
  });

  it("uses the shipped table by default", () => {
    const out = formatDeclaredRefusal({ id: "hooks-installed", detail: "d" });
    expect(out.declared).toBe(true);
    expect(out.remedy).toEqual(["directive install --repair --yes"]);
  });

  it("fills known placeholders and leaves unknown ones", () => {
    expect(fillRemedyCommand("a {x} {y}", { x: "1" })).toBe("a 1 {y}");
    expect(fillRemedyCommand("a {x}")).toBe("a {x}");
    expect(formatRemedyCommands(["a", "b c"])).toBe("`a`, then `b c`");
  });
});
