import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { stampCompletionMetadata } from "./capacity-stamp.js";
import { demoteOne } from "./demote.js";
import { demoteMain, lifecycleMain, undoMain } from "./main.js";
import { resolveProjectRoot } from "./project-context.js";
import { minimalScopeBrief } from "./scope-test-fixtures.test.js";
import { runTransition } from "./transition.js";
import { formatBriefJson } from "./vbrief-json.js";
import { checkWipCap, formatWipCapRefusal } from "./wip-cap-check.js";

describe("project-context", () => {
  afterEach(() => {
    delete process.env.DEFT_PROJECT_ROOT;
  });

  it("finds vbrief sentinel", () => {
    const root = mkdtempSync(join(tmpdir(), "ctx-"));
    mkdirSync(join(root, "xbrief"));
    expect(resolveProjectRoot(root)).toBe(root);
    rmSync(root, { recursive: true, force: true });
  });

  it("returns null for non-directory cli root", () => {
    const file = join(tmpdir(), `not-dir-${Date.now()}`);
    writeFileSync(file, "x", "utf8");
    expect(resolveProjectRoot(file)).toBeNull();
    rmSync(file);
  });

  it("uses DEFT_PROJECT_ROOT when set", () => {
    const root = mkdtempSync(join(tmpdir(), "env-ctx-"));
    mkdirSync(join(root, "xbrief"));
    vi.stubEnv("DEFT_PROJECT_ROOT", root);
    expect(resolveProjectRoot(null)).toBe(root);
    rmSync(root, { recursive: true, force: true });
  });
});

describe("wip-cap-check", () => {
  it("allows promote when under cap", () => {
    const root = mkdtempSync(join(tmpdir(), "wip-"));
    mkdirSync(join(root, "xbrief", "pending"), { recursive: true });
    writeFileSync(
      join(root, "xbrief", "PROJECT-DEFINITION.xbrief.json"),
      formatBriefJson({
        plan: { title: "P", status: "running", items: [], policy: { wipCap: 10 } },
      }),
      "utf8",
    );
    const check = checkWipCap(root);
    expect(check.allowed).toBe(true);
    expect(formatWipCapRefusal({ ...check, allowed: false })).toContain("WIP cap reached");
    rmSync(root, { recursive: true, force: true });
  });
});

describe("lifecycleMain", () => {
  let root = "";
  afterEach(() => {
    if (root.length > 0) {
      rmSync(root, { recursive: true, force: true });
      root = "";
    }
  });

  it("returns usage error without args", () => {
    expect(lifecycleMain([])).toBe(2);
  });

  it("scope:promote --help does not dump scope_lifecycle.py required action (#3439)", () => {
    const err: string[] = [];
    const out: string[] = [];
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
      err.push(String(chunk));
      return true;
    });
    const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      out.push(String(chunk));
      return true;
    });
    try {
      expect(lifecycleMain(["promote", "--help"])).toBe(0);
      const text = `${out.join("")}${err.join("")}`;
      expect(text).not.toMatch(/scope_lifecycle\.py/);
      expect(text).not.toMatch(/required: action/);
      expect(text).toMatch(/scope:promote/);
    } finally {
      stderrSpy.mockRestore();
      stdoutSpy.mockRestore();
    }
  });

  it("skips a lone -- separator before the file (#3439)", () => {
    root = mkdtempSync(join(tmpdir(), "cli-sep-"));
    mkdirSync(join(root, "xbrief", "proposed"), { recursive: true });
    const file = join(root, "xbrief", "proposed", "sep.xbrief.json");
    writeFileSync(
      file,
      formatBriefJson(minimalScopeBrief({ title: "T", status: "proposed", items: [] })),
      "utf8",
    );
    expect(lifecycleMain(["promote", "--", file, `--project-root=${root}`])).toBe(0);
  });

  it("promotes via CLI with equals-form project root", () => {
    root = mkdtempSync(join(tmpdir(), "cli-eq-"));
    mkdirSync(join(root, "xbrief", "proposed"), { recursive: true });
    const file = join(root, "xbrief", "proposed", "eq.xbrief.json");
    writeFileSync(
      file,
      formatBriefJson(minimalScopeBrief({ title: "T", status: "proposed", items: [] })),
      "utf8",
    );
    expect(lifecycleMain([`promote`, file, `--project-root=${root}`])).toBe(0);
  });

  it("returns usage for unknown flags", () => {
    root = mkdtempSync(join(tmpdir(), "cli-flag-"));
    mkdirSync(join(root, "xbrief", "proposed"), { recursive: true });
    const file = join(root, "xbrief", "proposed", "s.xbrief.json");
    writeFileSync(
      file,
      formatBriefJson(minimalScopeBrief({ title: "T", status: "proposed", items: [] })),
      "utf8",
    );
    expect(lifecycleMain(["promote", file, "--project-root", root, "--nope"])).toBe(2);
  });

  it("returns 1 for invalid transition", () => {
    root = mkdtempSync(join(tmpdir(), "cli-bad-"));
    mkdirSync(join(root, "xbrief", "active"), { recursive: true });
    const file = join(root, "xbrief", "active", "s.xbrief.json");
    writeFileSync(
      file,
      formatBriefJson(minimalScopeBrief({ title: "T", status: "running", items: [] })),
      "utf8",
    );
    expect(lifecycleMain(["promote", file, "--project-root", root])).toBe(1);
  });

  it("fail and unblock transitions stay in active", () => {
    root = mkdtempSync(join(tmpdir(), "fail-unblock-"));
    mkdirSync(join(root, "xbrief", "active"), { recursive: true });
    const blocked = join(root, "xbrief", "active", "b.xbrief.json");
    writeFileSync(
      blocked,
      formatBriefJson(minimalScopeBrief({ title: "T", status: "blocked", items: [] })),
      "utf8",
    );
    expect(runTransition("unblock", blocked).ok).toBe(true);
    const running = join(root, "xbrief", "active", "r.xbrief.json");
    writeFileSync(
      running,
      formatBriefJson(minimalScopeBrief({ title: "T", status: "running", items: [] })),
      "utf8",
    );
    expect(runTransition("fail", running).ok).toBe(true);
  });
});

