import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { validateVbriefSchema } from "../vbrief-validate/schema.js";
import { activate } from "./activate.js";

const FIXTURE_NAME = "2026-05-01-test.xbrief.json";
const FIXED_NOW = new Date("2026-06-19T12:00:00.000Z");
/** Symlink fixtures require non-Windows (parity with scope lifecycle #2447 tests). */
const itSymlink = it.skipIf(process.platform === "win32");

function writeVbrief(
  base: string,
  folder: string,
  options: {
    status?: string;
    rawOverride?: string;
    payloadOverride?: Record<string, unknown>;
  } = {},
): string {
  const dir = join(base, "xbrief", folder);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, FIXTURE_NAME);
  if (options.rawOverride !== undefined) {
    writeFileSync(path, options.rawOverride, "utf8");
    return path;
  }
  if (options.payloadOverride !== undefined) {
    writeFileSync(path, JSON.stringify(options.payloadOverride), "utf8");
    return path;
  }
  writeFileSync(
    path,
    JSON.stringify({
      xBRIEFInfo: { version: "0.8", updated: "2026-04-30T00:00:00Z" },
      plan: { title: "T", status: options.status ?? "pending", items: [] },
    }),
    "utf8",
  );
  return path;
}

describe("activate", () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  function tempRoot(): string {
    const root = mkdtempSync(join(tmpdir(), "deft-activate-test-"));
    roots.push(root);
    return root;
  }

  it("flips pending to active and moves the file", () => {
    const root = tempRoot();
    const src = writeVbrief(root, "pending", { status: "pending" });
    const result = activate(src, { now: FIXED_NOW });
    expect(result.exitCode).toBe(0);
    expect(result.message).toContain("Activated");

    const dest = join(root, "xbrief", "active", FIXTURE_NAME);
    expect(existsSync(dest)).toBe(true);
    expect(existsSync(src)).toBe(false);

    const payload = JSON.parse(readFileSync(dest, "utf8")) as {
      plan: { status: string };
      xBRIEFInfo: { version: string; updated: string };
    };
    expect(payload.plan.status).toBe("running");
    // #3933: the v0.8 envelope is stamped in place; no legacy key is added.
    expect(payload.xBRIEFInfo.updated).toBe("2026-06-19T12:00:00Z");
    expect(Object.keys(payload)).not.toContain("vBRIEFInfo");
  });

  it("refuses activate when a plan item has effort XL (#1581)", () => {
    const root = tempRoot();
    const src = writeVbrief(root, "pending", {
      payloadOverride: {
        xBRIEFInfo: { version: "0.8", updated: "2026-04-30T00:00:00Z" },
        plan: {
          title: "T",
          status: "pending",
          items: [{ id: "big", title: "Needs breakdown", status: "pending", effort: "XL" }],
        },
      },
    });
    const result = activate(src, { now: FIXED_NOW });
    expect(result.exitCode).toBe(1);
    expect(result.message).toMatch(/effort=XL|#1581/);
    expect(existsSync(src)).toBe(true);
    expect(existsSync(join(root, "xbrief", "active", FIXTURE_NAME))).toBe(false);
  });

  it("accepts approved status", () => {
    const root = tempRoot();
    const src = writeVbrief(root, "pending", { status: "approved" });
    const result = activate(src, { now: FIXED_NOW });
    expect(result.exitCode).toBe(0);
    const dest = join(root, "xbrief", "active", FIXTURE_NAME);
    const payload = JSON.parse(readFileSync(dest, "utf8")) as { plan: { status: string } };
    expect(payload.plan.status).toBe("running");
  });

  it("is idempotent for already-active running vBRIEFs", () => {
    const root = tempRoot();
    const src = writeVbrief(root, "active", { status: "running" });
    const result = activate(src, { now: FIXED_NOW });
    expect(result.exitCode).toBe(0);
    expect(result.message).toContain("No-op");
    expect(existsSync(src)).toBe(true);
  });

  it("localizes command-only active writer: refuses pending command-present / clause-text-empty (#4768 Prefer-A)", () => {
    const root = tempRoot();
    const src = writeVbrief(root, "pending", {
      payloadOverride: {
        xBRIEFInfo: { version: "0.8", updated: "2026-04-30T00:00:00Z" },
        plan: {
          title: "Initialize workers from the config",
          status: "pending",
          narratives: { Overview: "Initialize workers from the config" },
          acceptance: {
            commands: [{ command: "pnpm test" }],
            none_stated: false,
            source_rung: "stated",
          },
          items: [],
        },
      },
    });
    const result = activate(src, { now: FIXED_NOW });
    expect(result.exitCode).toBe(1);
    expect(result.message).toMatch(/#4768 Prefer-A/);
    expect(result.message).toMatch(/command-present \/ clause-text-empty/);
    expect(existsSync(src)).toBe(true);
    expect(existsSync(join(root, "xbrief", "active", FIXTURE_NAME))).toBe(false);
  });

  it("stamps usable clauses when activating a command-only brief with a derivable list (#4768 Prefer-A)", () => {
    const root = tempRoot();
    const src = writeVbrief(root, "pending", {
      payloadOverride: {
        xBRIEFInfo: { version: "0.8", updated: "2026-04-30T00:00:00Z" },
        plan: {
          title: "Command only",
          status: "pending",
          narratives: {
            Overview:
              "## Acceptance sketch\n- Persist the session token in packages/core/src/session/token.ts\n",
          },
          acceptance: {
            commands: [{ command: "pnpm test" }],
            none_stated: false,
            source_rung: "stated",
          },
          items: [],
        },
      },
    });
    const result = activate(src, { now: FIXED_NOW });
    expect(result.exitCode).toBe(0);
    const dest = join(root, "xbrief", "active", FIXTURE_NAME);
    const payload = JSON.parse(readFileSync(dest, "utf8")) as {
      plan: { acceptance: { commands: unknown[]; clauses: { text: string }[] } };
    };
    expect(payload.plan.acceptance.commands).toEqual([{ command: "pnpm test" }]);
    expect(payload.plan.acceptance.clauses.length).toBeGreaterThan(0);
    expect(payload.plan.acceptance.clauses.every((c) => c.text.trim().length > 0)).toBe(true);
  });

  it("restamps already-active command-only brief via tmp+rename without leaving .tmp (#4768 Greptile P1)", () => {
    const root = tempRoot();
    const src = writeVbrief(root, "active", {
      payloadOverride: {
        xBRIEFInfo: { version: "0.8", updated: "2026-04-30T00:00:00Z" },
        plan: {
          title: "Already active stampable",
          status: "running",
          narratives: {
            Overview:
              "## Acceptance sketch\n- Persist the session token in packages/core/src/session/token.ts\n",
          },
          acceptance: {
            commands: [{ command: "pnpm test" }],
            none_stated: false,
            source_rung: "stated",
          },
          items: [],
        },
      },
    });
    const before = readFileSync(src, "utf8");
    const result = activate(src, { now: FIXED_NOW });
    expect(result.exitCode).toBe(0);
    expect(result.message).toContain("No-op");
    expect(existsSync(src)).toBe(true);
    expect(
      readdirSync(dirname(src)).some(
        (name) => name.startsWith(`${basename(src)}.`) && name.endsWith(".tmp"),
      ),
    ).toBe(false);
    const after = readFileSync(src, "utf8");
    expect(after).not.toBe(before);
    const payload = JSON.parse(after) as {
      plan: { acceptance: { clauses: { text: string }[] } };
    };
    expect(payload.plan.acceptance.clauses.length).toBeGreaterThan(0);
    expect(payload.plan.acceptance.clauses.every((c) => c.text.trim().length > 0)).toBe(true);
  });

  it("revalidates already-active command-present / clause-text-empty instead of blind no-op (#4768 Prefer-A)", () => {
    const root = tempRoot();
    const src = writeVbrief(root, "active", {
      payloadOverride: {
        xBRIEFInfo: { version: "0.8", updated: "2026-04-30T00:00:00Z" },
        plan: {
          title: "Already active command-only",
          status: "running",
          acceptance: {
            commands: [{ command: "pnpm test" }],
            none_stated: false,
            source_rung: "stated",
          },
          items: [],
        },
      },
    });
    const result = activate(src, { now: FIXED_NOW });
    expect(result.exitCode).toBe(1);
    expect(result.message).toMatch(/#4768 Prefer-A/);
    expect(existsSync(src)).toBe(true);
  });

  it("rejects proposed folder", () => {
    const root = tempRoot();
    const src = writeVbrief(root, "proposed", { status: "proposed" });
    const result = activate(src, { now: FIXED_NOW });
    expect(result.exitCode).toBe(1);
    expect(result.message).toContain("only pending/ vBRIEFs can be activated");
    expect(existsSync(src)).toBe(true);
  });

  it("rejects completed folder", () => {
    const root = tempRoot();
    const src = writeVbrief(root, "completed", { status: "completed" });
    const result = activate(src, { now: FIXED_NOW });
    expect(result.exitCode).toBe(1);
    expect(result.message).toContain("only pending/ vBRIEFs can be activated");
  });

  it("rejects active folder with blocked status", () => {
    const root = tempRoot();
    const src = writeVbrief(root, "active", { status: "blocked" });
    const result = activate(src, { now: FIXED_NOW });
    expect(result.exitCode).toBe(1);
    expect(result.message).toContain("task scope:unblock");
  });

  it("rejects ineligible pending status", () => {
    const root = tempRoot();
    const src = writeVbrief(root, "pending", { status: "draft" });
    const result = activate(src, { now: FIXED_NOW });
    expect(result.exitCode).toBe(1);
    expect(result.message).toContain("only ['approved', 'pending']");
  });

  it("rejects missing path", () => {
    const root = tempRoot();
    const result = activate(join(root, "missing.xbrief.json"), { now: FIXED_NOW });
    expect(result.exitCode).toBe(1);
    expect(result.message).toContain("vBRIEF not found");
  });

  it("rejects malformed json", () => {
    const root = tempRoot();
    const src = writeVbrief(root, "pending", { rawOverride: "{ not json" });
    const result = activate(src, { now: FIXED_NOW });
    expect(result.exitCode).toBe(1);
    expect(result.message).toContain("is not valid JSON");
  });

  it("rejects missing plan", () => {
    const root = tempRoot();
    const src = writeVbrief(root, "pending", {
      payloadOverride: { xBRIEFInfo: { version: "0.8" } },
    });
    const result = activate(src, { now: FIXED_NOW });
    expect(result.exitCode).toBe(1);
    expect(result.message).toContain("lacks a `plan` object");
  });

  it("rejects missing plan.status", () => {
    const root = tempRoot();
    const src = writeVbrief(root, "pending", {
      payloadOverride: { xBRIEFInfo: { version: "0.8" }, plan: { title: "T" } },
    });
    const result = activate(src, { now: FIXED_NOW });
    expect(result.exitCode).toBe(1);
    expect(result.message).toContain("lacks `plan.status`");
  });

  it("rejects destination collision", () => {
    const root = tempRoot();
    const src = writeVbrief(root, "pending", { status: "pending" });
    const activeDir = join(root, "xbrief", "active");
    mkdirSync(activeDir, { recursive: true });
    writeFileSync(join(activeDir, FIXTURE_NAME), "{}", "utf8");
    const result = activate(src, { now: FIXED_NOW });
    expect(result.exitCode).toBe(1);
    expect(result.message).toContain("Refusing to overwrite");
    expect(existsSync(src)).toBe(true);
  });

  // #3933 / #3156: replaces the former "creates vBRIEFInfo when absent"
  // expectation. That expectation encoded byte-identical parity with the
  // scripts/vbrief_activate.py oracle (#1782), not a v0.6 requirement -- a
  // valid legacy v0.6 brief already carries vBRIEFInfo.version. The oracle's
  // create-on-absent behaviour is deliberately not preserved.
  it("stamps an existing xBRIEFInfo@0.8 without adding a legacy key (#3933)", () => {
    const root = tempRoot();
    const src = writeVbrief(root, "pending", {
      payloadOverride: {
        xBRIEFInfo: { version: "0.8", updated: "2026-04-30T00:00:00Z" },
        plan: { title: "T", status: "pending", items: [] },
      },
    });
    const result = activate(src, { now: FIXED_NOW });
    expect(result.exitCode).toBe(0);
    const dest = join(root, "xbrief", "active", FIXTURE_NAME);
    const payload = JSON.parse(readFileSync(dest, "utf8")) as Record<string, unknown>;
    expect(Object.keys(payload)).toEqual(["xBRIEFInfo", "plan"]);
    expect((payload.xBRIEFInfo as { updated: string }).updated).toBe("2026-06-19T12:00:00Z");
    expect(validateVbriefSchema(payload, dest)).toEqual([]);
  });

  it("stamps an existing vBRIEFInfo@0.6 in place (#3933)", () => {
    const root = tempRoot();
    const src = writeVbrief(root, "pending", {
      payloadOverride: {
        vBRIEFInfo: { version: "0.6", updated: "2026-04-30T00:00:00Z" },
        plan: { title: "T", status: "pending", items: [] },
      },
    });
    const result = activate(src, { now: FIXED_NOW });
    expect(result.exitCode).toBe(0);
    const dest = join(root, "xbrief", "active", FIXTURE_NAME);
    const payload = JSON.parse(readFileSync(dest, "utf8")) as Record<string, unknown>;
    expect(Object.keys(payload)).toEqual(["vBRIEFInfo", "plan"]);
    expect(payload.vBRIEFInfo).toEqual({ version: "0.6", updated: "2026-06-19T12:00:00Z" });
    expect(validateVbriefSchema(payload, dest)).toEqual([]);
  });

  it("refuses a brief carrying neither envelope, before the move (#3933)", () => {
    const root = tempRoot();
    const src = writeVbrief(root, "pending", {
      payloadOverride: { plan: { title: "T", status: "pending", items: [] } },
    });
    const result = activate(src, { now: FIXED_NOW });
    expect(result.exitCode).toBe(1);
    expect(result.message).toContain("carries neither `xBRIEFInfo` (v0.8) nor `vBRIEFInfo` (v0.6)");
    // Refused before the move: pending source intact, nothing written to active/.
    expect(existsSync(src)).toBe(true);
    expect(existsSync(join(root, "xbrief", "active", FIXTURE_NAME))).toBe(false);
    const unchanged = JSON.parse(readFileSync(src, "utf8")) as Record<string, unknown>;
    expect(unchanged).toEqual({ plan: { title: "T", status: "pending", items: [] } });
  });

  it("rejects non-object vBRIEFInfo", () => {
    const root = tempRoot();
    const src = writeVbrief(root, "pending", {
      payloadOverride: { vBRIEFInfo: "bad", plan: { title: "T", status: "pending", items: [] } },
    });
    const result = activate(src, { now: FIXED_NOW });
    expect(result.exitCode).toBe(1);
    expect(result.message).toContain("non-object `vBRIEFInfo`");
  });

  it("rejects top-level array json", () => {
    const root = tempRoot();
    const src = writeVbrief(root, "pending", { rawOverride: "[]" });
    const result = activate(src, { now: FIXED_NOW });
    expect(result.exitCode).toBe(1);
    expect(result.message).toContain("top-level value is not a JSON object");
  });

  it("rejects top-level null json", () => {
    const root = tempRoot();
    const src = writeVbrief(root, "pending", { rawOverride: "null" });
    const result = activate(src, { now: FIXED_NOW });
    expect(result.exitCode).toBe(1);
    expect(result.message).toContain("top-level value is not a JSON object");
  });

  it("rejects cancelled folder", () => {
    const root = tempRoot();
    const src = writeVbrief(root, "cancelled", { status: "cancelled" });
    const result = activate(src, { now: FIXED_NOW });
    expect(result.exitCode).toBe(1);
    expect(result.message).toContain("only pending/ vBRIEFs can be activated");
  });

  it("rejects plan arrays and non-string status", () => {
    const root = tempRoot();
    const arrayPlan = writeVbrief(root, "pending", {
      payloadOverride: {
        xBRIEFInfo: { version: "0.8" },
        plan: [{ title: "T" }],
      },
    });
    const arrayResult = activate(arrayPlan, { now: FIXED_NOW });
    expect(arrayResult.exitCode).toBe(1);
    expect(arrayResult.message).toContain("lacks a `plan` object");

    const numericStatus = writeVbrief(root, "pending", {
      payloadOverride: {
        xBRIEFInfo: { version: "0.8" },
        plan: { title: "T", status: 3, items: [] },
      },
    });
    const numericResult = activate(numericStatus, { now: FIXED_NOW });
    expect(numericResult.exitCode).toBe(1);
    expect(numericResult.message).toContain("lacks `plan.status`");
  });
});

describe("activate projection containment (#3147 / #2447 parity)", () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  function tempRoot(prefix: string): string {
    const root = mkdtempSync(join(tmpdir(), prefix));
    roots.push(root);
    return root;
  }

  itSymlink(
    "refuses activate when xbrief/active is a symlink outside the project (no outside write, pending preserved)",
    () => {
      const root = tempRoot("deft-activate-symlink-");
      const escapeDir = tempRoot("deft-activate-escape-");
      mkdirSync(join(root, "xbrief", "pending"), { recursive: true });
      const escapeActive = join(escapeDir, "active");
      mkdirSync(escapeActive, { recursive: true });
      symlinkSync(escapeActive, join(root, "xbrief", "active"));

      const src = join(root, "xbrief", "pending", FIXTURE_NAME);
      writeFileSync(
        src,
        JSON.stringify({
          xBRIEFInfo: { version: "0.8", updated: "2026-04-30T00:00:00Z" },
          plan: { title: "T", status: "pending", items: [] },
        }),
        "utf8",
      );

      const result = activate(src, { now: FIXED_NOW });
      expect(result.exitCode).toBe(1);
      expect(result.message).toContain("projection write refused");
      // Pending source must not be unlinked on refuse.
      expect(existsSync(src)).toBe(true);
      // No write diverted outside the checkout via the escaping active/ symlink.
      expect(existsSync(join(escapeActive, FIXTURE_NAME))).toBe(false);
      expect(existsSync(join(escapeActive, `${FIXTURE_NAME}.tmp`))).toBe(false);
      const unchanged = JSON.parse(readFileSync(src, "utf8")) as { plan: { status: string } };
      expect(unchanged.plan.status).toBe("pending");
    },
  );

  it("repairs a unique ingest-owner plan.id on activate (#4119)", () => {
    const root = tempRoot("deft-4119-");
    const src = writeVbrief(root, "pending", {
      payloadOverride: {
        xBRIEFInfo: { version: "0.8", description: "Scope xBRIEF ingested from GitHub issue #9" },
        plan: {
          title: "T",
          status: "pending",
          narratives: { Origin: "Ingested from https://github.com/o/r/issues/9" },
          items: [],
        },
      },
    });
    const result = activate(src, { now: FIXED_NOW });
    expect(result.exitCode).toBe(0);
    const dest = join(root, "xbrief", "active", FIXTURE_NAME);
    const payload = JSON.parse(readFileSync(dest, "utf8")) as { plan: { id: string } };
    expect(payload.plan.id).toBe("github.issue.fallback.o.r.9");
  });

  it("activates an ingest owner with a unique plan.id (#4119)", () => {
    const root = tempRoot("deft-4119-");
    const src = writeVbrief(root, "pending", {
      payloadOverride: {
        xBRIEFInfo: { version: "0.8", description: "Scope xBRIEF ingested from GitHub issue #9" },
        plan: {
          id: "github.issue.9",
          title: "T",
          status: "pending",
          narratives: { Origin: "Ingested from https://github.com/o/r/issues/9" },
          items: [],
        },
      },
    });
    const result = activate(src, { now: FIXED_NOW });
    expect(result.exitCode).toBe(0);
    const dest = join(root, "xbrief", "active", FIXTURE_NAME);
    const payload = JSON.parse(readFileSync(dest, "utf8")) as { plan: { id: string } };
    expect(payload.plan.id).toBe("github.issue.9");
  });
});

describe("activate small-change lane gate (#6264)", () => {
  const laneRoots: string[] = [];
  afterEach(() => {
    for (const root of laneRoots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  function laneFixture(folder: "pending" | "active"): { root: string; rel: string } {
    const root = mkdtempSync(join(tmpdir(), "deft-activate-lane-"));
    laneRoots.push(root);
    const src = writeVbrief(root, folder, {
      payloadOverride: {
        xBRIEFInfo: { version: "0.8" },
        plan: {
          title: "fix x",
          status: folder === "pending" ? "pending" : "running",
          items: [],
          acceptance: {
            commands: [{ command: "npx vitest run packages/core/src/x.test.ts" }],
            none_stated: false,
            source_rung: "stated",
          },
          metadata: {
            "x-directive/smallChangeLane": {
              schema: "deft.small-change-lane.v1",
              state: "admitted",
              admitBase: "admitbase0",
            },
          },
        },
      },
    });
    return { root, rel: join("xbrief", folder, basename(src)) };
  }

  function lane(root: string, lines: number) {
    return {
      depth: "rapid" as const,
      bound: { maxProductionFiles: 1, maxChangedLines: 5 },
      runGit: (args: readonly string[]) => {
        const joined = args.join(" ");
        if (joined.startsWith("rev-parse --show-toplevel")) {
          return { status: 0, stdout: `${root}\n` };
        }
        if (joined.startsWith("rev-parse --verify")) return { status: 0, stdout: "parent0\n" };
        if (joined.startsWith("ls-files")) return { status: 0, stdout: "" };
        if (joined.startsWith("diff --numstat")) {
          return { status: 0, stdout: `${lines}\t0\tpackages/core/src/x.ts\0` };
        }
        if (joined.includes("diff -U0")) {
          return {
            status: 0,
            stdout: "diff --git a/packages/core/src/x.ts b/packages/core/src/x.ts\n+const x = 1;\n",
          };
        }
        return { status: 1, stdout: "" };
      },
    };
  }

  function inProjectRoot<T>(root: string, fn: () => T): T {
    const prev = process.cwd();
    process.chdir(root);
    try {
      return fn();
    } finally {
      process.chdir(prev);
    }
  }

  it("activates a thin lane brief from a relative path while the lane admits it", () => {
    const { root, rel } = laneFixture("pending");
    const result = inProjectRoot(root, () =>
      activate(rel, { now: FIXED_NOW, smallChangeLane: lane(root, 3) }),
    );
    expect(result.exitCode, result.message).toBe(0);
    expect(result.message).toContain("waived");
    expect(existsSync(join(root, "xbrief", "active", FIXTURE_NAME))).toBe(true);
  });

  it("refuses with the lane message and records the crossing through a relative path", () => {
    for (const folder of ["pending", "active"] as const) {
      const { root, rel } = laneFixture(folder);
      const result = inProjectRoot(root, () =>
        activate(rel, { now: FIXED_NOW, smallChangeLane: lane(root, 50) }),
      );
      expect(result.exitCode).toBe(1);
      expect(result.message).toContain("xbrief:activate refused (#6204)");
      expect(result.message).toContain("recorded on the brief as crossed");
      const onDisk = JSON.parse(readFileSync(join(root, rel), "utf8")) as {
        plan: { status: string; metadata: Record<string, { state: string }> };
      };
      expect(onDisk.plan.metadata["x-directive/smallChangeLane"]?.state).toBe("crossed");
      expect(onDisk.plan.status).toBe(folder === "pending" ? "pending" : "running");
    }
  });
});
