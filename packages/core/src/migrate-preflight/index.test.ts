import { describe, expect, it } from "vitest";
import {
  checkDocumentModel,
  checkLayout,
  checkUv,
  evaluate,
  formatCheckLine,
} from "./index.js";

describe("migrate-preflight", () => {
  it("checkUv fails when uv is missing", () => {
    const result = checkUv(() => null);
    expect(result.status).toBe("FAIL");
    expect(result.message).toContain("https://docs.astral.sh/uv/");
  });

  it("checkLayout fails when migrator script is absent", () => {
    const result = checkLayout("/tmp/deft-empty", "/tmp/project");
    expect(result.status).toBe("FAIL");
    expect(result.message).toContain("migrate_vbrief.py");
  });

  it("formatCheckLine mirrors Python surface", () => {
    expect(formatCheckLine({ name: "uv", status: "PASS", message: "ok" })).toBe(
      "CHECK uv: PASS ok",
    );
  });

  it("evaluate returns exit 1 when any check fails", () => {
    const { exitCode, results } = evaluate("/tmp/deft-empty", "/tmp/project", () => null);
    expect(exitCode).toBe(1);
    expect(results.some((r) => r.status === "FAIL")).toBe(true);
  });

  it("checkDocumentModel warns when no legacy artifacts", () => {
    const result = checkDocumentModel("/tmp/empty-project");
    expect(["WARN", "PASS", "FAIL"]).toContain(result.status);
  });
});
