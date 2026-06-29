import { spawnSync } from "node:child_process";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockRenderRoadmap = vi.fn();
const mockScanVbriefDir = vi.fn();
const mockFetchIssueStates = vi.fn();
const mockReconcile = vi.fn();
const mockIsTerminalLifecyclePath = vi.fn();

vi.mock("../render/roadmap-render.js", () => ({
  renderRoadmap: (...args: unknown[]) => mockRenderRoadmap(...args),
}));

vi.mock("../intake/reconcile-issues.js", () => ({
  scanVbriefDir: (...args: unknown[]) => mockScanVbriefDir(...args),
  fetchIssueStates: (...args: unknown[]) => mockFetchIssueStates(...args),
  reconcile: (...args: unknown[]) => mockReconcile(...args),
  isTerminalLifecyclePath: (...args: unknown[]) => mockIsTerminalLifecyclePath(...args),
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
    mockScanVbriefDir.mockReturnValue(new Map());
    mockFetchIssueStates.mockReturnValue({});
    mockReconcile.mockReturnValue({ no_open_issue: [] });
    const [ok, count, msg] = checkVbriefLifecycleSyncNative("/proj", "deftai/directive");
    expect(ok).toBe(true);
    expect(count).toBe(0);
    expect(msg).toBe("no mismatches");
  });

  it("checkVbriefLifecycleSyncNative fails when gh fetch returns null", () => {
    mockScanVbriefDir.mockReturnValue(new Map([[1, []]]));
    mockFetchIssueStates.mockReturnValue(null);
    const [ok, count, msg] = checkVbriefLifecycleSyncNative("/proj", "deftai/directive");
    expect(ok).toBe(false);
    expect(count).toBe(-1);
    expect(msg).toContain("failed to fetch issue states");
  });

  it("checkVbriefLifecycleSyncNative reports lifecycle mismatches", () => {
    mockScanVbriefDir.mockReturnValue(new Map());
    mockFetchIssueStates.mockReturnValue({});
    mockReconcile.mockReturnValue({
      no_open_issue: [{ vbrief_files: ["vbrief/active/a.vbrief.json"] }],
    });
    mockIsTerminalLifecyclePath.mockReturnValue(false);
    const [ok, count, msg] = checkVbriefLifecycleSyncNative("/proj", "deftai/directive");
    expect(ok).toBe(false);
    expect(count).toBe(1);
    expect(msg).toContain("closed-issue vBRIEF");
  });

  it("checkVbriefLifecycleSyncNative truncates mismatch preview beyond five", () => {
    const files = Array.from({ length: 6 }, (_, i) => `vbrief/active/story-${i}.vbrief.json`);
    mockScanVbriefDir.mockReturnValue(new Map());
    mockFetchIssueStates.mockReturnValue({});
    mockReconcile.mockReturnValue({ no_open_issue: [{ vbrief_files: files }] });
    mockIsTerminalLifecyclePath.mockReturnValue(false);
    const [ok, count, msg] = checkVbriefLifecycleSyncNative("/proj", "deftai/directive");
    expect(ok).toBe(false);
    expect(count).toBe(6);
    expect(msg).toContain("...");
  });

  it("checkVbriefLifecycleSyncNative catches scan errors", () => {
    mockScanVbriefDir.mockImplementation(() => {
      throw new Error("scan boom");
    });
    const [ok, count, msg] = checkVbriefLifecycleSyncNative("/proj", "deftai/directive");
    expect(ok).toBe(false);
    expect(count).toBe(-1);
    expect(msg).toContain("scan boom");
  });

  it("runBuildNative requires version", () => {
    const [ok, msg] = runBuildNative("/tmp", null);
    expect(ok).toBe(false);
    expect(msg).toContain("requires a release version");
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
});
