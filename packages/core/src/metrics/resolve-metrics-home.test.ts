import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  DEFT_EVAL_HOME_ENV,
  DEFT_METRICS_HOME_ENV,
  DEFT_METRICS_PROJECT_LOCAL_ENV,
  HEALTH_METRICS_FILENAME,
  HELPED_METRICS_FILENAME,
  healthMetricsHistoryPath,
  helpedMetricsHistoryPath,
  METRICS_DISABLED_DIAGNOSTIC,
  platformMetricsDir,
  resolveMetricsHome,
} from "./resolve-metrics-home.js";

const temps: string[] = [];
afterEach(() => {
  for (const dir of temps.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "deft-metrics-home-"));
  temps.push(root);
  return root;
}

describe("platformMetricsDir", () => {
  it("uses APPDATA/deft/metrics on win32 when APPDATA is set", () => {
    expect(
      platformMetricsDir("win32", { APPDATA: "C:\\Users\\t\\AppData\\Roaming" }, "C:\\Users\\t"),
    ).toBe(join("C:\\Users\\t\\AppData\\Roaming", "deft", "metrics"));
  });

  it("uses ~/.config/deft/metrics elsewhere", () => {
    expect(platformMetricsDir("linux", {}, "/home/t")).toBe(
      join("/home/t", ".config", "deft", "metrics"),
    );
  });
});

describe("resolveMetricsHome", () => {
  it("honors DEFT_METRICS_HOME override for both streams", () => {
    const override = join(tempRoot(), "ci-metrics");
    const projectRoot = tempRoot();
    const home = resolveMetricsHome({
      projectRoot,
      env: { [DEFT_METRICS_HOME_ENV]: override },
    });
    expect(home.enabled).toBe(true);
    expect(home.rung).toBe("env-override");
    expect(home.root).toBe(override);

    const helped = helpedMetricsHistoryPath(projectRoot, {
      env: { [DEFT_METRICS_HOME_ENV]: override },
    });
    const health = healthMetricsHistoryPath(projectRoot, {
      env: { [DEFT_METRICS_HOME_ENV]: override },
    });
    expect(helped).toBe(join(override, "helped", HELPED_METRICS_FILENAME));
    expect(health).toBe(join(override, "health", HEALTH_METRICS_FILENAME));
  });

  it("accepts DEFT_EVAL_HOME as a legacy alias", () => {
    const override = join(tempRoot(), "eval-home");
    const home = resolveMetricsHome({
      env: { [DEFT_EVAL_HOME_ENV]: override },
    });
    expect(home.enabled).toBe(true);
    expect(home.rung).toBe("env-override");
    expect(home.root).toBe(override);
  });

  it("prefers DEFT_METRICS_HOME over DEFT_EVAL_HOME", () => {
    const primary = join(tempRoot(), "primary");
    const legacy = join(tempRoot(), "legacy");
    const home = resolveMetricsHome({
      env: {
        [DEFT_METRICS_HOME_ENV]: primary,
        [DEFT_EVAL_HOME_ENV]: legacy,
      },
    });
    expect(home.root).toBe(primary);
  });

  it("uses workspace-local metrics when DEFT_METRICS_PROJECT_LOCAL=1", () => {
    const projectRoot = tempRoot();
    const home = resolveMetricsHome({
      projectRoot,
      env: { [DEFT_METRICS_PROJECT_LOCAL_ENV]: "1" },
    });
    expect(home.enabled).toBe(true);
    expect(home.rung).toBe("project-local");
    expect(home.root).toBe(join(projectRoot, ".deft", "metrics"));
  });

  it("soft-disables when the resolved root is not writable", () => {
    const home = resolveMetricsHome({
      probeWritable: () => false,
    });
    expect(home.enabled).toBe(false);
    expect(home.rung).toBe("disabled");
    expect(home.root).toBeNull();
    expect(home.diagnostic).toContain(METRICS_DISABLED_DIAGNOSTIC);
  });

  it("does not create files under xbrief/.eval/results for a worktree-style root", () => {
    const projectRoot = tempRoot();
    mkdirSync(join(projectRoot, "xbrief"), { recursive: true });
    const override = join(tempRoot(), "headless-metrics");
    const env = { [DEFT_METRICS_HOME_ENV]: override };

    const helped = helpedMetricsHistoryPath(projectRoot, { env });
    const health = healthMetricsHistoryPath(projectRoot, { env });
    expect(helped).not.toBeNull();
    expect(health).not.toBeNull();

    const helpedPath = helped;
    const healthPath = health;
    if (helpedPath === null || healthPath === null) {
      throw new Error("expected resolved metrics paths");
    }

    mkdirSync(join(helpedPath, ".."), { recursive: true });
    mkdirSync(join(healthPath, ".."), { recursive: true });
    writeFileSync(helpedPath, '{"operation":"create"}\n', "utf8");
    writeFileSync(healthPath, '{"score":100}\n', "utf8");

    expect(
      existsSync(join(projectRoot, "xbrief", ".eval", "results", HELPED_METRICS_FILENAME)),
    ).toBe(false);
    expect(
      existsSync(join(projectRoot, "xbrief", ".eval", "results", HEALTH_METRICS_FILENAME)),
    ).toBe(false);
    expect(readFileSync(helpedPath, "utf8")).toContain("create");
    expect(readFileSync(healthPath, "utf8")).toContain("score");
  });
});
