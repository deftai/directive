import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { activate } from "./activate.js";
import { formatEligibleStatusList } from "./constants.js";
import { parseArgs, run } from "./main.js";

describe("vbrief-activate coverage boost", () => {
  const roots: string[] = [];

  afterEach(() => {
    vi.restoreAllMocks();
    for (const root of roots.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  function tempRoot(): string {
    const root = mkdtempSync(join(tmpdir(), "deft-activate-boost-"));
    roots.push(root);
    return root;
  }

  it("rejects a directory path", () => {
    const root = tempRoot();
    const dirPath = join(root, "vbrief", "pending", "dir.vbrief.json");
    mkdirSync(dirPath, { recursive: true });
    const result = activate(dirPath);
    expect(result.exitCode).toBe(1);
    expect(result.message).toContain("not a regular file");
  });

  it("maps extra-data json errors", () => {
    const root = tempRoot();
    const path = join(root, "vbrief", "pending", "x.vbrief.json");
    mkdirSync(join(root, "vbrief", "pending"), { recursive: true });
    writeFileSync(path, '{"plan":{"status":"pending"}}{}', "utf8");
    const result = activate(path);
    expect(result.exitCode).toBe(1);
    expect(result.message).toContain("Extra data");
  });

  it("maps property-name json errors", () => {
    const root = tempRoot();
    const path = join(root, "vbrief", "pending", "x.vbrief.json");
    mkdirSync(join(root, "vbrief", "pending"), { recursive: true });
    writeFileSync(path, "{bad", "utf8");
    const result = activate(path);
    expect(result.exitCode).toBe(1);
    expect(result.message).toMatch(/Expecting property name|Expecting value/);
  });

  it("reports write failures", () => {
    const root = tempRoot();
    const path = join(root, "vbrief", "pending", "x.vbrief.json");
    const pendingDir = join(root, "vbrief", "pending");
    mkdirSync(pendingDir, { recursive: true });
    writeFileSync(
      path,
      JSON.stringify({
        vBRIEFInfo: { version: "0.6" },
        plan: { title: "T", status: "pending", items: [] },
      }),
      "utf8",
    );
    const activeDir = join(root, "vbrief", "active");
    mkdirSync(activeDir, { recursive: true });
    chmodSync(activeDir, 0o555);

    const result = activate(path);
    expect(result.exitCode).toBe(1);
    expect(result.message).toContain("Could not write");
    chmodSync(activeDir, 0o755);
  });

  it("reports unlink failures after successful write", () => {
    const root = tempRoot();
    const path = join(root, "vbrief", "pending", "x.vbrief.json");
    const pendingDir = join(root, "vbrief", "pending");
    mkdirSync(pendingDir, { recursive: true });
    writeFileSync(
      path,
      JSON.stringify({
        vBRIEFInfo: { version: "0.6" },
        plan: { title: "T", status: "pending", items: [] },
      }),
      "utf8",
    );
    chmodSync(pendingDir, 0o555);

    const result = activate(path, { now: new Date("2026-06-19T12:00:00.000Z") });
    expect(result.exitCode).toBe(1);
    expect(result.message).toContain("could not remove source");
    chmodSync(pendingDir, 0o755);
  });

  it("run writes success to stdout", () => {
    const root = tempRoot();
    const path = join(root, "vbrief", "pending", "x.vbrief.json");
    mkdirSync(join(root, "vbrief", "pending"), { recursive: true });
    writeFileSync(
      path,
      JSON.stringify({
        vBRIEFInfo: { version: "0.6" },
        plan: { title: "T", status: "pending", items: [] },
      }),
      "utf8",
    );
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const code = run([path], { now: new Date("2026-06-19T12:00:00.000Z") });
    expect(code).toBe(0);
    expect(stdout.mock.calls[0]?.[0]).toContain("Activated");
    stdout.mockRestore();
  });

  it("run writes reject to stderr", () => {
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const code = run(["/does/not/exist.vbrief.json"]);
    expect(code).toBe(1);
    stderr.mockRestore();
  });

  it("reports read errors from loadVbrief", () => {
    const root = tempRoot();
    const path = join(root, "vbrief", "pending", "x.vbrief.json");
    mkdirSync(join(root, "vbrief", "pending"), { recursive: true });
    writeFileSync(
      path,
      JSON.stringify({
        vBRIEFInfo: { version: "0.6" },
        plan: { title: "T", status: "pending", items: [] },
      }),
      "utf8",
    );
    chmodSync(path, 0o000);
    const result = activate(path);
    chmodSync(path, 0o644);
    expect(result.exitCode).toBe(1);
    expect(result.message).toContain("Could not read vBRIEF");
  });

  it("reports mkdir failures for active directory", () => {
    const root = tempRoot();
    const path = join(root, "vbrief", "pending", "x.vbrief.json");
    mkdirSync(join(root, "vbrief", "pending"), { recursive: true });
    writeFileSync(
      path,
      JSON.stringify({
        vBRIEFInfo: { version: "0.6" },
        plan: { title: "T", status: "pending", items: [] },
      }),
      "utf8",
    );
    chmodSync(join(root, "vbrief"), 0o555);
    const result = activate(path, { now: new Date("2026-06-19T12:00:00.000Z") });
    chmodSync(join(root, "vbrief"), 0o755);
    expect(result.exitCode).toBe(1);
    expect(result.message).toContain("Could not create");
  });

  it("reports empty plan.status as malformed", () => {
    const root = tempRoot();
    const path = join(root, "vbrief", "pending", "x.vbrief.json");
    mkdirSync(join(root, "vbrief", "pending"), { recursive: true });
    writeFileSync(
      path,
      JSON.stringify({
        vBRIEFInfo: { version: "0.6" },
        plan: { title: "T", status: "", items: [] },
      }),
      "utf8",
    );
    const result = activate(path);
    expect(result.exitCode).toBe(1);
    expect(result.message).toContain("lacks `plan.status`");
  });

  it("parseArgs returns the positional path", () => {
    expect(parseArgs(["/tmp/a.vbrief.json"]).vbriefPath).toBe("/tmp/a.vbrief.json");
  });

  it("formatEligibleStatusList matches Python repr", () => {
    expect(formatEligibleStatusList()).toBe("['approved', 'pending']");
  });

  it("serializes output with trailing newline parity", () => {
    const root = tempRoot();
    const path = join(root, "vbrief", "pending", "x.vbrief.json");
    mkdirSync(join(root, "vbrief", "pending"), { recursive: true });
    writeFileSync(
      path,
      `${JSON.stringify(
        {
          vBRIEFInfo: { version: "0.6", updated: "2026-04-30T00:00:00Z" },
          plan: { title: "T", status: "pending", items: [] },
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    activate(path, { now: new Date("2026-06-19T12:00:00.000Z") });
    const dest = join(root, "vbrief", "active", "x.vbrief.json");
    const body = readFileSync(dest, "utf8");
    expect(body.endsWith("\n")).toBe(true);
    expect(body.includes("\r\n")).toBe(false);
  });
});
