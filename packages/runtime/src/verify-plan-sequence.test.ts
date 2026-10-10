import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { main as planSequenceMain } from "./plan-sequence.js";
import { main, parseArgs } from "./verify-plan-sequence.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("verify-plan-sequence CLI (#2402)", () => {
  it("requires target-kind and target", () => {
    expect(main([])).toBe(2);
  });

  it("skips cleanly with no active sequence", () => {
    const root = mkdtempSync(join(tmpdir(), "vps-"));
    roots.push(root);
    expect(main(["--project-root", root, "--target-kind", "issue", "--target", "1"])).toBe(0);
  });

  it("swallows -- at any position on the help-advertised form (#4203)", () => {
    const advertised = parseArgs(["--", "--target-kind", "issue", "--target", "4203"]);
    expect(advertised.error).toBeUndefined();
    expect(advertised.targetKind).toBe("issue");
    expect(advertised.target).toBe("4203");
    expect(parseArgs(["--target-kind", "issue", "--", "--target", "4203"])).toEqual(advertised);
    expect(parseArgs(["--target-kind", "issue", "--target", "4203", "--"])).toEqual(advertised);
    expect(parseArgs(["--target-kind", "issue", "--target", "4203"])).toEqual(advertised);
  });

  it("does not treat -- as a --target or --target-kind value (#4203)", () => {
    expect(parseArgs(["--target-kind", "--", "--target", "4203"]).error).toBeDefined();
    expect(parseArgs(["--target-kind", "issue", "--target", "--"]).error).toMatch(/--target/);
    expect(parseArgs(["--target-kind=--", "--target", "4203"]).error).toBeDefined();
    expect(parseArgs(["--target-kind", "issue", "--target=--"]).error).toMatch(/--target/);
  });

  it("unknown flags still fail closed with or without -- (#4203)", () => {
    expect(parseArgs(["--bogus", "--target-kind", "issue", "--target", "1"]).error).toMatch(
      /unknown flag: --bogus/,
    );
    expect(parseArgs(["--", "--bogus", "--target-kind", "issue", "--target", "1"]).error).toMatch(
      /unknown flag: --bogus/,
    );
  });

  it("typed --help writes usage to stdout and exits 0 (#4203)", () => {
    const out: string[] = [];
    const err: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((c) => {
      out.push(String(c));
      return true;
    });
    vi.spyOn(process.stderr, "write").mockImplementation((c) => {
      err.push(String(c));
      return true;
    });
    expect(main(["--help"])).toBe(0);
    expect(main(["-h"])).toBe(0);
    expect(out.join("")).toMatch(/usage: verify:plan-sequence -- /);
    expect(err.join("")).toBe("");
    vi.restoreAllMocks();
  });

  it("help-advertised form skips cleanly with no active sequence (#4203)", () => {
    const root = mkdtempSync(join(tmpdir(), "vps-sep-"));
    roots.push(root);
    expect(main(["--", "--project-root", root, "--target-kind", "issue", "--target", "1"])).toBe(0);
  });

  it("Taskfile ENGINE_CMD forwards CLI_ARGS without embedding -- (#4203)", () => {
    const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
    const verifyYml = readFileSync(join(repoRoot, "tasks/verify.yml"), "utf8");
    expect(verifyYml).toMatch(
      /ENGINE_CMD: 'verify-plan-sequence --project-root "\{\{\.USER_WORKING_DIR\}\}" \{\{\.CLI_ARGS\}\}'/,
    );
    expect(verifyYml).not.toMatch(/verify-plan-sequence -- \{\{\.CLI_ARGS\}\}/);
  });

  it("writes the exhausted fail-closed message exactly once to stderr", () => {
    const root = mkdtempSync(join(tmpdir(), "vps-exhausted-"));
    roots.push(root);
    const file = join(root, "plan.json");
    writeFileSync(
      file,
      JSON.stringify({
        sequence_id: "exhausted-test",
        sequence_kind: "delivery",
        authorized_by: "test",
        entries: [{ id: "pr-1", kind: "pr", issue: 1 }],
      }),
    );
    expect(planSequenceMain(["set", "--project-root", root, "--file", file])).toBe(0);
    expect(planSequenceMain(["advance", "--project-root", root])).toBe(0);
    const err = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    try {
      expect(main(["--project-root", root, "--target-kind", "pr", "--target", "pr-9999"])).toBe(1);
      const writes = err.mock.calls.map((c) => String(c[0]));
      const exhaustedWrites = writes.filter((w) => w.includes("Starting another item"));
      expect(exhaustedWrites).toHaveLength(1);
    } finally {
      err.mockRestore();
    }
  });

  it("fail-closes matching current entry whose origin is already completed (#4129)", () => {
    const root = mkdtempSync(join(tmpdir(), "vps-drift-"));
    roots.push(root);
    const file = join(root, "plan.json");
    writeFileSync(
      file,
      JSON.stringify({
        sequence_id: "drift",
        sequence_kind: "delivery",
        authorized_by: "test",
        entries: [{ id: "287", kind: "issue", issue: 287 }],
      }),
    );
    expect(planSequenceMain(["set", "--project-root", root, "--file", file])).toBe(0);
    mkdirSync(join(root, "xbrief/completed"), { recursive: true });
    writeFileSync(
      join(root, "xbrief/completed/287.xbrief.json"),
      JSON.stringify({
        xBRIEFInfo: { version: "0.8" },
        plan: {
          title: "Done",
          status: "completed",
          references: [
            {
              uri: "https://github.com/acme/app/issues/287",
              type: "x-xbrief/github-issue",
            },
          ],
        },
      }),
    );
    const err = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    try {
      expect(main(["--project-root", root, "--target-kind", "issue", "--target", "287"])).toBe(1);
      const text = err.mock.calls.map((c) => String(c[0])).join("");
      expect(text).toContain("Do not run task plan-sequence:advance until");
      expect(text).not.toContain("is not the current ordered-plan entry");
    } finally {
      err.mockRestore();
    }
  });

  it("names a missing sequence_kind and does not authorize the sequence (#4843)", () => {
    const root = mkdtempSync(join(tmpdir(), "vps-kind-"));
    roots.push(root);
    mkdirSync(join(root, ".deft"), { recursive: true });
    mkdirSync(join(root, "xbrief/cancelled"), { recursive: true });
    writeFileSync(
      join(root, ".deft/plan-sequence.json"),
      JSON.stringify({
        sequence_id: "undefined",
        authorized_by: "",
        sequence_kind: null,
        entries: [{ id: "285", kind: "issue", issue: 285 }],
      }),
    );
    writeFileSync(
      join(root, "xbrief/cancelled/285.xbrief.json"),
      JSON.stringify({
        xBRIEFInfo: { version: "0.8" },
        plan: {
          title: "Cancelled 285",
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
      expect(main(["--project-root", root, "--target-kind", "issue", "--target", "285"])).toBe(1);
      const text = err.join("");
      expect(text).toContain("plan-sequence.json");
      expect(text).toContain("missing sequence_kind");
      expect(text).toContain("not an authorized sequence");
      expect(text).toContain("cancelled/");
      expect(text).toContain("Stop and ask the operator whether to advance, replace, or clear");
      expect(text).not.toContain("every entry");
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
      expect(
        main(["--project-root", root, "--target-kind", "issue", "--target", "285", "--json"]),
      ).toBe(1);
      const payload = JSON.parse(out.join("")) as {
        ok?: boolean;
        authorized?: boolean;
        missing_field?: string;
        sequence_kind?: string;
        terminal_lifecycle_drift?: { folder: string };
      };
      expect(payload.ok).toBe(false);
      expect(payload.authorized).toBe(false);
      expect(payload.missing_field).toBe("sequence_kind");
      expect(payload.sequence_kind).toBeUndefined();
      expect(payload.terminal_lifecycle_drift?.folder).toBe("cancelled");
    } finally {
      outSpy.mockRestore();
      err2.mockRestore();
    }
  });

  it("does not call a later completed entry terminal drift (#4843)", () => {
    const root = mkdtempSync(join(tmpdir(), "vps-kind-later-"));
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
      expect(main(["--project-root", root, "--target-kind", "issue", "--target", "286"])).toBe(1);
      const text = err.join("");
      expect(text).toContain("missing sequence_kind");
      expect(text).not.toContain("terminal in");
    } finally {
      errSpy.mockRestore();
    }
  });
});
