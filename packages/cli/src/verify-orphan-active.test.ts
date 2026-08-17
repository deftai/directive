import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { parseArgs, run } from "./verify-orphan-active.js";

const temps: string[] = [];
afterAll(() => {
  for (const t of temps) {
    rmSync(t, { recursive: true, force: true });
  }
});

function buildRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "deft-cli-orphan-"));
  temps.push(root);
  mkdirSync(join(root, "xbrief", "active"), { recursive: true });
  return root;
}

function silentRun(argv: string[]): number {
  const out = vi.spyOn(process.stdout, "write").mockReturnValue(true);
  const err = vi.spyOn(process.stderr, "write").mockReturnValue(true);
  try {
    return run(argv);
  } finally {
    out.mockRestore();
    err.mockRestore();
  }
}

describe("parseArgs", () => {
  it("parses defaults", () => {
    expect(parseArgs([])).toMatchObject({
      projectRoot: ".",
      repo: null,
      issue: null,
      quiet: false,
      skipGh: false,
    });
  });

  it("parses all flags", () => {
    expect(
      parseArgs([
        "--project-root",
        "/root",
        "--repo",
        "deftai/directive",
        "--issue",
        "3429",
        "--quiet",
        "--skip-gh",
      ]),
    ).toMatchObject({
      projectRoot: "/root",
      repo: "deftai/directive",
      issue: 3429,
      quiet: true,
      skipGh: true,
    });
  });

  it("rejects a non-positive --issue", () => {
    expect(parseArgs(["--issue", "0"]).error).toContain("positive integer");
    expect(parseArgs(["--issue"]).error).toContain("expected one argument");
  });
});

describe("run", () => {
  it("returns 0 when no orphans are present", () => {
    const root = buildRepo();
    writeFileSync(join(root, "xbrief", "active", "live.xbrief.json"), "{}", "utf8");
    expect(silentRun(["--project-root", root, "--skip-gh"])).toBe(0);
  });

  it("returns 1 for --issue N on a closed-origin active brief and names scope:complete", () => {
    const root = buildRepo();
    writeFileSync(
      join(root, "xbrief", "active", "orphan.xbrief.json"),
      JSON.stringify({
        xBRIEFInfo: { version: "0.8" },
        plan: {
          status: "running",
          references: [
            {
              uri: "https://github.com/deftai/directive/issues/1001",
              type: "x-xbrief/github-issue",
            },
          ],
        },
      }),
      "utf8",
    );
    mkdirSync(join(root, ".deft-cache", "github-issue", "deftai", "directive", "1001"), {
      recursive: true,
    });
    writeFileSync(
      join(root, ".deft-cache", "github-issue", "deftai", "directive", "1001", "raw.json"),
      JSON.stringify({ number: 1001, state: "closed" }),
      "utf8",
    );
    const err = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    try {
      expect(
        run(["--project-root", root, "--repo", "deftai/directive", "--skip-gh", "--issue", "1001"]),
      ).toBe(1);
    } finally {
      const text = err.mock.calls.map((c) => String(c[0])).join("");
      err.mockRestore();
      expect(text).toContain("task scope:complete -- xbrief/active/orphan.xbrief.json");
    }
  });

  it("returns 0 for --issue N when the issue is open and no PR state is pending", () => {
    const root = buildRepo();
    writeFileSync(
      join(root, "xbrief", "active", "live.xbrief.json"),
      JSON.stringify({
        xBRIEFInfo: { version: "0.8" },
        plan: {
          status: "running",
          references: [
            {
              uri: "https://github.com/deftai/directive/issues/1001",
              type: "x-xbrief/github-issue",
            },
          ],
        },
      }),
      "utf8",
    );
    mkdirSync(join(root, ".deft-cache", "github-issue", "deftai", "directive", "1001"), {
      recursive: true,
    });
    writeFileSync(
      join(root, ".deft-cache", "github-issue", "deftai", "directive", "1001", "raw.json"),
      JSON.stringify({ number: 1001, state: "open" }),
      "utf8",
    );
    expect(
      silentRun([
        "--project-root",
        root,
        "--repo",
        "deftai/directive",
        "--skip-gh",
        "--issue",
        "1001",
      ]),
    ).toBe(0);
  });

  it("returns 1 for closed-issue orphan signature", () => {
    const root = buildRepo();
    writeFileSync(
      join(root, "xbrief", "active", "orphan.xbrief.json"),
      JSON.stringify({
        xBRIEFInfo: { version: "0.8" },
        plan: {
          status: "running",
          references: [
            {
              uri: "https://github.com/deftai/directive/issues/1001",
              type: "x-xbrief/github-issue",
            },
          ],
        },
      }),
      "utf8",
    );
    mkdirSync(join(root, ".deft-cache", "github-issue", "deftai", "directive", "1001"), {
      recursive: true,
    });
    writeFileSync(
      join(root, ".deft-cache", "github-issue", "deftai", "directive", "1001", "raw.json"),
      JSON.stringify({ number: 1001, state: "closed" }),
      "utf8",
    );
    expect(silentRun(["--project-root", root, "--repo", "deftai/directive", "--skip-gh"])).toBe(1);
  });

  it("returns 2 for bad args", () => {
    expect(silentRun(["--bogus"])).toBe(2);
  });
});
