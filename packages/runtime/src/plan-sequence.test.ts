import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mintPlanSequenceApprovalGrant } from "@deftai/directive-core/plan-sequence";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseArgs, main as planSequenceMain } from "./plan-sequence.js";
import { main as verifyPlanSequenceMain } from "./verify-plan-sequence.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("plan-sequence CLI (#2402)", () => {
  it("skips a lone -- separator (#3439)", () => {
    const parsed = parseArgs(["current", "--", "--json"]);
    expect(parsed.error).toBeUndefined();
    expect(parsed.action).toBe("current");
    expect(parsed.emitJson).toBe(true);
  });

  it("set/current/advance/verify happy path for two-PR plan", () => {
    const root = mkdtempSync(join(tmpdir(), "ps-cli-"));
    roots.push(root);
    const file = join(root, "plan.json");
    writeFileSync(
      file,
      JSON.stringify({
        sequence_id: "cli-test",
        sequence_kind: "delivery",
        authorized_by: "test",
        entries: [
          { id: "pr-1", kind: "pr", issue: 1 },
          { id: "pr-2", kind: "pr", issue: 2 },
        ],
      }),
    );
    expect(
      planSequenceMain([
        "set",
        "--project-root",
        root,
        "--file",
        file,
        "--expected-generation",
        "0",
      ]),
    ).toBe(0);
    expect(planSequenceMain(["current", "--project-root", root])).toBe(0);
    expect(
      verifyPlanSequenceMain(["--project-root", root, "--target-kind", "pr", "--target", "pr-1"]),
    ).toBe(0);
    expect(
      verifyPlanSequenceMain(["--project-root", root, "--target-kind", "pr", "--target", "pr-2"]),
    ).toBe(1);
    expect(
      planSequenceMain(["advance", "--project-root", root, "--expected-generation", "1"]),
    ).toBe(0);
    expect(
      verifyPlanSequenceMain(["--project-root", root, "--target-kind", "pr", "--target", "pr-2"]),
    ).toBe(0);
    expect(
      planSequenceMain(["advance", "--project-root", root, "--expected-generation", "2"]),
    ).toBe(0);
    expect(
      verifyPlanSequenceMain(["--project-root", root, "--target-kind", "pr", "--target", "pr-2"]),
    ).toBe(1);
    expect(planSequenceMain(["clear", "--project-root", root, "--expected-generation", "3"])).toBe(
      0,
    );
  });

  it("verify skips when no sequence", () => {
    const root = mkdtempSync(join(tmpdir(), "ps-cli-empty-"));
    roots.push(root);
    expect(
      verifyPlanSequenceMain(["--project-root", root, "--target-kind", "pr", "--target", "x"]),
    ).toBe(0);
  });

  it("set rejects a JSON payload that is not an object (null/array/primitive)", () => {
    const root = mkdtempSync(join(tmpdir(), "ps-cli-non-object-"));
    roots.push(root);
    const nullFile = join(root, "null.json");
    writeFileSync(nullFile, "null");
    expect(
      planSequenceMain([
        "set",
        "--project-root",
        root,
        "--file",
        nullFile,
        "--expected-generation",
        "0",
      ]),
    ).toBe(1);
    const arrayFile = join(root, "array.json");
    writeFileSync(arrayFile, "[1,2,3]");
    expect(
      planSequenceMain([
        "set",
        "--project-root",
        root,
        "--file",
        arrayFile,
        "--expected-generation",
        "0",
      ]),
    ).toBe(1);
  });

  it("covers argv/flag and JSON emit branches (#3027)", () => {
    const root = mkdtempSync(join(tmpdir(), "ps-cli-branches-"));
    roots.push(root);

    expect(planSequenceMain([])).toBe(2);
    expect(planSequenceMain(["nope"])).toBe(2);
    expect(planSequenceMain(["set", "--unknown"])).toBe(2);
    expect(planSequenceMain(["set", "--project-root"])).toBe(2);
    expect(planSequenceMain(["set", "--file"])).toBe(2);
    expect(planSequenceMain(["set", "--from-json"])).toBe(2);
    expect(planSequenceMain(["current", "--project-root", root])).toBe(1);
    expect(planSequenceMain(["advance", "--project-root", root])).toBe(2);
    expect(
      planSequenceMain(["advance", "--project-root", root, "--expected-generation", "0"]),
    ).toBe(1);
    expect(planSequenceMain(["clear", "--project-root", root])).toBe(2);
    expect(planSequenceMain(["clear", "--project-root", root, "--expected-generation", "0"])).toBe(
      0,
    );

    const inline = JSON.stringify({
      sequence_id: "inline",
      sequence_kind: "checklist",
      authorized_by: "t",
      entries: [{ id: "a", kind: "task" }],
    });
    expect(
      planSequenceMain([
        "set",
        `--project-root=${root}`,
        "--from-json",
        inline,
        "--json",
        "--expected-generation",
        "0",
      ]),
    ).toBe(0);
    expect(planSequenceMain(["current", "--project-root", root, "--json"])).toBe(0);
    expect(
      planSequenceMain(["advance", "--project-root", root, "--json", "--expected-generation", "1"]),
    ).toBe(0);
    // exhausted after advance past single entry
    expect(planSequenceMain(["current", "--project-root", root])).toBe(0);
    expect(planSequenceMain(["clear", "--project-root", root, "--expected-generation", "2"])).toBe(
      0,
    );
    // already absent — compare token survives clear
    expect(planSequenceMain(["clear", "--project-root", root, "--expected-generation", "3"])).toBe(
      0,
    );
    expect(planSequenceMain(["clear", "--project-root", root, "--expected-generation", "0"])).toBe(
      1,
    );

    // Full sequence object with current_index uses parsePlanSequence path
    const fullFile = join(root, "full.json");
    writeFileSync(
      fullFile,
      JSON.stringify({
        sequence_id: "full",
        sequence_kind: "delivery",
        authorized_by: "t",
        entries: [
          { id: "p1", kind: "pr", issue: 1 },
          { id: "p2", kind: "pr", issue: 2 },
        ],
        current_index: 0,
        batching_allowed: true,
        continuation_past_final: false,
        exhausted: false,
        created_at: "2026-08-01T00:00:00Z",
        updated_at: "2026-08-01T00:00:00Z",
      }),
    );
    expect(
      planSequenceMain([
        "set",
        `--file=${fullFile}`,
        "--project-root",
        root,
        "--expected-generation",
        "3",
      ]),
    ).toBe(0);
    expect(planSequenceMain(["current", "--project-root", root])).toBe(0);
    expect(planSequenceMain(["set", "--project-root", root])).toBe(2);
    expect(planSequenceMain(["set", "--project-root", root, "--expected-generation", "1"])).toBe(1);
  });

  it("current fail-closes when the current issue origin is cancelled (#4129 / #6205)", () => {
    const root = mkdtempSync(join(tmpdir(), "ps-cli-drift-"));
    roots.push(root);
    const file = join(root, "plan.json");
    writeFileSync(
      file,
      JSON.stringify({
        sequence_id: "drift",
        sequence_kind: "delivery",
        authorized_by: "test",
        entries: [
          { id: "287", kind: "issue", issue: 287 },
          { id: "288", kind: "issue", issue: 288 },
        ],
      }),
    );
    expect(
      planSequenceMain([
        "set",
        "--project-root",
        root,
        "--file",
        file,
        "--expected-generation",
        "0",
      ]),
    ).toBe(0);
    mkdirSync(join(root, "xbrief/cancelled"), { recursive: true });
    writeFileSync(
      join(root, "xbrief/cancelled/2026-09-01-287.xbrief.json"),
      JSON.stringify({
        xBRIEFInfo: { version: "0.8" },
        plan: {
          title: "Dropped 287",
          status: "cancelled",
          references: [
            {
              uri: "https://github.com/acme/app/issues/287",
              type: "x-xbrief/github-issue",
            },
          ],
        },
      }),
    );
    const err: string[] = [];
    const errSpy = vi.spyOn(process.stderr, "write").mockImplementation((c) => {
      err.push(String(c));
      return true;
    });
    try {
      expect(planSequenceMain(["current", "--project-root", root])).toBe(1);
      const text = err.join("");
      expect(text).toContain("terminal in");
      expect(text).toContain("Do not run task plan-sequence:advance until");
      expect(text).toContain("Do not treat this as permission to pick the next id");
    } finally {
      errSpy.mockRestore();
    }
    const out: string[] = [];
    const outSpy = vi.spyOn(process.stdout, "write").mockImplementation((c) => {
      out.push(String(c));
      return true;
    });
    const err2 = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    try {
      expect(planSequenceMain(["current", "--project-root", root, "--json"])).toBe(1);
      const payload = JSON.parse(out.join("")) as { terminal_lifecycle_drift?: { code: string } };
      expect(payload.terminal_lifecycle_drift?.code).toBe("terminal-lifecycle");
    } finally {
      outSpy.mockRestore();
      err2.mockRestore();
    }
  });

  it("current names a missing sequence_kind and the pending current terminal fact (#4843)", () => {
    const root = mkdtempSync(join(tmpdir(), "ps-cli-kind-"));
    roots.push(root);
    mkdirSync(join(root, ".deft"), { recursive: true });
    mkdirSync(join(root, "xbrief/cancelled"), { recursive: true });
    writeFileSync(
      join(root, ".deft/plan-sequence.json"),
      JSON.stringify({
        sequence_id: "undefined",
        authorized_by: "",
        current_index: 0,
        exhausted: false,
        entries: [
          { id: "285", kind: "issue", issue: 285 },
          { id: "286", kind: "issue", issue: 286 },
        ],
      }),
    );
    writeFileSync(
      join(root, "xbrief/cancelled/285.xbrief.json"),
      JSON.stringify({
        xBRIEFInfo: { version: "0.8" },
        plan: {
          title: "Dropped 285",
          status: "cancelled",
          references: [
            { uri: "https://github.com/acme/app/issues/285", type: "x-xbrief/github-issue" },
          ],
        },
      }),
    );
    const err: string[] = [];
    const errSpy = vi.spyOn(process.stderr, "write").mockImplementation((c) => {
      err.push(String(c));
      return true;
    });
    try {
      expect(planSequenceMain(["current", "--project-root", root])).toBe(1);
      const text = err.join("");
      expect(text).toContain("plan-sequence.json");
      expect(text).toContain("sequence_kind");
      expect(text).toContain("not an authorized sequence");
      expect(text).toContain("issue:285");
      expect(text).toContain("Stop and ask the operator whether to advance, replace, or clear");
      expect(text).not.toContain("every entry");
      expect(text).not.toContain("No active ordered-plan sequence");
    } finally {
      errSpy.mockRestore();
    }
    const out: string[] = [];
    const outSpy = vi.spyOn(process.stdout, "write").mockImplementation((c) => {
      out.push(String(c));
      return true;
    });
    const err2 = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    try {
      expect(planSequenceMain(["current", "--project-root", root, "--json"])).toBe(1);
      const payload = JSON.parse(out.join("")) as {
        ok?: boolean;
        authorized?: boolean;
        missing_field?: string;
        sequence_kind?: string;
        entries?: unknown;
        terminal_lifecycle_drift?: { code: string };
      };
      expect(payload.ok).toBe(false);
      expect(payload.authorized).toBe(false);
      expect(payload.missing_field).toBe("sequence_kind");
      expect(payload.terminal_lifecycle_drift?.code).toBe("terminal-lifecycle");
      expect(payload.sequence_kind).toBeUndefined();
      expect(payload.entries).toBeUndefined();
    } finally {
      outSpy.mockRestore();
      err2.mockRestore();
    }
  });

  it("current does not report terminal-lifecycle when only a later entry is terminal (#4843)", () => {
    const root = mkdtempSync(join(tmpdir(), "ps-cli-kind-later-"));
    roots.push(root);
    mkdirSync(join(root, ".deft"), { recursive: true });
    mkdirSync(join(root, "xbrief/completed"), { recursive: true });
    writeFileSync(
      join(root, ".deft/plan-sequence.json"),
      JSON.stringify({
        sequence_id: "undefined",
        authorized_by: "",
        entries: [
          { id: "285", kind: "issue", issue: 285 },
          { id: "286", kind: "issue", issue: 286 },
        ],
      }),
    );
    writeFileSync(
      join(root, "xbrief/completed/286.xbrief.json"),
      JSON.stringify({
        xBRIEFInfo: { version: "0.8" },
        plan: {
          title: "Done 286",
          status: "completed",
          references: [
            { uri: "https://github.com/acme/app/issues/286", type: "x-xbrief/github-issue" },
          ],
        },
      }),
    );
    const err: string[] = [];
    const errSpy = vi.spyOn(process.stderr, "write").mockImplementation((c) => {
      err.push(String(c));
      return true;
    });
    try {
      expect(planSequenceMain(["current", "--project-root", root])).toBe(1);
      const text = err.join("");
      expect(text).toContain("missing sequence_kind");
      expect(text).not.toContain("terminal in");
      expect(text).not.toContain("every entry");
    } finally {
      errSpy.mockRestore();
    }
  });

  it("set still writes when sequence_kind is omitted and advance keeps the bare throw (#4843)", () => {
    const root = mkdtempSync(join(tmpdir(), "ps-cli-kind-set-"));
    roots.push(root);
    const file = join(root, "plan.json");
    writeFileSync(
      file,
      JSON.stringify({
        sequence_id: "undefined",
        authorized_by: "",
        entries: [{ id: "285", kind: "story", issue: 285 }],
      }),
    );
    expect(
      planSequenceMain([
        "set",
        "--project-root",
        root,
        "--file",
        file,
        "--expected-generation",
        "0",
      ]),
    ).toBe(0);
    const written = JSON.parse(readFileSync(join(root, ".deft/plan-sequence.json"), "utf8")) as {
      sequence_kind?: string;
    };
    expect(written.sequence_kind).toBeUndefined();
    const err: string[] = [];
    const errSpy = vi.spyOn(process.stderr, "write").mockImplementation((c) => {
      err.push(String(c));
      return true;
    });
    try {
      expect(
        planSequenceMain(["advance", "--project-root", root, "--expected-generation", "1"]),
      ).toBe(1);
      const text = err.join("");
      expect(text).toContain("plan-sequence: sequence_kind required");
      expect(text).not.toContain("not an authorized sequence");
    } finally {
      errSpy.mockRestore();
    }
  });

  it("set/advance/clear require --expected-generation (#3907)", () => {
    const parsed = parseArgs(["set", "--expected-generation", "3", "--from-json", "{}"]);
    expect(parsed.expectedGeneration).toBe(3);
    expect(parseArgs(["clear", "--expected-generation=0"]).expectedGeneration).toBe(0);
    expect(parseArgs(["set", "--expected-generation"]).error).toMatch(/non-negative integer/);
    expect(parseArgs(["set", "--expected-generation", "1.5"]).error).toMatch(
      /non-negative integer/,
    );
    expect(parseArgs(["set", "--expected-generation", "-1"]).error).toMatch(/non-negative integer/);

    const root = mkdtempSync(join(tmpdir(), "ps-cli-cas-"));
    roots.push(root);
    const file = join(root, "plan.json");
    writeFileSync(
      file,
      JSON.stringify({
        sequence_id: "cas",
        sequence_kind: "checklist",
        authorized_by: "t",
        entries: [{ id: "a", kind: "task" }],
      }),
    );
    expect(planSequenceMain(["set", "--project-root", root, "--file", file])).toBe(2);
    expect(planSequenceMain(["advance", "--project-root", root])).toBe(2);
    expect(planSequenceMain(["clear", "--project-root", root])).toBe(2);
    expect(
      planSequenceMain([
        "set",
        "--project-root",
        root,
        "--file",
        file,
        "--expected-generation",
        "0",
      ]),
    ).toBe(0);
    const first = JSON.parse(readFileSync(join(root, ".deft/plan-sequence.json"), "utf8")) as {
      generation: number;
      sequence_id: string;
    };
    expect(first.generation).toBe(1);
    expect(
      planSequenceMain([
        "set",
        "--project-root",
        root,
        "--file",
        file,
        "--expected-generation",
        "0",
      ]),
    ).toBe(1);
    const unchanged = JSON.parse(readFileSync(join(root, ".deft/plan-sequence.json"), "utf8")) as {
      generation: number;
      sequence_id: string;
    };
    expect(unchanged.generation).toBe(1);
    expect(unchanged.sequence_id).toBe("cas");
  });
});

