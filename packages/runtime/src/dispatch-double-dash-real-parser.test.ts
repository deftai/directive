/**
 * #6887 / #6912: `deft <verb> -- <args>` and `deft <verb> <args>` reach the verb's real parser
 * with the same arguments, for single-token and multi-token verbs. Runs the real router and
 * handlers (nothing stubbed, no --help) with a bad value, so each parser refuses before doing
 * any work.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { routeAndDispatch } from "./cli-router/index.js";

interface RunResult {
  readonly code: number;
  readonly out: string;
  readonly err: string;
}

let savedCwd: string;
let emptyDir: string;

beforeEach(() => {
  savedCwd = process.cwd();
  emptyDir = mkdtempSync(join(tmpdir(), "deft-6887-double-dash-"));
  process.chdir(emptyDir);
});

afterEach(() => {
  process.chdir(savedCwd);
  vi.restoreAllMocks();
  rmSync(emptyDir, { recursive: true, force: true });
});

async function run(argv: readonly string[]): Promise<RunResult> {
  let out = "";
  let err = "";
  const capture =
    (append: (text: string) => void) =>
    (chunk: string | Uint8Array): boolean => {
      append(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
      return true;
    };
  vi.spyOn(process.stdout, "write").mockImplementation(
    capture((text) => {
      out += text;
    }) as typeof process.stdout.write,
  );
  vi.spyOn(process.stderr, "write").mockImplementation(
    capture((text) => {
      err += text;
    }) as typeof process.stderr.write,
  );
  const code = await routeAndDispatch(argv, {
    writeOut: (text) => {
      out += text;
    },
    writeErr: (text) => {
      err += text;
    },
  });
  vi.restoreAllMocks();
  return { code, out, err };
}

describe("lone -- reaches the real parser unchanged (#6887)", () => {
  it("review-monitor:register gives the same refusal with and without --", async () => {
    const plain = await run(["review-monitor:register", "--pr=abc"]);
    const dashed = await run(["review-monitor:register", "--", "--pr=abc"]);
    expect(plain.code).toBe(2);
    expect(plain.err).toContain("invalid --pr value");
    expect(dashed).toEqual(plain);
  });

  it("occupancy:release gives the same refusal with and without --", async () => {
    const plain = await run(["occupancy:release", "--session-id="]);
    const dashed = await run(["occupancy:release", "--", "--session-id="]);
    expect(plain.code).toBe(2);
    expect(plain.err).toContain("argument --session-id: expected a non-empty value");
    expect(dashed).toEqual(plain);
  });
});

describe("lone -- after a multi-token verb reaches the real parser unchanged (#6912)", () => {
  it("cache:clear gives the same refusal with and without --", async () => {
    const plain = await run(["cache:clear", "--no-such-flag"]);
    const dashed = await run(["cache:clear", "--", "--no-such-flag"]);
    expect(plain.code).toBe(1);
    expect(dashed).toEqual(plain);
  });

  it("policy show gives the same refusal with and without --", async () => {
    const plain = await run(["policy", "show", "--format=invalid"]);
    const dashed = await run(["policy", "show", "--", "--format=invalid"]);
    expect(plain.code).toBe(2);
    expect(plain.err).toContain("policy: invalid choice: 'invalid'");
    expect(dashed).toEqual(plain);
  });

  it("policy resolve gives the same refusal with and without --", async () => {
    const plain = await run(["policy", "resolve", "--project-root"]);
    const dashed = await run(["policy", "resolve", "--", "--project-root"]);
    expect(plain.code).toBe(2);
    expect(plain.err).toContain("policy: argument --project-root: expected one argument");
    expect(dashed).toEqual(plain);
  });

  it("drops only one -- from -- --", async () => {
    const result = await run(["review-monitor:register", "--", "--", "--pr=abc"]);
    expect(result.code).toBe(2);
    expect(result.err).toContain("unrecognized argument: --");
  });

  it("keeps a -- that is a flag value", async () => {
    const result = await run(["triage-queue", "--limit", "--", "3"]);
    expect(result.code).toBe(2);
    expect(result.err).toContain("argument --limit: invalid int value: '--'");
  });
});
