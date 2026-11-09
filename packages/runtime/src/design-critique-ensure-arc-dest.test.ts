import { describe, expect, it } from "vitest";
import { parseDesignCritiqueEnsureArcDestArgs, run } from "./design-critique-ensure-arc-dest.js";

describe("design-critique:ensure-arc-dest (#6142)", () => {
  it("parses required dest-path and optional flags", () => {
    expect(
      parseDesignCritiqueEnsureArcDestArgs([
        "--dest-path",
        ".deft-scratch/worktrees/arc-6142",
        "--project-root",
        "/tmp/x",
        "--install-mode",
        "process-only-no-install",
        "--against-implementation",
        "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      ]),
    ).toEqual({
      destPath: ".deft-scratch/worktrees/arc-6142",
      projectRoot: "/tmp/x",
      againstImplementationSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      installMode: "process-only-no-install",
      emitJson: false,
      help: false,
    });
  });

  it("skips a lone -- separator", () => {
    const parsed = parseDesignCritiqueEnsureArcDestArgs([
      "--",
      "--dest-path",
      "arc-x",
      "--install-mode=guarded-prep",
    ]);
    expect(parsed.destPath).toBe("arc-x");
    expect(parsed.installMode).toBe("guarded-prep");
    expect(parsed.error).toBeUndefined();
  });

  it("config-fails without --dest-path", () => {
    expect(run(["--install-mode", "process-only-no-install"])).toBe(2);
  });

  it("config-fails on unknown install-mode", () => {
    expect(
      parseDesignCritiqueEnsureArcDestArgs([
        "--dest-path",
        "arc-x",
        "--install-mode",
        "skip-install",
      ]).error,
    ).toMatch(/install-mode/);
  });

  it("prints help", () => {
    expect(run(["--help"])).toBe(0);
  });
});
