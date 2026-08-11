import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseArgs, run } from "./verify-literal-ac.js";

describe("parseArgs", () => {
  it("parses path, quiet, capture-only, project-root", () => {
    const a = parseArgs([
      "--project-root",
      "/tmp/p",
      "--quiet",
      "--capture-only",
      "xbrief/active/s.xbrief.json",
    ]);
    expect(a.error).toBeUndefined();
    expect(a.projectRoot).toBe("/tmp/p");
    expect(a.quiet).toBe(true);
    expect(a.captureOnly).toBe(true);
    expect(a.xbriefPath).toBe("xbrief/active/s.xbrief.json");
  });

  it("rejects unknown flags", () => {
    const a = parseArgs(["--nope"]);
    expect(a.error).toMatch(/unrecognized/);
  });
});

describe("run", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("exits 2 when no xbrief available", () => {
    const root = mkdtempSync(join(tmpdir(), "literal-ac-cli-"));
    const code = run(["--project-root", root]);
    expect(code).toBe(2);
  });

  it("capture-only lists stored commands without executing shell", () => {
    const root = mkdtempSync(join(tmpdir(), "literal-ac-cli-"));
    const active = join(root, "xbrief", "active");
    mkdirSync(active, { recursive: true });
    const path = join(active, "story.xbrief.json");
    writeFileSync(
      path,
      JSON.stringify({
        xBRIEFInfo: { version: "0.8" },
        plan: {
          title: "t",
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
    expect(joined).toMatch(/task check/);
    expect(joined).toMatch(/"count": 1/);
  });
});
