import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
});
