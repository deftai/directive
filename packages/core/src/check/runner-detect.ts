import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { projectDefinitionPath } from "../policy/index.js";

export type TestRunnerKind = "vitest" | "jest" | "go" | "pytest" | "none";

export interface RunnerDetectResult {
  readonly kind: TestRunnerKind;
  readonly affectedArgs: readonly string[];
  readonly source: "config" | "heuristic" | "fallback";
  readonly message?: string;
}

export interface RunnerDetectOptions {
  readonly projectRoot: string;
  readonly override?: TestRunnerKind;
}

const RUNNER_AFFECTED: Readonly<Record<Exclude<TestRunnerKind, "none">, readonly string[]>> = {
  vitest: ["--changed"],
  jest: ["--onlyChanged"],
  go: [],
  pytest: ["--testmon"],
};

function affectedArgsFor(kind: TestRunnerKind): readonly string[] {
  if (kind === "none") {
    return [];
  }
  return RUNNER_AFFECTED[kind];
}

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

function detectFromPolicy(projectRoot: string): TestRunnerKind | null {
  try {
    const planPath = projectDefinitionPath(projectRoot);
    const plan = readJson(planPath) as { plan?: { policy?: { testRunner?: unknown } } } | null;
    const raw = plan?.plan?.policy?.testRunner;
    if (raw === "vitest" || raw === "jest" || raw === "go" || raw === "pytest" || raw === "none") {
      return raw;
    }
  } catch {
    return null;
  }
  return null;
}

function detectFromHeuristics(projectRoot: string): TestRunnerKind | null {
  const root = resolve(projectRoot);
  if (existsSync(join(root, "go.mod"))) {
    return "go";
  }
  const pkgPath = join(root, "package.json");
  if (existsSync(pkgPath)) {
    const pkg = readJson(pkgPath) as {
      devDependencies?: Record<string, string>;
      dependencies?: Record<string, string>;
    } | null;
    const deps = { ...(pkg?.dependencies ?? {}), ...(pkg?.devDependencies ?? {}) };
    if ("vitest" in deps) {
      return "vitest";
    }
    if ("jest" in deps || "@jest/core" in deps) {
      return "jest";
    }
  }
  if (
    existsSync(join(root, "pytest.ini")) ||
    existsSync(join(root, "pyproject.toml")) ||
    existsSync(join(root, "requirements.txt"))
  ) {
    return "pytest";
  }
  return null;
}

/** Auto-detect consumer test runner with explicit override (#1713). */
export function detectTestRunner(options: RunnerDetectOptions): RunnerDetectResult {
  if (options.override !== undefined) {
    if (options.override === "none") {
      return {
        kind: "none",
        affectedArgs: [],
        source: "config",
        message: "Runner override set to full-suite-only.",
      };
    }
    return {
      kind: options.override,
      affectedArgs: affectedArgsFor(options.override),
      source: "config",
    };
  }

  const fromPolicy = detectFromPolicy(options.projectRoot);
  if (fromPolicy !== null) {
    return {
      kind: fromPolicy,
      affectedArgs: affectedArgsFor(fromPolicy),
      source: "config",
    };
  }

  const fromHeuristics = detectFromHeuristics(options.projectRoot);
  if (fromHeuristics !== null) {
    return {
      kind: fromHeuristics,
      affectedArgs: affectedArgsFor(fromHeuristics),
      source: "heuristic",
    };
  }

  return {
    kind: "none",
    affectedArgs: [],
    source: "fallback",
    message: "No supported test runner detected — merge gate uses the full suite.",
  };
}

/** Human-readable detection table rows for docs. */
export function runnerDetectionTable(): ReadonlyArray<{
  runner: TestRunnerKind;
  detection: string;
  affectedConvention: string;
}> {
  return [
    {
      runner: "vitest",
      detection: "package.json lists vitest, or plan.policy.testRunner = vitest",
      affectedConvention: "vitest --changed",
    },
    {
      runner: "jest",
      detection: "package.json lists jest / @jest/core, or plan.policy.testRunner = jest",
      affectedConvention: "jest --onlyChanged",
    },
    {
      runner: "go",
      detection: "go.mod present, or plan.policy.testRunner = go",
      affectedConvention: "go test (native package cache)",
    },
    {
      runner: "pytest",
      detection:
        "pytest.ini / pyproject.toml / requirements.txt, or plan.policy.testRunner = pytest",
      affectedConvention: "pytest --testmon",
    },
    {
      runner: "none",
      detection: "No match after config + heuristics",
      affectedConvention: "Full suite at merge gate",
    },
  ];
}
