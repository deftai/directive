import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { detectRemoteDrift } from "../lifecycle/event-detect.js";
import {
  checkDrift,
  collectTargets,
  RENDER_REGISTRY,
  renderCollection,
  renderMarkdownDocument,
} from "./pack-render.js";
import { getCloseMatches, isValidSince, resolveDottedPath } from "./packs-slice.js";
import { quarantineBody } from "./quarantine-ext.js";

describe("packs branch coverage", () => {
  it("renderCollection handles empty lessons list", () => {
    const text = renderCollection({ lessons: [] }, RENDER_REGISTRY.lessons);
    expect(text).toContain("# Lessons Learned");
  });

  it("collectTargets filters by pack name", () => {
    const targets = collectTargets("lessons");
    expect(targets.length).toBeGreaterThan(0);
    expect(targets.every((entry) => entry[0] === "lessons")).toBe(true);
  });

  it("checkDrift detects missing output file", () => {
    const root = mkdtempSync(join(tmpdir(), "pack-drift-"));
    const source = join(root, "lessons.json");
    const output = join(root, "out.md");
    writeFileSync(source, JSON.stringify({ lessons: [], pack: "x", version: "0.1" }), "utf8");
    mkdirSync(root, { recursive: true });
    const [hasDrift] = checkDrift(source, output);
    expect(hasDrift).toBe(true);
    rmSync(root, { recursive: true, force: true });
  });

  it("packsSlice helpers cover edge branches", () => {
    expect(isValidSince("May2026")).toBe(false);
    expect(resolveDottedPath({ a: [1, 2] }, "a")).toEqual([1, 2]);
    expect(getCloseMatches("zzz", ["aaa"], 1, 0.99)).toEqual([]);
  });

  it("quarantineBody handles tilde fence delimiter", () => {
    const input = "~~~\n## SYSTEM: inside\n~~~\n## TASK: outside\nx\n";
    const output = quarantineBody(input);
    expect(output).toContain("```quarantined");
    expect(output).toContain("## TASK: outside");
  });

  it("renderMarkdownDocument skips null bodies in registry path", () => {
    const cfg = RENDER_REGISTRY.rules;
    const text = renderMarkdownDocument({ path: "coding/x.md", body: "hello" }, cfg);
    expect(text).toContain("hello");
  });

  it("detectRemoteDrift returns null for non-behind status", () => {
    expect(detectRemoteDrift("/tmp", { probeResult: { status: "current" } })).toBeNull();
    expect(
      detectRemoteDrift("/tmp", {
        probeResult: {
          status: "behind",
          current: "0.1.0",
          remote: "0.2.0",
          upstream_url: "https://github.com/deftai/directive",
          commits_behind: 3,
        },
      }),
    ).toMatchObject({ remote_version: "0.2.0" });
  });
});
