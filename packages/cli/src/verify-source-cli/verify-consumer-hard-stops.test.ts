import { describe, expect, it, vi } from "vitest";
import { parseArgs, run } from "./verify-consumer-hard-stops.js";

function silentRun(argv: string[], seams: Parameters<typeof run>[1]): number {
  const out = vi.spyOn(process.stdout, "write").mockReturnValue(true);
  const err = vi.spyOn(process.stderr, "write").mockReturnValue(true);
  try {
    return run(argv, seams);
  } finally {
    out.mockRestore();
    err.mockRestore();
  }
}

describe("parseArgs", () => {
  it("defaults repo and project root", () => {
    expect(parseArgs([])).toMatchObject({
      repo: "deftai/directive",
      projectRoot: ".",
      changelog: null,
    });
  });
  it("errors on unknown flags", () => {
    expect(parseArgs(["--bogus"]).error).toBeDefined();
  });
});

describe("run", () => {
  it("returns 2 on parse error", () => {
    expect(silentRun(["--bogus"], { inventory: [], changelogText: "" })).toBe(2);
  });

  it("returns 0 when inventory has no hard-stops", () => {
    expect(
      silentRun([], {
        inventory: [{ number: 5, title: "feat: x", labels: [] }],
        changelogText: "## [Unreleased]\n\n### Added\n",
      }),
    ).toBe(0);
  });

  it("returns 1 when a BLOCKER title is not in the Closes set", () => {
    expect(
      silentRun([], {
        inventory: [{ number: 3600, title: "BLOCKER: schema", labels: [] }],
        changelogText: "## [Unreleased]\n\n### Added\n",
      }),
    ).toBe(1);
  });

  it("does not ingest a body field from the inventory row", () => {
    expect(
      silentRun([], {
        inventory: [
          {
            number: 7,
            title: "feat: x",
            labels: [],
            body: "BLOCKER in the body must not classify",
          },
        ],
        changelogText: "## [Unreleased]\n\n### Added\n",
      }),
    ).toBe(0);
  });
});
