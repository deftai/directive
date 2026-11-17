import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
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

  it("returns 1 when a privileged label is not in the Closes set", () => {
    expect(
      silentRun([], {
        inventory: [{ number: 3899, title: "chore: remediation", labels: ["blocks-release-tag"] }],
        changelogText: "## [Unreleased]\n\n### Added\n",
      }),
    ).toBe(1);
  });

  it("returns 0 when only a BLOCKER title is present", () => {
    expect(
      silentRun([], {
        inventory: [{ number: 3600, title: "BLOCKER: schema", labels: [] }],
        changelogText: "## [Unreleased]\n\n### Added\n",
      }),
    ).toBe(0);
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

describe("run reads the effective [Unreleased] view (#6314)", () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
  });
  function project(fragment: string | null): string {
    const r = mkdtempSync(join(tmpdir(), "deft-hard-stops-6314-"));
    roots.push(r);
    writeFileSync(join(r, "CHANGELOG.md"), "## [Unreleased]\n\n### Fixed\n\n## [0.1.0]\n");
    if (fragment !== null) {
      mkdirSync(join(r, "changelog.d"));
      writeFileSync(join(r, "changelog.d", "3899-x.md"), fragment);
    }
    return r;
  }
  const inventory = [{ number: 3899, title: "chore: remediation", labels: ["blocks-release-tag"] }];

  it("counts a Closes line in a changelog.d fragment in the Closes set", () => {
    expect(silentRun(["--project-root", project(null)], { inventory })).toBe(1);
    const withFragment = project("section: Fixed\n- Remediation lands (Closes #3899)\n");
    expect(silentRun(["--project-root", withFragment], { inventory })).toBe(0);
  });

  it("returns 2 when the changelog cannot be read", () => {
    const r = mkdtempSync(join(tmpdir(), "deft-hard-stops-6314-missing-"));
    roots.push(r);
    expect(silentRun(["--project-root", r], { inventory })).toBe(2);
  });
});
