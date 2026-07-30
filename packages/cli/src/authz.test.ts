import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { main } from "./authz.js";

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
  const root = mkdtempSync(join(tmpdir(), "cli-authz-"));
  roots.push(root);
  return root;
}

describe("authz CLI (#2944)", () => {
  it("show on empty project", () => {
    const root = tempRoot();
    const out: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((c) => {
      out.push(String(c));
      return true;
    });
    expect(main(["show", "--project-root", root])).toBe(0);
    expect(out.join("")).toMatch(/UAT lease: inactive/);
  });

  it("uat-start requires campaign", () => {
    const root = tempRoot();
    const err: string[] = [];
    vi.spyOn(process.stderr, "write").mockImplementation((c) => {
      err.push(String(c));
      return true;
    });
    expect(main(["uat-start", "--project-root", root])).toBe(2);
    expect(err.join("")).toMatch(/campaign/);
  });

  it("uat-start / grant / show / revoke round-trip", () => {
    const root = tempRoot();
    const out: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((c) => {
      out.push(String(c));
      return true;
    });
    expect(
      main(["uat-start", "--project-root", root, "--campaign", "uat-1", "--actor", "op"]),
    ).toBe(0);
    expect(main(["show", "--project-root", root, "--format", "json"])).toBe(0);
    expect(out.join("")).toMatch(/ACTIVE|uat-1/);
    expect(
      main([
        "grant",
        "--project-root",
        root,
        "--operations",
        "edit,push",
        "--surfaces",
        "src/**",
        "--cohort",
        "fix-1",
      ]),
    ).toBe(0);
    const grantLine = out.find((l) => l.includes("grant minted"));
    expect(grantLine).toBeTruthy();
    expect(main(["show", "--project-root", root])).toBe(0);
    expect(main(["uat-suspend", "--project-root", root])).toBe(0);
  });

  it("grant without operations fails", () => {
    const root = tempRoot();
    const err: string[] = [];
    vi.spyOn(process.stderr, "write").mockImplementation((c) => {
      err.push(String(c));
      return true;
    });
    expect(main(["grant", "--project-root", root])).toBe(2);
    expect(err.join("")).toMatch(/operations/);
  });

  it("help and unknown subcommand", () => {
    expect(main(["--help"])).toBe(0);
    const err: string[] = [];
    vi.spyOn(process.stderr, "write").mockImplementation((c) => {
      err.push(String(c));
      return true;
    });
    expect(main(["nope"])).toBe(2);
  });

  it("revoke missing grant", () => {
    const root = tempRoot();
    const err: string[] = [];
    vi.spyOn(process.stderr, "write").mockImplementation((c) => {
      err.push(String(c));
      return true;
    });
    expect(main(["revoke", "--project-root", root, "grant-missing"])).toBe(1);
  });
});
