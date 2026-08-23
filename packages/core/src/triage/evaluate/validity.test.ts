import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { evaluateValidity, joinValidityWithGithub } from "./validity.js";

const temps: string[] = [];
afterEach(() => {
  for (const root of temps.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("evaluateValidity", () => {
  it("is still-open on an empty detached tree", () => {
    const root = mkdtempSync(join(tmpdir(), "val-"));
    temps.push(root);
    mkdirSync(join(root, "xbrief", "completed"), { recursive: true });
    expect(evaluateValidity(root, 1).state).toBe("still-open");
  });

  it("joins closed GitHub onto still-open as likely-shipped", () => {
    const joined = joinValidityWithGithub(
      {
        state: "still-open",
        evidence: "none",
        worktreePath: "/wt",
        sessionStartReadOnly: true,
      },
      "closed",
    );
    expect(joined.state).toBe("likely-shipped");
  });

  it("reads ADR mention as partial", () => {
    const root = mkdtempSync(join(tmpdir(), "val-adr-"));
    temps.push(root);
    const dir = join(root, "docs", "decisions");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "ADR-005.md"), "See #99 for the gate.", "utf8");
    expect(evaluateValidity(root, 99).state).toBe("partial");
  });
});
