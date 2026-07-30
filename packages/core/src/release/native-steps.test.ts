import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockRenderRoadmap = vi.fn();
const mockScanLifecycleAnchors = vi.fn();
const mockBuildLifecycleReport = vi.fn();
const mockIsTerminalLifecyclePath = vi.fn();

vi.mock("../render/roadmap-render.js", () => ({
  renderRoadmap: (...args: unknown[]) => mockRenderRoadmap(...args),
}));

vi.mock("../intake/reconcile-issues.js", () => ({
  scanLifecycleAnchors: (...args: unknown[]) => mockScanLifecycleAnchors(...args),
  buildLifecycleReport: (...args: unknown[]) => mockBuildLifecycleReport(...args),
  isTerminalLifecyclePath: (...args: unknown[]) => mockIsTerminalLifecyclePath(...args),
}));

const mockFetchIssueStatesForRelease = vi.fn();

vi.mock("./issue-state-fetch.js", () => ({
  fetchIssueStatesForRelease: (...args: unknown[]) => mockFetchIssueStatesForRelease(...args),
}));

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, spawnSync: vi.fn() };
});

import {
  checkVbriefLifecycleSyncNative,
  refreshRoadmapNative,
  runBuildNative,
} from "./native-steps.js";

describe("native release steps", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("refreshRoadmapNative succeeds", () => {
    mockRenderRoadmap.mockReturnValue([true, ""]);
    const [ok, msg] = refreshRoadmapNative("/proj");
    expect(ok).toBe(true);
    expect(msg).toContain("re-rendered");
  });

  it("refreshRoadmapNative fails when render returns false", () => {
    mockRenderRoadmap.mockReturnValue([false, "boom"]);
    const [ok, msg] = refreshRoadmapNative("/proj");
    expect(ok).toBe(false);
    expect(msg).toContain("roadmap:render failed");
  });

  it("checkVbriefLifecycleSyncNative reports no mismatches", () => {
    mockScanLifecycleAnchors.mockReturnValue([]);
    mockFetchIssueStatesForRelease.mockReturnValue({ ok: true, states: new Map() });
    mockBuildLifecycleReport.mockReturnValue({ no_open_issue: [] });
    const [ok, count, msg] = checkVbriefLifecycleSyncNative("/proj", "deftai/directive");
    expect(ok).toBe(true);
    expect(count).toBe(0);
    expect(msg).toBe("no mismatches");
  });

  it("checkVbriefLifecycleSyncNative ignores closed secondary refs when parent anchor is open", () => {
    mockScanLifecycleAnchors.mockReturnValue([
      {
        rel_path: "active/story.xbrief.json",
        issue_number: 2745,
        axis: "parent_issue",
      },
    ]);
    mockFetchIssueStatesForRelease.mockReturnValue({
      ok: true,
      states: new Map([
        [2745, "OPEN"],
        [1234, "CLOSED"],
      ]),
    });
    mockBuildLifecycleReport.mockReturnValue({ no_open_issue: [] });
    const [ok, count, msg] = checkVbriefLifecycleSyncNative("/proj", "deftai/directive");
    expect(mockFetchIssueStatesForRelease).toHaveBeenCalledWith(
      "deftai/directive",
      new Set([2745]),
      { cwd: "/proj" },
    );
    expect(ok).toBe(true);
    expect(count).toBe(0);
    expect(msg).toBe("no mismatches");
  });

  it("checkVbriefLifecycleSyncNative skips for legacy-only vbrief/ project", () => {
    const legacyRoot =
      (mkdirSync(join(tmpdir(), `deft-native-legacy-${Date.now()}`), {
        recursive: true,
      }) as string) ?? join(tmpdir(), `deft-native-legacy-${Date.now()}`);
    // Create a vbrief/-only layout (no xbrief/) — should trigger the catch-block early return
    mkdirSync(join(legacyRoot, "vbrief"), { recursive: true });
    const [ok, count, msg] = checkVbriefLifecycleSyncNative(legacyRoot, "deftai/directive");
    expect(ok).toBe(false);
    expect(count).toBe(0);
    expect(msg).toContain("no xbrief/ layout found");
  });

  it("checkVbriefLifecycleSyncNative fails when gh fetch returns null", () => {
    mockScanLifecycleAnchors.mockReturnValue([
      { rel_path: "active/a.xbrief.json", issue_number: 1, axis: "parent_issue" },
    ]);
    mockFetchIssueStatesForRelease.mockReturnValue({
      ok: false,
      reason: "failed to fetch issue states from gh",
    });
    const [ok, count, msg] = checkVbriefLifecycleSyncNative("/proj", "deftai/directive");
    expect(ok).toBe(false);
    expect(count).toBe(-1);
    expect(msg).toContain("failed to fetch issue states");
  });

  it("checkVbriefLifecycleSyncNative surfaces rate-limit failure reason", () => {
    mockScanLifecycleAnchors.mockReturnValue([
      { rel_path: "active/a.xbrief.json", issue_number: 1, axis: "parent_issue" },
    ]);
    mockFetchIssueStatesForRelease.mockReturnValue({
      ok: false,
      reason: "GitHub REST rate limit exhausted (see stderr for recovery steps)",
    });
    const [ok, count, msg] = checkVbriefLifecycleSyncNative("/proj", "deftai/directive");
    expect(ok).toBe(false);
    expect(count).toBe(-1);
    expect(msg).toContain("rate limit exhausted");
  });

  it("checkVbriefLifecycleSyncNative reports lifecycle mismatches", () => {
    mockScanLifecycleAnchors.mockReturnValue([]);
    mockFetchIssueStatesForRelease.mockReturnValue({ ok: true, states: new Map() });
    mockBuildLifecycleReport.mockReturnValue({
      no_open_issue: [{ vbrief_files: ["active/a.xbrief.json"] }],
    });
    mockIsTerminalLifecyclePath.mockReturnValue(false);
    const [ok, count, msg] = checkVbriefLifecycleSyncNative("/proj", "deftai/directive");
    expect(ok).toBe(false);
    expect(count).toBe(1);
    expect(msg).toContain("closed-issue vBRIEF");
  });

  it("checkVbriefLifecycleSyncNative truncates mismatch preview beyond five", () => {
    const files = Array.from({ length: 6 }, (_, i) => `active/story-${i}.xbrief.json`);
    mockScanLifecycleAnchors.mockReturnValue([]);
    mockFetchIssueStatesForRelease.mockReturnValue({ ok: true, states: new Map() });
    mockBuildLifecycleReport.mockReturnValue({ no_open_issue: [{ vbrief_files: files }] });
    mockIsTerminalLifecyclePath.mockReturnValue(false);
    const [ok, count, msg] = checkVbriefLifecycleSyncNative("/proj", "deftai/directive");
    expect(ok).toBe(false);
    expect(count).toBe(6);
    expect(msg).toContain("...");
  });

  it("checkVbriefLifecycleSyncNative catches scan errors", () => {
    mockScanLifecycleAnchors.mockImplementation(() => {
      throw new Error("scan boom");
    });
    const [ok, count, msg] = checkVbriefLifecycleSyncNative("/proj", "deftai/directive");
    expect(ok).toBe(false);
    expect(count).toBe(-1);
    expect(msg).toContain("scan boom");
  });

  it("checkVbriefLifecycleSyncNative catches non-Error throws", () => {
    // Exercises the String(err) branch in catch (err instanceof Error = false)
    mockScanLifecycleAnchors.mockImplementation(() => {
      throw "string-error-value";
    });
    const [ok, count, msg] = checkVbriefLifecycleSyncNative("/proj", "deftai/directive");
    expect(ok).toBe(false);
    expect(count).toBe(-1);
    expect(msg).toBe("string-error-value");
  });

  it("checkVbriefLifecycleSyncNative handles entry without vbrief_files", () => {
    // Entry with undefined vbrief_files — exercises the `?? []` branch
    mockScanLifecycleAnchors.mockReturnValue([]);
    mockFetchIssueStatesForRelease.mockReturnValue({ ok: true, states: new Map() });
    mockBuildLifecycleReport.mockReturnValue({ no_open_issue: [{}] });
    const [ok, count] = checkVbriefLifecycleSyncNative("/proj", "deftai/directive");
    expect(ok).toBe(true);
    expect(count).toBe(0);
  });

  it("runBuildNative requires version", () => {
    const [ok, msg] = runBuildNative("/tmp", null);
    expect(ok).toBe(false);
    expect(msg).toContain("requires a release version");
  });

  it("runBuildNative uses stdout when stderr is empty", () => {
    // Covers stderr=="" fallthrough to stdout branch and status fallback
    vi.mocked(spawnSync).mockReturnValue({
      status: null,
      stdout: "stdout error line",
      stderr: "",
      pid: 1,
      output: [null, "stdout error line", ""],
      signal: null,
      error: undefined,
    });
    const [ok, msg] = runBuildNative("/proj", "1.2.3");
    expect(ok).toBe(false);
    expect(msg).toContain("build failed");
  });

  it("runBuildNative fails when runner exits nonzero", () => {
    vi.mocked(spawnSync).mockReturnValue({
      status: 1,
      stdout: "",
      stderr: "build blew up",
      pid: 1,
      output: [null, "", "build blew up"],
      signal: null,
      error: undefined,
    });
    const [ok, msg] = runBuildNative("/proj", "1.2.3");
    expect(ok).toBe(false);
    expect(msg).toContain("build failed");
  });

  it("runBuildNative succeeds when runner exits zero", () => {
    vi.mocked(spawnSync).mockReturnValue({
      status: 0,
      stdout: "/proj/dist/deft-1.2.3.zip\n",
      stderr: "",
      pid: 1,
      output: [null, "/proj/dist/deft-1.2.3.zip\n", ""],
      signal: null,
      error: undefined,
    });
    const [ok, msg] = runBuildNative("/proj", "1.2.3");
    expect(ok).toBe(true);
    expect(msg).toContain("DEFT_RELEASE_VERSION=1.2.3");
  });

  it("runBuildNative inherits stderr so progress ticks stream live (#2953)", () => {
    vi.mocked(spawnSync).mockReturnValue({
      status: 0,
      stdout: "/proj/dist/deft-1.2.3.zip\n",
      stderr: null,
      pid: 1,
      output: [null, "/proj/dist/deft-1.2.3.zip\n", null],
      signal: null,
      error: undefined,
    } as ReturnType<typeof spawnSync>);
    const [ok] = runBuildNative("/proj", "1.2.3");
    expect(ok).toBe(true);
    expect(vi.mocked(spawnSync)).toHaveBeenCalledWith(
      process.execPath,
      expect.any(Array),
      expect.objectContaining({ stdio: ["ignore", "pipe", "inherit"] }),
    );
  });
});
