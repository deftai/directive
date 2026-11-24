import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { run as enroll } from "./approvers-enroll.js";
import { run as remove } from "./approvers-remove.js";
import { taskKeyToDispatchArgv } from "./cli-router/route-argv.js";

const temps: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function root(): string {
  const dir = mkdtempSync(join(tmpdir(), "approvers-cli-"));
  temps.push(dir);
  return dir;
}

describe("approvers:enroll and approvers:remove (#6945)", () => {
  it("routes both verbs", () => {
    expect(taskKeyToDispatchArgv("approvers:enroll", ["--name", "scott"])).toEqual([
      "approvers:enroll",
      "--name",
      "scott",
    ]);
    expect(taskKeyToDispatchArgv("approvers:remove", ["--credential", "abc"])).toEqual([
      "approvers:remove",
      "--credential",
      "abc",
    ]);
  });

  it("--request equivalent writes nothing and prints the link", () => {
    const dir = root();
    const lines: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
      lines.push(String(chunk));
      return true;
    });
    expect(
      enroll(
        ["--name", "scott", "--origin", "https://approve.example.com", "--project-root", dir],
        { repo: "deftai/directive" },
      ),
    ).toBe(0);
    expect(existsSync(join(dir, ".deft", "approvers.json"))).toBe(false);
    expect(lines.join("")).toMatch(/link: https:\/\/approve.example.com\/ceremony.html#/);
    expect(lines.join("")).toMatch(/qr: /);
    expect(lines.join("")).toMatch(/user-verified gesture/);
    expect(lines.join("")).toMatch(/credentials the agent does not hold/);
  });

  it("refuses a blob that is not a trust file and still writes nothing", () => {
    const dir = root();
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    expect(
      enroll(
        [
          "--name",
          "scott",
          "--origin",
          "https://approve.example.com",
          "--assertion",
          "{}",
          "--project-root",
          dir,
        ],
        { repo: "deftai/directive" },
      ),
    ).toBe(1);
    expect(existsSync(join(dir, ".deft", "approvers.json"))).toBe(false);
  });

  it("remove with no trust file writes nothing", () => {
    const dir = root();
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    expect(
      remove(["--credential", "Y3JlZA", "--project-root", dir], { repo: "deftai/directive" }),
    ).toBe(2);
    expect(existsSync(join(dir, ".deft", "approvers.json"))).toBe(false);
  });
});
