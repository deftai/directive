import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  classifySpawnStatus,
  formatScmSpawnDiagnostic,
  isAvailabilitySpawnFailure,
  STATUS_DLL_INIT_FAILED,
} from "./spawn-status.js";

const here = dirname(fileURLToPath(import.meta.url));

describe("classifySpawnStatus", () => {
  it("names STATUS_DLL_INIT_FAILED for the unsigned NTSTATUS", () => {
    expect(classifySpawnStatus(STATUS_DLL_INIT_FAILED)).toBe("0xC0000142 STATUS_DLL_INIT_FAILED");
    expect(classifySpawnStatus(3221225794)).toBe("0xC0000142 STATUS_DLL_INIT_FAILED");
  });

  it("names STATUS_DLL_INIT_FAILED for the signed NTSTATUS", () => {
    expect(classifySpawnStatus(-1073741502)).toBe("0xC0000142 STATUS_DLL_INIT_FAILED");
  });

  it("uses the spawn error code when status is null", () => {
    expect(classifySpawnStatus(null, { code: "ENOENT", message: "spawn ghx ENOENT" })).toBe(
      "ENOENT",
    );
  });

  it("keeps ordinary exits as exit N", () => {
    expect(classifySpawnStatus(1)).toBe("exit 1");
  });
});

describe("isAvailabilitySpawnFailure", () => {
  it("treats a spawn error as availability failure", () => {
    expect(
      isAvailabilitySpawnFailure({
        status: null,
        error: { code: "ENOENT", message: "spawn ghx ENOENT" },
        stdout: "",
        stderr: "",
      }),
    ).toBe(true);
  });

  it("treats STATUS_DLL_INIT_FAILED with empty output as availability failure", () => {
    expect(
      isAvailabilitySpawnFailure({
        status: 3221225794,
        stdout: "",
        stderr: "",
      }),
    ).toBe(true);
  });

  it("does not treat an HTTP error as availability failure", () => {
    expect(
      isAvailabilitySpawnFailure({
        status: 1,
        stdout: "",
        stderr: "HTTP 422",
      }),
    ).toBe(false);
  });
});

describe("formatScmSpawnDiagnostic", () => {
  it("names the binary and the status class when stderr is empty", () => {
    const text = formatScmSpawnDiagnostic("ghx", 3221225794, "");
    expect(text).toContain("ghx");
    expect(text).toContain("0xC0000142 STATUS_DLL_INIT_FAILED");
    expect(text).toContain("stderr empty");
  });

  it("keeps captured stderr after the class", () => {
    expect(formatScmSpawnDiagnostic("gh", 1, "HTTP 404")).toBe("gh failed (exit 1): HTTP 404");
  });
});

describe("no --version health probe (#3737)", () => {
  it("does not add a --version probe on the SCM spawn path", () => {
    for (const name of ["binary.ts", "call-shape.ts", "spawn-status.ts", "gh-rest.ts", "call.ts"]) {
      const text = readFileSync(join(here, name), "utf8");
      expect(text, name).not.toMatch(/--version/);
    }
  });
});
