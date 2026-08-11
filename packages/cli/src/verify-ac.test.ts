import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseArgs, run } from "./verify-ac.js";

describe("verify:ac parseArgs (#3284)", () => {
  it("parses soft-missing, quiet, capture-only, project-root", () => {
    const a = parseArgs([
      "--project-root",
      "/tmp/p",
      "--quiet",
      "--capture-only",
      "--soft-missing-xbrief",
      "xbrief/active/s.xbrief.json",
    ]);
    expect(a.error).toBeUndefined();
    expect(a.projectRoot).toBe("/tmp/p");
    expect(a.quiet).toBe(true);
    expect(a.captureOnly).toBe(true);
    expect(a.softMissingXbrief).toBe(true);
    expect(a.xbriefPath).toBe("xbrief/active/s.xbrief.json");
  });

  it("rejects unknown flags", () => {
    expect(parseArgs(["--nope"]).error).toMatch(/unrecognized/);
  });
});

describe("verify:ac run (#3284)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("soft-missing exits 0 when no active xbrief", () => {
    const root = mkdtempSync(join(tmpdir(), "verify-ac-soft-"));
    const code = run(["--project-root", root, "--soft-missing-xbrief"]);
    expect(code).toBe(0);
  });

  it("exits 2 when no xbrief and soft-missing off", () => {
    const root = mkdtempSync(join(tmpdir(), "verify-ac-hard-"));
    expect(run(["--project-root", root])).toBe(2);
  });

  it("capture-only includes source_rung from plan.acceptance", () => {
    const root = mkdtempSync(join(tmpdir(), "verify-ac-cap-"));
    const active = join(root, "xbrief", "active");
    mkdirSync(active, { recursive: true });
    const path = join(active, "story.xbrief.json");
    writeFileSync(
      path,
      JSON.stringify({
        xBRIEFInfo: { version: "0.8" },
        plan: {
          title: "t",
          acceptance: {
            commands: [{ command: "task check" }],
            none_stated: false,
            source_rung: "stated",
          },
          metadata: {
            literal_acceptance_commands: [{ command: "task check", source: "explicit" }],
          },
          items: [],
        },
      }),
      "utf8",
    );
    const chunks: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((c) => {
      chunks.push(String(c));
      return true;
    });
    const code = run(["--project-root", root, "--capture-only", path]);
    expect(code).toBe(0);
    const joined = chunks.join("");
    expect(joined).toMatch(/source_rung/);
    expect(joined).toMatch(/stated/);
    expect(joined).toMatch(/task check/);
  });
});
