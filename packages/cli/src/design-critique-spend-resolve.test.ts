import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseDesignCritiqueSpendResolveArgs, run } from "./design-critique-spend-resolve.js";

const temps: string[] = [];
afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "cli-spend-resolve-"));
  temps.push(dir);
  return dir;
}

describe("design-critique:spend-resolve (#5466)", () => {
  it("parses required flags", () => {
    expect(
      parseDesignCritiqueSpendResolveArgs([
        "--utterance",
        "arc 5466",
        "--recommend",
        "N=1",
        "--project-root",
        "/tmp/x",
      ]),
    ).toEqual({
      utterance: "arc 5466",
      recommend: "N=1",
      projectRoot: "/tmp/x",
      sessionId: null,
      emitJson: false,
      help: false,
      openGate: false,
      clear: false,
      unclosableRecommend: false,
    });
  });

  it("skips a lone -- separator so documented forms work", () => {
    const parsed = parseDesignCritiqueSpendResolveArgs([
      "--",
      "--utterance",
      "arc 5466",
      "--recommend",
      "N=1",
    ]);
    expect(parsed.utterance).toBe("arc 5466");
    expect(parsed.recommend).toBe("N=1");
    expect(parsed.error).toBeUndefined();
  });

  it("refuses bare arc without --recommend and never defaults N=1", () => {
    const root = tempRoot();
    const code = run(["--utterance", "arc no-ingest yolo 5466", "--project-root", root]);
    expect(code).toBe(1);
  });

  it("resolves with --recommend N=1", () => {
    const root = tempRoot();
    const code = run([
      "--utterance",
      "arc no-ingest yolo 5466",
      "--recommend",
      "N=1",
      "--project-root",
      root,
    ]);
    expect(code).toBe(0);
  });

  it("opens and clears the arc spend gate", () => {
    const root = tempRoot();
    expect(run(["--open-gate", "--utterance", "arc 5466", "--project-root", root])).toBe(0);
    expect(run(["--clear", "--project-root", root])).toBe(0);
  });

  it("marks unclosable recommend as a lawful ask without inventing N", () => {
    const root = tempRoot();
    const code = run([
      "--utterance",
      "arc no-ingest yolo 5466",
      "--unclosable-recommend",
      "--project-root",
      root,
    ]);
    expect(code).toBe(1);
  });

  it("config-fails without --utterance", () => {
    expect(run(["--recommend", "N=1"])).toBe(2);
  });
});
