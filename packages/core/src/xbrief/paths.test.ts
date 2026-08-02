import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  expandUserPath,
  resolveXbriefOutPaths,
  stripXbriefSuffix,
  XbriefPathError,
} from "./paths.js";

const temps: string[] = [];
afterEach(() => {
  for (const t of temps.splice(0)) rmSync(t, { recursive: true, force: true });
});

describe("xbrief paths (#3057)", () => {
  it("strips xbrief suffixes", () => {
    expect(stripXbriefSuffix("a/b.xbrief.json")).toBe("a/b");
    expect(stripXbriefSuffix("a/b.xbrief.md")).toBe("a/b");
    expect(stripXbriefSuffix("a/b")).toBe("a/b");
  });

  it("expands home and env vars", () => {
    const home = join(tmpdir(), "xbrief-paths-home");
    expect(expandUserPath("~", { home })).toBe(home);
    expect(expandUserPath("%HOME%\\x", { home, env: { HOME: home } })).toBe(join(home, "x"));
  });

  it("resolves md-only paths under project root", () => {
    const root = mkdtempSync(join(tmpdir(), "xbrief-paths-"));
    temps.push(root);
    const paths = resolveXbriefOutPaths({
      projectRoot: root,
      out: "docs/note.xbrief.md",
      format: "md",
    });
    expect(paths.jsonAbs).toBeNull();
    expect(paths.mdAbs).toBe(join(root, "docs", "note.xbrief.md"));
  });

  it("throws XbriefPathError on empty expand", () => {
    expect(() => expandUserPath("")).toThrow(XbriefPathError);
  });
});