describe("demoteMain", () => {
  let root = "";
  afterEach(() => {
    if (root.length > 0) {
      rmSync(root, { recursive: true, force: true });
      root = "";
    }
  });

  it("demotes a pending file", () => {
    root = mkdtempSync(join(tmpdir(), "dem-cli-"));
    mkdirSync(join(root, "xbrief", "pending"), { recursive: true });
    const file = join(root, "xbrief", "pending", "d.xbrief.json");
    writeFileSync(
      file,
      formatBriefJson({ plan: { title: "T", status: "pending", items: [] } }),
      "utf8",
    );
    expect(demoteMain([file, "--project-root", root, "--reason=relief"])).toBe(0);
  });

  it("returns 1 when demote transition invalid", () => {
    root = mkdtempSync(join(tmpdir(), "dem-bad-"));
    mkdirSync(join(root, "xbrief", "proposed"), { recursive: true });
    const file = join(root, "xbrief", "proposed", "d.xbrief.json");
    writeFileSync(
      file,
      formatBriefJson(minimalScopeBrief({ title: "T", status: "proposed", items: [] })),
      "utf8",
    );
    expect(demoteMain([file, "--project-root", root])).toBe(1);
  });

  it("batch demote accepts actor and equals-form flags", () => {
    root = mkdtempSync(join(tmpdir(), "dem-batch-"));
    mkdirSync(join(root, "xbrief", "pending"), { recursive: true });
    expect(
      demoteMain(["--batch", "--older-than-days=0", "--project-root", root, "--actor", "ci-bot"]),
    ).toBe(0);
  });

  it("returns usage for unknown demote flags", () => {
    root = mkdtempSync(join(tmpdir(), "dem-flag-"));
    const file = join(root, "xbrief", "pending", "d.xbrief.json");
    expect(demoteMain([file, "--project-root", root, "--nope"])).toBe(2);
  });
});

describe("capacity-stamp policy branches", () => {
  it("returns empty bucket for malformed policy sections", () => {
    const root = mkdtempSync(join(tmpdir(), "cap-policy-"));
    mkdirSync(join(root, "xbrief"), { recursive: true });
    for (const body of [
      { plan: null },
      { plan: { policy: null } },
      { plan: { policy: { capacityAllocation: null } } },
    ]) {
      writeFileSync(
        join(root, "xbrief", "PROJECT-DEFINITION.xbrief.json"),
        formatBriefJson(body),
        "utf8",
      );
      const plan: Record<string, unknown> = {};
      stampCompletionMetadata(plan, root, "2026-06-01T00:00:00Z");
      expect((plan.metadata as Record<string, unknown>)?.capacityBucket).toBeUndefined();
    }
    rmSync(root, { recursive: true, force: true });
  });
});

describe("undoMain", () => {
  let root = "";
  afterEach(() => {
    if (root.length > 0) {
      rmSync(root, { recursive: true, force: true });
      root = "";
    }
  });

  it("returns usage when no id", () => {
    expect(undoMain([])).toBe(2);
  });

  it("undoes latest demote entry", () => {
    root = mkdtempSync(join(tmpdir(), "undo-latest-"));
    mkdirSync(join(root, "xbrief", "pending"), { recursive: true });
    mkdirSync(join(root, "xbrief", ".triage-cache"), { recursive: true });
    const pending = join(root, "xbrief", "pending", "u.xbrief.json");
    writeFileSync(
      pending,
      formatBriefJson({ plan: { title: "T", status: "pending", items: [] } }),
      "utf8",
    );
    demoteOne(pending, root, "test");
    expect(undoMain(["--latest", "--project-root", root])).toBe(0);
    expect(readFileSync(join(root, "xbrief", "pending", "u.xbrief.json"), "utf8")).toContain(
      "pending",
    );
  });
});
