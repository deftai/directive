/**
 * Unit tests for readRegularFileNoFollow: read-only, no-follow, regular-file-only
 * read through one fd, closed in finally.
 */
import {
  closeSync,
  constants,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readRegularFileNoFollow } from "./contained-write.js";

// Pass-through spies: every call reaches the real fs, so the spies only count
// and record fds. One test makes readFileSync throw once to force the error path.
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    closeSync: vi.fn(actual.closeSync),
    openSync: vi.fn(actual.openSync),
    readFileSync: vi.fn(actual.readFileSync),
  };
});
const realFs = await vi.importActual<typeof import("node:fs")>("node:fs");

const hasNoFollow = typeof (constants as { O_NOFOLLOW?: number }).O_NOFOLLOW === "number";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "read-no-follow-"));
  vi.mocked(closeSync).mockClear();
  vi.mocked(openSync).mockClear();
  vi.mocked(readFileSync).mockClear();
});
afterEach(() => {
  vi.mocked(readFileSync).mockImplementation(realFs.readFileSync);
  rmSync(dir, { recursive: true, force: true });
});

function openedFds(): number[] {
  return vi
    .mocked(openSync)
    .mock.results.flatMap((r) => (r.type === "return" ? [r.value as number] : []));
}

describe("readRegularFileNoFollow", () => {
  it("reads a regular file as utf8 and closes its fd", () => {
    const p = join(dir, "report.json");
    writeFileSync(p, '{"ok":true}\n');
    expect(readRegularFileNoFollow(p)).toBe('{"ok":true}\n');
    const fds = openedFds();
    expect(fds).toHaveLength(1);
    expect(vi.mocked(closeSync).mock.calls).toEqual([[fds[0]]]);
  });

  it("opens read-only, with O_NOFOLLOW where the platform has it", () => {
    const p = join(dir, "report.json");
    writeFileSync(p, "x");
    readRegularFileNoFollow(p);
    const flags = vi.mocked(openSync).mock.calls[0]?.[1] as number;
    expect(flags & (constants.O_WRONLY | constants.O_RDWR)).toBe(0);
    if (hasNoFollow) {
      expect(flags & (constants as { O_NOFOLLOW: number }).O_NOFOLLOW).not.toBe(0);
    }
  });

  it.skipIf(!hasNoFollow)("refuses a symlinked final component", () => {
    const target = join(dir, "real.json");
    writeFileSync(target, "secret");
    const link = join(dir, "link.json");
    symlinkSync(target, link);
    expect(readRegularFileNoFollow(link)).toBeNull();
    expect(openedFds()).toHaveLength(0);
  });

  it.skipIf(!hasNoFollow)("refuses a symlinked final component that points at a directory", () => {
    const sub = join(dir, "sub");
    mkdirSync(sub);
    const link = join(dir, "link");
    symlinkSync(sub, link);
    expect(readRegularFileNoFollow(link)).toBeNull();
  });

  it("covers the final component only: a symlinked parent directory is followed", () => {
    const real = join(dir, "real");
    mkdirSync(real);
    writeFileSync(join(real, "report.json"), "via-parent");
    const linkDir = join(dir, "linkdir");
    symlinkSync(real, linkDir, "dir");
    expect(readRegularFileNoFollow(join(linkDir, "report.json"))).toBe("via-parent");
  });

  it("refuses a non-regular file (a directory) and closes the fd it opened", () => {
    const sub = join(dir, "coverage-final.json");
    mkdirSync(sub);
    expect(readRegularFileNoFollow(sub)).toBeNull();
    const fds = openedFds();
    if (fds.length === 1) {
      expect(vi.mocked(closeSync).mock.calls).toEqual([[fds[0]]]);
    } else {
      // Platforms that refuse to open a directory read-only never get an fd.
      expect(vi.mocked(closeSync)).not.toHaveBeenCalled();
    }
    expect(vi.mocked(readFileSync)).not.toHaveBeenCalled();
  });

  it("closes the fd when the read throws", () => {
    const p = join(dir, "report.json");
    writeFileSync(p, "x");
    vi.mocked(readFileSync).mockImplementationOnce(() => {
      const err = new Error("EIO: i/o error") as NodeJS.ErrnoException;
      err.code = "EIO";
      throw err;
    });
    expect(readRegularFileNoFollow(p)).toBeNull();
    const fds = openedFds();
    expect(fds).toHaveLength(1);
    expect(vi.mocked(closeSync).mock.calls).toEqual([[fds[0]]]);
  });

  it("returns null for a missing path without closing anything", () => {
    expect(readRegularFileNoFollow(join(dir, "missing.json"))).toBeNull();
    expect(vi.mocked(closeSync)).not.toHaveBeenCalled();
  });
});
