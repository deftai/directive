import { describe, expect, it } from "vitest";
import {
  diffCase,
  normalizeOutput,
  PARITY_CASES,
  type ParityResult,
  renderReport,
} from "./lifecycle-packs-parity.js";

describe("lifecycle-packs-parity helpers", () => {
  it("normalizes CRLF to LF", () => {
    expect(normalizeOutput("a\r\nb")).toBe("a\nb");
  });

  it("diffCase detects stdout mismatch", () => {
    const diff = diffCase(
      { exitCode: 0, stdout: "py", stderr: "" },
      { exitCode: 0, stdout: "ts", stderr: "" },
      "case-a",
    );
    expect(diff.stdoutMismatch).toBe(true);
    expect(diff.exitMismatch).toBe(false);
  });

  it("renderReport prints CLEAN line with case count", () => {
    const result: ParityResult = { ok: true, diffs: [] };
    expect(renderReport(result)).toBe(
      `lifecycle-packs parity: CLEAN -- Python and TS agree on ${PARITY_CASES.length} case(s).`,
    );
  });
});
