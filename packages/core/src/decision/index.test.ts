import { describe, expect, it, vi } from "vitest";
import {
  DECISION_SCHEMA_VERSION,
  DECISIONS_DIR_REL,
  listMainEntry,
  mainEntry,
  writeMainEntry,
} from "./index.js";

describe("decision package exports", () => {
  it("exports schema constants", () => {
    expect(DECISION_SCHEMA_VERSION).toBe("deft.decision.v1");
    expect(DECISIONS_DIR_REL).toBe("xbrief/decisions");
  });

  it("mainEntry rejects unknown subcommands", () => {
    const err = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      expect(mainEntry(["nope"])).toBe(2);
      expect(err).toHaveBeenCalled();
    } finally {
      err.mockRestore();
    }
  });

  it("writeMainEntry fails closed without required fields", () => {
    const err = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const out = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      expect(writeMainEntry(["--decision", "only"])).toBe(2);
    } finally {
      err.mockRestore();
      out.mockRestore();
    }
  });

  it("listMainEntry returns 0 for empty project-root miss is config", () => {
    const err = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const out = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      // Unresolvable project root → exit 2
      expect(listMainEntry(["--project-root", "C:/definitely-missing-deft-root-xyz"])).toBe(2);
    } finally {
      err.mockRestore();
      out.mockRestore();
    }
  });

  it("mainEntry routes write and list subcommands", () => {
    const err = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const out = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      expect(mainEntry(["write", "--decision", "x"])).toBe(2);
      expect(mainEntry(["list", "--project-root", "C:/definitely-missing-deft-root-xyz"])).toBe(2);
      expect(mainEntry(["decision:write", "--decision", "x"])).toBe(2);
      expect(
        mainEntry(["decision:list", "--project-root", "C:/definitely-missing-deft-root-xyz"]),
      ).toBe(2);
    } finally {
      err.mockRestore();
      out.mockRestore();
    }
  });
});
