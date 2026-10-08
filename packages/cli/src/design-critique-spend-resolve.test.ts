import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  EXIT_SPEND_RESOLVE_CONFIG,
  EXIT_SPEND_RESOLVE_OK,
  EXIT_SPEND_RESOLVE_REFUSED,
  parseDesignCritiqueSpendResolveArgs,
  run,
} from "./design-critique-spend-resolve.js";

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
      emitJson: false,
      help: false,
    });
  });

  it("refuses bare arc without --recommend and never defaults N=1", () => {
    const root = tempRoot();
    const code = run(["--utterance", "arc no-ingest yolo 5466", "--project-root", root]);
    expect(code).toBe(EXIT_SPEND_RESOLVE_REFUSED);
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
    expect(code).toBe(EXIT_SPEND_RESOLVE_OK);
  });

  it("config-fails without --utterance", () => {
    expect(run(["--recommend", "N=1"])).toBe(EXIT_SPEND_RESOLVE_CONFIG);
  });
});
