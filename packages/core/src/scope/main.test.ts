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

  it("scope:complete --help lists --merge-commit and --pr (#3721)", () => {
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
      expect(lifecycleMain(["complete", "--help"])).toBe(0);
      const text = `${out.join("")}${err.join("")}`;
      expect(text).toMatch(/--merge-commit/);
      expect(text).toMatch(/--pr/);
    } finally {
      stderrSpy.mockRestore();
      stdoutSpy.mockRestore();
    }
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
    const file = join(root, "xbrief", "proposed", "2026-01-01-sep.xbrief.json");
    writeFileSync(
      file,
      formatBriefJson(
        minimalScopeBrief({
          title: "T",
          status: "proposed",
          items: [],
          acceptance: {
            commands: [],
            none_stated: true,
            source_rung: "derived",
            ambiguity_attestation: "none_found",
            clauses: [
              {
                id: 1,
                text: "CLI promote keeps the derived stamp",
                artifact_path: null,
                ambiguous: false,
              },
            ],
          },
        }),
      ),
      "utf8",
    );
    expect(lifecycleMain(["promote", "--", file, `--project-root=${root}`])).toBe(0);
  });

  it("promotes via CLI with equals-form project root", () => {
    root = mkdtempSync(join(tmpdir(), "cli-eq-"));
    mkdirSync(join(root, "xbrief", "proposed"), { recursive: true });
    const file = join(root, "xbrief", "proposed", "2026-01-01-eq.xbrief.json");
    writeFileSync(
      file,
      formatBriefJson(
        minimalScopeBrief({
          title: "T",
          status: "proposed",
          items: [],
          acceptance: {
            commands: [],
            none_stated: true,
            source_rung: "derived",
            ambiguity_attestation: "none_found",
            clauses: [
              {
                id: 1,
                text: "CLI promote keeps the derived stamp",
                artifact_path: null,
                ambiguous: false,
              },
            ],
          },
        }),
      ),
      "utf8",
    );
    expect(lifecycleMain([`promote`, file, `--project-root=${root}`])).toBe(0);
  });

  it("returns usage for unknown flags", () => {
    root = mkdtempSync(join(tmpdir(), "cli-flag-"));
    mkdirSync(join(root, "xbrief", "proposed"), { recursive: true });
    const file = join(root, "xbrief", "proposed", "2026-01-01-s.xbrief.json");
    writeFileSync(
      file,
      formatBriefJson(minimalScopeBrief({ title: "T", status: "proposed", items: [] })),
      "utf8",
    );
    expect(lifecycleMain(["promote", file, "--project-root", root, "--nope"])).toBe(2);
  });

  it("stamp-evidence writes matchAny file evidence and refuses --pr (#4840)", () => {
    root = mkdtempSync(join(tmpdir(), "cli-stamp-"));
    mkdirSync(join(root, "xbrief", "active"), { recursive: true });
    mkdirSync(join(root, "packages", "a"), { recursive: true });
    writeFileSync(join(root, "packages", "a", "index.ts"), "export {}\n", "utf8");
    const file = join(root, "xbrief", "active", "story.xbrief.json");
    writeFileSync(
      file,
      formatBriefJson(
        minimalScopeBrief({
          title: "T",
          status: "running",
          items: [{ id: "clause.1", title: "clause.1", status: "pending" }],
          acceptance: {
            commands: [],
            none_stated: true,
            clauses: [
              {
                id: 1,
                text: "unit covers packages/a/index.ts",
                artifact_path: "packages/a/index.ts",
                ambiguous: false,
              },
            ],
          },
          metadata: { swarm: { file_scope: ["packages/a/**"] } },
        }),
      ),
      "utf8",
    );
    const out: string[] = [];
    const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      out.push(String(chunk));
      return true;
    });
    try {
      expect(lifecycleMain(["stamp-evidence", file, "--project-root", root])).toBe(0);
    } finally {
      stdoutSpy.mockRestore();
    }
    expect(out.join("")).toContain("scope:stamp-evidence");
    const parsed = JSON.parse(readFileSync(file, "utf8")) as {
      plan: { items: Array<Record<string, unknown>> };
    };
    expect(parsed.plan.items[0]?.["x-directive/evidence"]).toMatchObject({
      kind: "test",
      pointer: "packages/a/index.ts",
    });
    expect(lifecycleMain(["stamp-evidence", file, "--project-root", root, "--pr", "1"])).toBe(2);
    expect(
      lifecycleMain(["stamp-evidence", file, "--project-root", root, "--merge-commit", "abc"]),
    ).toBe(2);
  });

  it("bind-clause then stamp-evidence covers a pathless derived clause (#4986)", () => {
    root = mkdtempSync(join(tmpdir(), "cli-bind-"));
    mkdirSync(join(root, "xbrief", "active"), { recursive: true });
    mkdirSync(join(root, "packages", "a"), { recursive: true });
    const pointer = "packages/a/index.test.ts";
    writeFileSync(join(root, pointer), "export {}\n", "utf8");
    const file = join(root, "xbrief", "active", "story.xbrief.json");
    writeFileSync(
      file,
      formatBriefJson(
        minimalScopeBrief({
          title: "T",
          status: "running",
          items: [],
          acceptance: {
            commands: [],
            none_stated: true,
            source_rung: "derived",
            clauses: [
              {
                id: 1,
                text: "behavioral with no file token",
                artifact_path: null,
                ambiguous: false,
              },
            ],
          },
          metadata: { swarm: { file_scope: ["packages/a/**"] } },
        }),
      ),
      "utf8",
    );
    const out: string[] = [];
    const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      out.push(String(chunk));
      return true;
    });
    try {
      expect(
        lifecycleMain([
          "bind-clause",
          file,
          "--project-root",
          root,
          "--clause",
          "1",
          "--path",
          pointer,
        ]),
      ).toBe(0);
      expect(lifecycleMain(["stamp-evidence", file, "--project-root", root])).toBe(0);
    } finally {
      stdoutSpy.mockRestore();
    }
    expect(out.join("")).toContain("scope:bind-clause");
    expect(out.join("")).toContain("scope:stamp-evidence");
    const parsed = JSON.parse(readFileSync(file, "utf8")) as {
      plan: {
        acceptance: { clauses: Array<{ artifact_path: string | null }> };
        items: Array<Record<string, unknown>>;
      };
    };
    expect(parsed.plan.acceptance.clauses[0]?.artifact_path).toBe(pointer);
    expect(parsed.plan.items[0]?.["x-directive/evidence"]).toMatchObject({
      kind: "test",
      pointer,
    });
    expect(lifecycleMain(["bind-clause", file, "--project-root", root, "--path", pointer])).toBe(2);
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
