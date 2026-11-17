import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// #5988: the hygiene warning is mocked so the call site is tested apart from the
// clone the tests run in. The other scope:complete advisories stay offline (#6069).
vi.mock("./checkout-hygiene-warning.js", async (importOriginal) => {
  const mod = await importOriginal();
  return { ...mod, checkoutHygieneWarningLines: vi.fn(() => []) };
});
vi.mock("../vbrief-reconcile/umbrellas.js", async (importOriginal) => {
  const mod = await importOriginal();
  return {
    ...mod,
    reconcileUmbrellas: vi.fn(() => [
      0,
      { changed: [], unchanged: [], skipped_no_ref: [], errors: [], dry_run: false },
    ]),
  };
});
vi.mock("../scm/work-claim.js", async (importOriginal) => {
  const mod = await importOriginal();
  return {
    ...mod,
    releaseWorkClaimForBrief: vi.fn(() => ({ released: false, message: "" })),
  };
});
vi.mock("../staleness-tickler/run.js", async (importOriginal) => {
  const mod = await importOriginal();
  return {
    ...mod,
    maybeRunStalenessTickler: vi.fn(() => ({
      lines: [],
      prompted: false,
      skippedReason: "test-offline",
    })),
  };
});

import { checkoutHygieneWarningLines } from "./checkout-hygiene-warning.js";
import { lifecycleMain } from "./main.js";
import { formatBriefJson } from "./vbrief-json.js";

const WORKTREE_LINE = "checkout hygiene: 30 linked worktrees (more than 25). test";
const BRANCH_LINE = "checkout hygiene: 120 local branches (more than 100). test";

let root = "";
let stdout: ReturnType<typeof vi.spyOn>;
let stderr: ReturnType<typeof vi.spyOn>;

function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "scope-hygiene-"));
  for (const folder of ["proposed", "pending", "active", "completed", "cancelled"]) {
    mkdirSync(join(dir, "xbrief", folder), { recursive: true });
  }
  return dir;
}

function writeActive(name: string): string {
  const path = join(root, "xbrief", "active", name);
  writeFileSync(
    path,
    formatBriefJson({
      xBRIEFInfo: { version: "0.8" },
      plan: { title: "Hygiene child", status: "running", items: [] },
    }),
    "utf8",
  );
  return path;
}

const errText = (): string => stderr.mock.calls.map(([chunk]) => String(chunk)).join("");

beforeEach(() => {
  root = makeRepo();
  stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  vi.mocked(checkoutHygieneWarningLines).mockReset();
  vi.mocked(checkoutHygieneWarningLines).mockReturnValue([]);
});

afterEach(() => {
  stdout.mockRestore();
  stderr.mockRestore();
  rmSync(root, { recursive: true, force: true });
});

describe("scope:complete checkout hygiene warning (#5988)", () => {
  it("writes the lines to stderr after a successful move, with exit 0", () => {
    vi.mocked(checkoutHygieneWarningLines).mockReturnValue([WORKTREE_LINE, BRANCH_LINE]);
    const child = writeActive("child.xbrief.json");

    expect(lifecycleMain(["complete", child, "--project-root", root])).toBe(0);

    expect(existsSync(join(root, "xbrief", "completed", "child.xbrief.json"))).toBe(true);
    expect(existsSync(child)).toBe(false);
    expect(checkoutHygieneWarningLines).toHaveBeenCalledTimes(1);
    expect(errText()).toContain(`${WORKTREE_LINE}\n`);
    expect(errText()).toContain(`${BRANCH_LINE}\n`);
    const out = stdout.mock.calls.map(([chunk]) => String(chunk)).join("");
    expect(out).not.toContain("checkout hygiene");
  });

  it("prints no hygiene line and does not call the warning when the move fails", () => {
    vi.mocked(checkoutHygieneWarningLines).mockReturnValue([WORKTREE_LINE]);
    const missing = join(root, "xbrief", "active", "missing.xbrief.json");

    expect(lifecycleMain(["complete", missing, "--project-root", root])).not.toBe(0);

    expect(checkoutHygieneWarningLines).not.toHaveBeenCalled();
    expect(errText()).not.toContain("checkout hygiene");
  });

  it("still completes with exit 0 when the warning throws", () => {
    vi.mocked(checkoutHygieneWarningLines).mockImplementation(() => {
      throw new Error("boom");
    });
    const child = writeActive("thrower.xbrief.json");

    expect(lifecycleMain(["complete", child, "--project-root", root])).toBe(0);

    expect(existsSync(join(root, "xbrief", "completed", "thrower.xbrief.json"))).toBe(true);
    expect(errText()).not.toContain("boom");
  });
});
