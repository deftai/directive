import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { main } from "./escalation-cli.js";

const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) {
    try {
      rmSync(root, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
});

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "cli-esc-"));
  roots.push(root);
  return root;
}

describe("escalation CLI (#518)", () => {
  it("file requires type and title", () => {
    const root = tempRoot();
    const err: string[] = [];
    vi.spyOn(process.stderr, "write").mockImplementation((c) => {
      err.push(String(c));
      return true;
    });
    expect(main(["file", "--project-root", root])).toBe(2);
    expect(err.join("")).toMatch(/type/);
  });

  it("file / list / resolve / batch-approve round-trip", () => {
    const root = tempRoot();
    const out: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((c) => {
      out.push(String(c));
      return true;
    });
    expect(
      main([
        "file",
        "--project-root",
        root,
        "--type",
        "cmd_approval",
        "--title",
        "read package.json",
        "--agent",
        "w1",
      ]),
    ).toBe(0);
    expect(out.join("")).toMatch(/escalation filed/);

    expect(
      main([
        "file",
        "--project-root",
        root,
        "--type",
        "design_decision",
        "--title",
        "schema choice",
        "--id",
        "esc-design-1",
      ]),
    ).toBe(0);

    expect(main(["list", "--project-root", root, "--open"])).toBe(0);
    expect(out.join("")).toMatch(/cmd_approval/);

    expect(main(["batch-approve", "--project-root", root])).toBe(0);
    expect(out.join("")).toMatch(/batch-approve/);

    expect(
      main([
        "resolve",
        "--project-root",
        root,
        "esc-design-1",
        "--decision",
        "approved",
        "--note",
        "go with option A",
      ]),
    ).toBe(0);
    expect(out.join("")).toMatch(/resolved id=esc-design-1/);

    expect(main(["list", "--project-root", root, "--open"])).toBe(0);
    // open list after resolves should be empty-ish
    expect(out.join("")).toMatch(/No open escalations|Escalations/);
  });

  it("list --format json", () => {
    const root = tempRoot();
    const out: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((c) => {
      out.push(String(c));
      return true;
    });
    main(["file", "--project-root", root, "--type", "question", "--title", "async"]);
    out.length = 0;
    expect(main(["list", "--project-root", root, "--format", "json"])).toBe(0);
    const parsed = JSON.parse(out.join("")) as unknown[];
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed.length).toBe(1);
  });

  it("rejects unknown type on file", () => {
    const root = tempRoot();
    const err: string[] = [];
    vi.spyOn(process.stderr, "write").mockImplementation((c) => {
      err.push(String(c));
      return true;
    });
    expect(main(["file", "--project-root", root, "--type", "blocked", "--title", "x"])).toBe(1);
    expect(err.join("")).toMatch(/invalid escalation type/);
  });
});
