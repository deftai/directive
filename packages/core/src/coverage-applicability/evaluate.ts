/**
 * Shared fail-closed coverage applicability evaluator (#5421 Prefer-A Bound).
 * Classifies the complete reviewed change set bound to PrePrInputBinding fields.
 */

import * as childProcess from "node:child_process";
import { COVERAGE_HEADROOM_NOT_APPLICABLE_SKIP } from "../pre-pr-controller/phases.js";

export type PathClassification = "coverable" | "inert" | "unknown";

export interface ClassifiedChange {
  readonly status: string;
  readonly path: string;
  readonly oldPath: string | null;
  readonly classification: PathClassification;
}

export type CoverageApplicabilityResult =
  | {
      readonly outcome: "not-applicable";
      readonly reason: typeof COVERAGE_HEADROOM_NOT_APPLICABLE_SKIP;
      readonly changes: readonly ClassifiedChange[];
    }
  | {
      readonly outcome: "applicable";
      readonly coverablePaths: readonly string[];
      readonly changes: readonly ClassifiedChange[];
    }
  | {
      readonly outcome: "refuse";
      readonly code: string;
      readonly reason: string;
      readonly changes: readonly ClassifiedChange[];
    };

export interface EvaluateCoverageApplicabilityInput {
  readonly projectRoot: string;
  readonly baseSha: string;
  readonly headSha: string;
  readonly treeHash: string;
  /** When false, skip HEAD-tree vs binding treeHash check (tests only). */
  readonly requireTreeMatch?: boolean;
}

export interface CoverageApplicabilityDeps {
  readonly runGit?: (args: readonly string[], cwd: string) => string;
  readonly classifyPath?: (
    path: string,
    status: string,
    oldPath: string | null,
  ) => PathClassification;
}

class GitCommandError extends Error {}

function defaultRunGit(args: readonly string[], cwd: string): string {
  try {
    return childProcess.execFileSync("git", [...args], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (err: unknown) {
    const e = err as NodeJS.ErrnoException & { stderr?: string | Buffer };
    const stderr = String(e.stderr ?? e.message ?? err).trim();
    throw new GitCommandError(`coverage-applicability: git ${args.join(" ")} failed: ${stderr}`);
  }
}

/** Closed executable / measurement-relevant extensions. */
const COVERABLE_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".py",
  ".pyi",
  ".cs",
  ".fs",
  ".vb",
  ".go",
  ".rs",
  ".java",
  ".kt",
  ".kts",
  ".swift",
  ".c",
  ".cc",
  ".cpp",
  ".cxx",
  ".h",
  ".hpp",
  ".hxx",
  ".rb",
  ".php",
  ".scala",
  ".clj",
  ".ex",
  ".exs",
  ".erl",
  ".hs",
  ".ml",
  ".mli",
  ".sh",
  ".bash",
  ".zsh",
  ".ps1",
  ".psm1",
  ".bat",
  ".cmd",
  ".sql",
  ".vue",
  ".svelte",
]);

/** Runtime / build / test / workflow config that changes executable behavior. */
const COVERABLE_BASENAMES = new Set([
  "package.json",
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "taskfile.yml",
  "taskfile.yaml",
  "dockerfile",
  "docker-compose.yml",
  "docker-compose.yaml",
  "makefile",
  "cmakelists.txt",
  "cargo.toml",
  "go.mod",
  "go.sum",
  "pyproject.toml",
  "requirements.txt",
  "setup.py",
  "setup.cfg",
  "gemfile",
  "gemfile.lock",
  "composer.json",
  "composer.lock",
  "build.gradle",
  "build.gradle.kts",
  "settings.gradle",
  "settings.gradle.kts",
  "pom.xml",
  "directory.build.props",
  "directory.packages.props",
]);

const COVERABLE_BASENAME_PREFIXES = [
  "vitest.config.",
  "jest.config.",
  "webpack.config.",
  "rollup.config.",
  "vite.config.",
  "esbuild.config.",
  "tsconfig",
  "jsconfig",
];

const INERT_EXTENSIONS = new Set([
  ".md",
  ".mdx",
  ".txt",
  ".rst",
  ".adoc",
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".svg",
  ".ico",
  ".pdf",
  ".css",
  ".scss",
  ".sass",
  ".less",
  ".html",
  ".htm",
]);

const INERT_BASENAMES = new Set([
  "changelog.md",
  "readme.md",
  "license",
  "license.md",
  "notice",
  "authors",
  "contributing.md",
  "code_of_conduct.md",
  "security.md",
]);

function extensionOf(path: string): string {
  const base = path.replace(/\\/g, "/").split("/").pop() ?? path;
  const dot = base.lastIndexOf(".");
  if (dot <= 0) return "";
  return base.slice(dot).toLowerCase();
}

function basenameOf(path: string): string {
  const base = path.replace(/\\/g, "/").split("/").pop() ?? path;
  return base.toLowerCase();
}