describe("plan-sequence derived cursor and approved writes (#6205)", () => {
  const NOW = new Date();

  function git(cwd: string, args: string[]): void {
    execFileSync("git", args, { cwd, stdio: "ignore" });
  }

  /** Git checkout with a GitHub origin, an optional bound-gate policy and a 3-issue plan. */
  function fixture(bound: boolean | null, seed = true): string {
    const root = mkdtempSync(join(tmpdir(), "ps-6205-"));
    roots.push(root);
    git(root, ["init", "-q"]);
    git(root, ["remote", "add", "origin", "https://github.com/acme/app.git"]);
    mkdirSync(join(root, "xbrief"), { recursive: true });
    writeFileSync(
      join(root, "xbrief", "PROJECT-DEFINITION.xbrief.json"),
      JSON.stringify({
        plan: {
          title: "pd",
          status: "running",
          "x-directive/policy": bound === null ? {} : { requireBoundPrePrPush: bound },
        },
      }),
    );
    if (seed) {
      const payload = JSON.stringify({
        sequence_id: "seq-6205",
        sequence_kind: "delivery",
        authorized_by: "operator",
        entries: [101, 102, 103].map((n) => ({ id: String(n), kind: "issue", issue: n })),
      });
      const code = quiet(() =>
        planSequenceMain([
          "set",
          "--project-root",
          root,
          "--from-json",
          payload,
          "--expected-generation",
          "0",
        ]),
      );
      expect(code.code).toBe(0);
    }
    return root;
  }

  function completeBrief(root: string, issue: number, folder = "completed"): void {
    mkdirSync(join(root, "xbrief", folder), { recursive: true });
    writeFileSync(
      join(root, "xbrief", folder, `2026-11-16-${issue}-story.xbrief.json`),
      JSON.stringify({
        plan: {
          title: `Story ${issue}`,
          status: folder === "cancelled" ? "cancelled" : "completed",
          references: [
            { uri: `https://github.com/acme/app/issues/${issue}`, type: "x-xbrief/github-issue" },
          ],
        },
      }),
    );
  }

  function quiet(fn: () => number): { code: number; out: string; err: string } {
    const out: string[] = [];
    const err: string[] = [];
    const o = vi.spyOn(process.stdout, "write").mockImplementation((c) => {
      out.push(String(c));
      return true;
    });
    const e = vi.spyOn(process.stderr, "write").mockImplementation((c) => {
      err.push(String(c));
      return true;
    });
    try {
      return { code: fn(), out: out.join(""), err: err.join("") };
    } finally {
      o.mockRestore();
      e.mockRestore();
    }
  }

  function stored(root: string): {
    generation: number;
    current_index: number;
    exhausted: boolean;
    entries: { id: string; status: string }[];
    insert_approvals?: { entry_id: string; grant_id: string; approved_at: string }[];
  } {
    return JSON.parse(readFileSync(join(root, ".deft/plan-sequence.json"), "utf8"));
  }

  function mint(
    root: string,
    target: string,
    generation: number,
    position?: number,
    sequenceId = "seq-6205",
  ) {
    const issue = /^insert:issue:(\d+)$/.exec(target)?.[1];
    const minted = mintPlanSequenceApprovalGrant({
      projectRoot: root,
      target,
      sequenceId,
      generation,
      position: position ?? null,
      issue: issue !== undefined ? Number(issue) : null,
      now: NOW,
    });
    if (!minted.ok) throw new Error(minted.reason);
    return minted.grant.id;
  }

  const ps = (root: string, ...args: string[]) =>
    quiet(() => planSequenceMain([...args, "--project-root", root]));
  const verify = (root: string, target: string, json = false) =>
    quiet(() =>
      verifyPlanSequenceMain([
        "--project-root",
        root,
        "--target-kind",
        "issue",
        "--target",
        target,
        ...(json ? ["--json"] : []),
      ]),
    );

  it("clause.1 / clause.2: current and verify derive past a completed brief with a stale stored cursor", () => {
    const root = fixture(null);
    completeBrief(root, 101);
    const text = ps(root, "current");
    expect(text.code).toBe(0);
    expect(text.out).toContain("index=1");
    expect(text.out).toContain("derived: issue:101 finished by xbrief/completed/");
    expect(text.out).toContain("current: issue:102 (#102)");
    const json = ps(root, "current", "--json");
    const payload = JSON.parse(json.out) as {
      current_index: number;
      stored_current_index: number;
      derived_finished: { id: string }[];
    };
    expect(payload.current_index).toBe(1);
    expect(payload.stored_current_index).toBe(0);
    expect(payload.derived_finished.map((d) => d.id)).toEqual(["101"]);
    expect(verify(root, "102").code).toBe(0);
    expect(verify(root, "101").code).toBe(1);
    expect(stored(root).current_index).toBe(0);
  });

  it("clause.2: current reads exhausted once every entry's brief is completed", () => {
    const root = fixture(null);
    for (const n of [101, 102, 103]) completeBrief(root, n);
    expect(ps(root, "current").out).toContain("current: (exhausted");
  });

  it("clause.3: a cancelled origin stops current with terminal-lifecycle", () => {
    const root = fixture(null);
    completeBrief(root, 101, "cancelled");
    const result = ps(root, "current", "--json");
    expect(result.code).toBe(1);
    expect(JSON.parse(result.out).terminal_lifecycle_drift.code).toBe("terminal-lifecycle");
  });

  it("clause.16: a manual advance after a derived advance advances the entry current shows", () => {
    const root = fixture(null);
    completeBrief(root, 101);
    const result = ps(root, "advance", "--expected-generation", "1");
    expect(result.code).toBe(0);
    expect(result.out).toContain("OK advanced past issue:102 to index=2 (issue:103)");
    const after = stored(root);
    expect(after.current_index).toBe(2);
    expect(after.entries.map((e) => e.status)).toEqual(["completed", "completed", "pending"]);
  });

  it("clause.16: insert without a grant refuses under the bound gate and names the mint command", () => {
    const root = fixture(true);
    const result = ps(
      root,
      "insert",
      "--kind",
      "issue",
      "--id",
      "900",
      "--issue",
      "900",
      "--expected-generation",
      "1",
    );
    expect(result.code).toBe(1);
    expect(result.err).toContain("no plan-sequence-approval grant binds this insert");
    expect(result.err).toContain(
      "--target insert:issue:900 --plan-ref seq-6205 --generation 1 --position 0 --issue-ids 900 --repo acme/app",
    );
    expect(stored(root).entries).toHaveLength(3);
  });

  it("clause.16: insert refuses a grant for another entry or position, then admits the matching one once", () => {
    const root = fixture(true);
    mint(root, "insert:issue:900", 1, 1);
    mint(root, "insert:issue:901", 1, 0);
    const insert900At0 = [
      "insert",
      "--kind",
      "issue",
      "--id",
      "900",
      "--issue",
      "900",
      "--expected-generation",
      "1",
    ];
    expect(ps(root, ...insert900At0).code).toBe(1);
    const grant = mint(root, "insert:issue:900", 1, 0);
    // #6205 review P1: the grant binds the title too, so a title alias for
    // another target ("901") is refused and the grant stays unspent.
    const aliased = ps(root, ...insert900At0, "--title", "901");
    expect(aliased.code).toBe(1);
    expect(aliased.err).toContain('--title "901"');
    expect(verify(root, "901").code).toBe(1);
    const ok = ps(root, ...insert900At0);
    expect(ok.code, ok.err).toBe(0);
    expect(ok.out).toContain(
      `OK plan-sequence insert issue:900 at index=0 (approval grant ${grant})`,
    );
    const after = stored(root);
    expect(after.entries.map((e) => e.id)).toEqual(["900", "101", "102", "103"]);
    expect(after.insert_approvals).toEqual([
      expect.objectContaining({ entry_id: "900", grant_id: grant }),
    ]);
    // Reused grant: the same binding at the same generation is spent.
    const replay = ps(
      root,
      "insert",
      "--kind",
      "issue",
      "--id",
      "900",
      "--issue",
      "900",
      "--expected-generation",
      "1",
    );
    expect(replay.code).toBe(1);

    // clause.13: verify prints the approval row for the current inserted entry.
    const text = verify(root, "900");
    expect(text.code).toBe(0);
    expect(text.out).toContain(`insert approval: entry_id=900 grant_id=${grant}`);
    const json = JSON.parse(verify(root, "900", true).out) as {
      insert_approval?: { grant_id: string };
    };
    expect(json.insert_approval?.grant_id).toBe(grant);
    expect(JSON.parse(verify(root, "900", true).out)).toHaveProperty("ok", true);
  });

  it("ruling 6908156182: insert needs no grant when the bound gate is off or absent", () => {
    for (const bound of [false, null]) {
      const root = fixture(bound);
      const result = ps(
        root,
        "insert",
        "--kind",
        "task",
        "--id",
        "hotfix",
        "--position",
        "2",
        "--expected-generation",
        "1",
        "--json",
      );
      expect(result.code, result.err).toBe(0);
      const payload = JSON.parse(result.out) as { approval_grant: string | null; position: number };
      expect(payload.approval_grant).toBeNull();
      expect(payload.position).toBe(2);
      expect(stored(root).entries.map((e) => e.id)).toEqual(["101", "102", "hotfix", "103"]);
      expect(stored(root).insert_approvals).toBeUndefined();
    }
  });

  it("insert refuses bad arguments, a missing plan and an earlier index", () => {
    const root = fixture(false);
    expect(ps(root, "insert", "--id", "x", "--expected-generation", "1").code).toBe(2);
    expect(ps(root, "insert", "--kind", "issue", "--expected-generation", "1").code).toBe(2);
    expect(ps(root, "insert", "--kind", "issue", "--id", "x").code).toBe(2);
    expect(ps(root, "insert", "--kind", "issue", "--id", "x", "--issue", "0").code).toBe(2);
    expect(ps(root, "insert", "--kind", "issue", "--id", "x", "--position", "-1").code).toBe(2);
    completeBrief(root, 101);
    const earlier = ps(
      root,
      "insert",
      "--kind",
      "task",
      "--id",
      "x",
      "--position",
      "0",
      "--expected-generation",
      "1",
    );
    expect(earlier.code).toBe(1);
    expect(earlier.err).toContain("before the effective cursor");
    const empty = fixture(false, false);
    expect(
      ps(empty, "insert", "--kind", "task", "--id", "x", "--expected-generation", "0").code,
    ).toBe(1);
  });

  it("clause.14 / clause.16: under the bound gate, set on an existing plan and clear need a grant", () => {
    const root = fixture(true);
    const replacement = JSON.stringify({
      sequence_id: "seq-other",
      sequence_kind: "delivery",
      authorized_by: "agent",
      entries: [{ id: "999", kind: "issue", issue: 999 }],
    });
    const set = ps(root, "set", "--from-json", replacement, "--expected-generation", "1");
    expect(set.code).toBe(1);
    expect(set.err).toContain("--target replace --plan-ref seq-6205 --generation 1");
    expect(ps(root, "clear", "--expected-generation", "1").code).toBe(1);
    expect(stored(root).entries).toHaveLength(3);

    mint(root, "replace", 1);
    const approved = ps(
      root,
      "set",
      "--from-json",
      replacement,
      "--expected-generation",
      "1",
      "--json",
    );
    expect(approved.code, approved.err).toBe(0);
    expect(JSON.parse(approved.out).approval_grant).toMatch(/^grant-/);
    // The clear binds the plan now on disk (the replacement's sequence id).
    mint(root, "clear", 2, undefined, "seq-other");
    expect(ps(root, "clear", "--expected-generation", "2").out).toContain(
      "OK plan-sequence cleared",
    );
  });

  it("clause.16: advance to exhaustion then set without a grant refuses under the bound gate", () => {
    const root = fixture(true);
    for (const generation of ["1", "2", "3"]) {
      expect(ps(root, "advance", "--expected-generation", generation).code).toBe(0);
    }
    expect(stored(root).exhausted).toBe(true);
    const again = JSON.stringify({
      sequence_id: "seq-next",
      sequence_kind: "delivery",
      authorized_by: "agent",
      entries: [{ id: "555", kind: "issue" }],
    });
    expect(ps(root, "set", "--from-json", again, "--expected-generation", "4").code).toBe(1);
  });

  it("clause.15 / ruling 6906744687: a first set needs no grant; with the gate off set and clear need none", () => {
    const first = fixture(true, false);
    const payload = JSON.stringify({
      sequence_id: "first",
      sequence_kind: "delivery",
      authorized_by: "operator",
      entries: [{ id: "1", kind: "issue" }],
    });
    expect(ps(first, "set", "--from-json", payload, "--expected-generation", "0").code).toBe(0);
    for (const bound of [false, null]) {
      const root = fixture(bound);
      expect(ps(root, "set", "--from-json", payload, "--expected-generation", "1").code).toBe(0);
      expect(ps(root, "clear", "--expected-generation", "2").code).toBe(0);
    }
  });

  it("refuses a guarded write when the existing plan cannot be read", () => {
    const root = fixture(true, false);
    mkdirSync(join(root, ".deft"), { recursive: true });
    writeFileSync(join(root, ".deft/plan-sequence.json"), "{oops");
    const result = ps(root, "clear", "--expected-generation", "0");
    expect(result.code).toBe(1);
    expect(result.err).toContain("the existing plan cannot be read");
  });

  it("keeps damaged-plan recovery reachable when the bound gate is off", () => {
    const root = fixture(false, false);
    mkdirSync(join(root, ".deft"), { recursive: true });
    writeFileSync(join(root, ".deft/plan-sequence.json"), "{oops");
    writeFileSync(join(root, ".deft/plan-sequence.json.generation"), '{"generation":3}\n');
    // The store recovers a damaged plan through its saved generation token.
    const result = ps(root, "clear", "--expected-generation", "3");
    expect(result.code, result.err).toBe(0);
    expect(result.out).toContain("OK plan-sequence cleared");
  });
});