function posixPath(path: string): string {
  return path.replace(/\\/g, "/");
}

function isUnderPrefix(path: string, prefixes: readonly string[]): boolean {
  const p = posixPath(path).toLowerCase();
  return prefixes.some((prefix) => p === prefix || p.startsWith(`${prefix}/`));
}

/** Live project settings under xbrief/ — not planning prose; must stay applicable. */
const LIVE_SETTINGS_PATHS = new Set([
  "xbrief/project-definition.xbrief.json",
  "xbrief/plan.xbrief.json",
  "xbrief/specification.xbrief.json",
]);

function isLiveSettingsPath(path: string): boolean {
  return LIVE_SETTINGS_PATHS.has(posixPath(path).toLowerCase());
}

function isCoverableConfig(path: string): boolean {
  const base = basenameOf(path);
  if (COVERABLE_BASENAMES.has(base)) return true;
  if (COVERABLE_BASENAME_PREFIXES.some((prefix) => base.startsWith(prefix))) return true;
  const p = posixPath(path).toLowerCase();
  if (isLiveSettingsPath(p)) return true;
  if (p.includes(".github/workflows/") && (base.endsWith(".yml") || base.endsWith(".yaml"))) {
    return true;
  }
  if (base.endsWith(".csproj") || base.endsWith(".fsproj") || base.endsWith(".vbproj")) {
    return true;
  }
  if (base.endsWith(".sln") || base.endsWith(".props") || base.endsWith(".targets")) {
    return true;
  }
  return false;
}

/**
 * Closed classifier rules. Markdown/JSON/xbrief are inert only when these rules
 * positively match — never by blanket extension alone outside planning/docs paths.
 */
export function classifyChangedPath(
  path: string,
  _status: string,
  _oldPath: string | null,
): PathClassification {
  const p = posixPath(path);
  const base = basenameOf(p);
  const ext = extensionOf(p);

  if (isCoverableConfig(p)) return "coverable";
  if (COVERABLE_EXTENSIONS.has(ext)) {
    // Declaration files remain coverable (they are TypeScript surface).
    return "coverable";
  }

  if (INERT_BASENAMES.has(base)) return "inert";

  // Planning / design / decision artifacts under known roots.
  if (
    isUnderPrefix(p, [
      "xbrief",
      "vbrief",
      ".planning",
      "docs",
      "design",
      "content/docs",
      "content/meta",
    ])
  ) {
    if (
      INERT_EXTENSIONS.has(ext) ||
      ext === ".json" ||
      ext === ".yaml" ||
      ext === ".yml" ||
      ext === ".toml"
    ) {
      return "inert";
    }
  }

  // Root / docs-adjacent prose.
  if (INERT_EXTENSIONS.has(ext) && !p.includes("/src/") && !p.includes("/packages/")) {
    return "inert";
  }

  // Generated registry references that are documentation projections.
  if (
    (ext === ".json" || ext === ".md") &&
    (p.includes("/registry/") || p.endsWith(".registry.json") || p.includes("references/"))
  ) {
    return "inert";
  }

  // Istanbul / coverage tool output — measurement artifact, not product under review.
  if (
    isUnderPrefix(p, ["coverage", ".nyc_output"]) ||
    base === "coverage-final.json" ||
    base === "lcov.info" ||
    base === "clover.xml" ||
    base.endsWith(".lcov")
  ) {
    return "inert";
  }

  return "unknown";
}

export interface NameStatusRow {
  readonly status: string;
  readonly path: string;
  readonly oldPath: string | null;
}

/** Parse `git diff --name-status` (status-aware; renames keep old+new). */
export function parseNameStatus(text: string): NameStatusRow[] {
  const rows: NameStatusRow[] = [];
  for (const line of text.replace(/\r\n/g, "\n").split("\n")) {
    if (line.trim().length === 0) continue;
    const parts = line.split("\t");
    if (parts.length < 2) continue;
    const status = (parts[0] ?? "").trim();
    if (status.startsWith("R") || status.startsWith("C")) {
      if (parts.length < 3) continue;
      rows.push({
        status,
        oldPath: parts[1] ?? null,
        path: parts[2] ?? "",
      });
      continue;
    }
    rows.push({
      status,
      oldPath: null,
      path: parts[1] ?? "",
    });
  }
  return rows.filter((r) => r.path.length > 0);
}

function isRenameToDocumentWithoutProof(
  row: NameStatusRow,
  classify: typeof classifyChangedPath,
): boolean {
  if (!(row.status.startsWith("R") || row.status.startsWith("C"))) return false;
  if (row.oldPath === null) return true;
  const oldClass = classify(row.oldPath, row.status, null);
  const newClass = classify(row.path, row.status, row.oldPath);
  // Only proven-inert old paths may rename to inert without further proof.
  // Coverable or unknown → inert is rename-to-document without proof.
  return oldClass !== "inert" && newClass === "inert";
}

export function evaluateCoverageApplicability(
  input: EvaluateCoverageApplicabilityInput,
  deps: CoverageApplicabilityDeps = {},
): CoverageApplicabilityResult {
  const runGit = deps.runGit ?? defaultRunGit;
  const classify = deps.classifyPath ?? classifyChangedPath;
  const empty: ClassifiedChange[] = [];

  if (!input.baseSha || input.baseSha.trim().length === 0) {
    return {
      outcome: "refuse",
      code: "invalid-base",
      reason: "coverage-applicability: invalid or empty baseSha",
      changes: empty,
    };
  }
  if (!input.headSha || input.headSha.trim().length === 0) {
    return {
      outcome: "refuse",
      code: "invalid-head",
      reason: "coverage-applicability: invalid or empty headSha",
      changes: empty,
    };
  }
  if (!input.treeHash || input.treeHash.trim().length === 0) {
    return {
      outcome: "refuse",
      code: "invalid-tree",
      reason: "coverage-applicability: invalid or empty treeHash",
      changes: empty,
    };
  }

  try {
    if (input.requireTreeMatch !== false) {
      const headTree = runGit(["rev-parse", `${input.headSha}^{tree}`], input.projectRoot).trim();
      if (headTree !== input.treeHash.trim()) {
        return {
          outcome: "refuse",
          code: "tree-mismatch",
          reason: "coverage-applicability: binding treeHash does not match the reviewed head tree",
          changes: empty,
        };
      }
    }

    // Validate base is resolvable.
    runGit(["rev-parse", "--verify", "-q", input.baseSha], input.projectRoot);

    const nameStatusText = runGit(
      ["diff", "--name-status", "--find-renames", input.baseSha, input.headSha],
      input.projectRoot,
    );
    const rows = parseNameStatus(nameStatusText);
    if (rows.length === 0) {
      return {
        outcome: "refuse",
        code: "empty-selection",
        reason:
          "coverage-applicability: empty or failed path selection is not proof of an inert diff",
        changes: empty,
      };
    }

    const changes: ClassifiedChange[] = [];
    for (const row of rows) {
      if (isRenameToDocumentWithoutProof(row, classify)) {
        return {
          outcome: "refuse",
          code: "rename-to-document",
          reason: `coverage-applicability: rename-to-document without content/type proof (${row.oldPath} -> ${row.path})`,
          changes,
        };
      }
      let classification: PathClassification;
      try {
        classification = classify(row.path, row.status, row.oldPath);
      } catch (err: unknown) {
        return {
          outcome: "refuse",
          code: "classifier-failure",
          reason: `coverage-applicability: classifier failure: ${String((err as Error).message ?? err)}`,
          changes,
        };
      }
      changes.push({
        status: row.status,
        path: row.path,
        oldPath: row.oldPath,
        classification,
      });
    }

    if (changes.some((c) => c.classification === "unknown")) {
      const unknownPaths = changes.filter((c) => c.classification === "unknown").map((c) => c.path);
      return {
        outcome: "refuse",
        code: "unknown-path",
        reason: `coverage-applicability: unknown path classification: ${unknownPaths.join(", ")}`,
        changes,
      };
    }

    const coverable = changes.filter((c) => c.classification === "coverable");
    if (coverable.length > 0) {
      return {
        outcome: "applicable",
        coverablePaths: coverable.map((c) => c.path),
        changes,
      };
    }

    if (!changes.every((c) => c.classification === "inert")) {
      return {
        outcome: "refuse",
        code: "mixed-unclassified",
        reason: "coverage-applicability: mixed classification without all-inert proof",
        changes,
      };
    }

    return {
      outcome: "not-applicable",
      reason: COVERAGE_HEADROOM_NOT_APPLICABLE_SKIP,
      changes,
    };
  } catch (err: unknown) {
    if (err instanceof GitCommandError) {
      const msg = err.message;
      if (
        msg.includes("baseSha") ||
        msg.includes(input.baseSha) ||
        /unknown revision|bad revision|needed a single revision/i.test(msg)
      ) {
        return {
          outcome: "refuse",
          code: "invalid-base",
          reason: msg,
          changes: empty,
        };
      }
      return {
        outcome: "refuse",
        code: "git-failure",
        reason: msg,
        changes: empty,
      };
    }
    return {
      outcome: "refuse",
      code: "classifier-failure",
      reason: `coverage-applicability: ${String((err as Error).message ?? err)}`,
      changes: empty,
    };
  }
}

/** True when the controller may honor the coverage_headroom skip channel. */
export function isCoverageHeadroomNotApplicable(
  input: EvaluateCoverageApplicabilityInput,
  deps?: CoverageApplicabilityDeps,
): boolean {
  return evaluateCoverageApplicability(input, deps).outcome === "not-applicable";
}
