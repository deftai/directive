/**
 * contained-writes.ts — inventory gate for raw product write sinks (#2951).
 *
 * Scans TypeScript under packages/core/src (and optional roots) for raw write
 * call patterns (`writeFileSync`, `appendFileSync`, `fs.writeFile`, etc.)
 * outside an allowlist. Default remains **fail-open** (advisory exit 0) while
 * mass migration continues; pass `--enforce` to fail closed (Phase 2+).
 *
 * Allowlist is the residual set of modules not yet migrated onto containedWrite.
 * Phase 2 removed cache/io + lifecycle/events after sink migration.
 *
 * Exit codes:
 *   0 — clean OR fail-open with findings (default)
 *   1 — findings under `--enforce` (fail-closed)
 *   2 — config error (project root missing)
 *
 * Refs #2951.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";

const EXIT_OK = 0;
const EXIT_ENFORCE_FINDINGS = 1;
const EXIT_CONFIG = 2;

/** Patterns that indicate a raw filesystem write sink in product code. */
export const RAW_WRITE_PATTERNS: readonly RegExp[] = [
  /\bwriteFileSync\s*\(/,
  /\bappendFileSync\s*\(/,
  /\bfs\.writeFile\s*\(/,
  /\bfs\.promises\.writeFile\s*\(/,
  /\bcreateWriteStream\s*\(/,
  /\bwriteFile\s*\(\s*[^)]+,\s*[^)]+,\s*['"]utf8['"]/,
  // Low-level / async forms that also bypass containedWrite (#2951 Greptile P1).
  /\bopenSync\s*\(/,
  /\bwriteSync\s*\(/,
  /\bappendFile\s*\(/,
  /\.writeFile\s*\(/,
  /\bpromises\.writeFile\s*\(/,
  /\bfs\.open\s*\(/,
  /\bfs\.write\s*\(/,
];

/**
 * Relative path prefixes (posix-style) allowed to use raw write sinks.
 * Shrink as sinks migrate onto containedWrite (#2951 Phase 2+).
 */
export const CONTAINED_WRITES_ALLOWLIST: readonly string[] = [
  // Implementation modules for containment + contained write.
  "packages/core/src/fs/contained-write.ts",
  "packages/core/src/fs/projection-containment.ts",
  // Deposit tree copy / contain primitives (low-level install sinks; residual).
  "packages/core/src/deposit/copy-tree.ts",
  "packages/core/src/deposit/contain.ts",
  // Phase 2 removed: cache/io.ts, lifecycle/events.ts (migrated to containedWrite).
];

/** Path segments that mark a file as test or fixture (always allowlisted). */
const TEST_PATH_MARKERS: readonly string[] = [
  ".test.ts",
  ".test.tsx",
  "/test-helpers.ts",
  "/fixtures/",
  "\\fixtures\\",
];

export interface ContainedWriteFinding {
  readonly path: string;
  readonly line: number;
  readonly match: string;
}

export interface ContainedWritesOptions {
  readonly projectRoot: string;
  /** When true, exit 1 if any non-allowlisted raw write is found. Default false (fail-open). */
  readonly enforce?: boolean;
  /** Extra relative path prefixes to allow. */
  readonly extraAllowlist?: readonly string[];
  /** Roots to scan relative to projectRoot. Default packages/core/src. */
  readonly scanRoots?: readonly string[];
}

export interface ContainedWritesResult {
  readonly code: 0 | 1 | 2;
  readonly message: string;
  readonly stream: "stdout" | "stderr";
  readonly findings: readonly ContainedWriteFinding[];
  readonly enforce: boolean;
  readonly failOpen: boolean;
}

function toPosix(p: string): string {
  return p.split(sep).join("/");
}

function isTestPath(relPosix: string): boolean {
  return TEST_PATH_MARKERS.some((m) => relPosix.includes(m.replace(/\\/g, "/")));
}

/** Strip trailing `/` without regex (CodeQL js/polynomial-redos safe). */
function stripTrailingSlashes(path: string): string {
  let end = path.length;
  while (end > 0 && path.charCodeAt(end - 1) === 47 /* / */) {
    end -= 1;
  }
  return end === path.length ? path : path.slice(0, end);
}

function isAllowlisted(relPosix: string, allow: readonly string[]): boolean {
  if (isTestPath(relPosix)) {
    return true;
  }
  return allow.some((entry) => {
    // Avoid regex on path input (CodeQL js/polynomial-redos on /\/+$/).
    const e = stripTrailingSlashes(entry.split("\\").join("/"));
    // Exact file match, or directory-prefix only (never bare endsWith — that
    // lets `evil/.../packages/core/src/fs/contained-write.ts` slip through).
    return relPosix === e || relPosix.startsWith(`${e}/`);
  });
}

function walkTsFiles(dir: string, out: string[]): void {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of entries) {
    if (name === "node_modules" || name === "dist" || name === ".git") {
      continue;
    }
    const full = join(dir, name);
    let st: ReturnType<typeof statSync>;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      walkTsFiles(full, out);
    } else if (st.isFile() && (name.endsWith(".ts") || name.endsWith(".tsx"))) {
      out.push(full);
    }
  }
}

function scanFile(absPath: string, relPosix: string): ContainedWriteFinding[] {
  let text: string;
  try {
    text = readFileSync(absPath, "utf8");
  } catch {
    return [];
  }
  const findings: ContainedWriteFinding[] = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? "";
    // Skip import lines and comments-only lines for noise reduction.
    const trimmed = line.trim();
    if (
      trimmed.startsWith("import ") ||
      trimmed.startsWith("//") ||
      trimmed.startsWith("*") ||
      trimmed.startsWith("/*")
    ) {
      continue;
    }
    for (const re of RAW_WRITE_PATTERNS) {
      if (re.test(line)) {
        findings.push({
          path: relPosix,
          line: i + 1,
          match: trimmed.length > 100 ? `${trimmed.slice(0, 97)}...` : trimmed,
        });
        break;
      }
    }
  }
  return findings;
}

/**
 * Inventory raw write sinks under scan roots; fail-open by default (#2951).
 * Pass `enforce: true` / `--enforce` to fail closed on findings (Phase 2 path).
 */
export function evaluateContainedWrites(options: ContainedWritesOptions): ContainedWritesResult {
  const root = resolve(options.projectRoot);
  if (!existsSync(root)) {
    return {
      code: EXIT_CONFIG,
      message: `verify:contained-writes: project root not found: ${root}`,
      stream: "stderr",
      findings: [],
      enforce: Boolean(options.enforce),
      failOpen: !options.enforce,
    };
  }

  const enforce = options.enforce === true;
  const allow = [...CONTAINED_WRITES_ALLOWLIST, ...(options.extraAllowlist ?? [])];
  const scanRoots = options.scanRoots ?? ["packages/core/src"];
  const findings: ContainedWriteFinding[] = [];

  for (const scanRel of scanRoots) {
    const scanAbs = resolve(root, scanRel);
    if (!existsSync(scanAbs)) {
      continue;
    }
    const files: string[] = [];
    walkTsFiles(scanAbs, files);
    for (const abs of files) {
      const relPosix = toPosix(relative(root, abs));
      if (isAllowlisted(relPosix, allow)) {
        continue;
      }
      findings.push(...scanFile(abs, relPosix));
    }
  }

  if (findings.length === 0) {
    return {
      code: EXIT_OK,
      message: `OK: verify:contained-writes — no non-allowlisted raw write sinks under ${scanRoots.join(", ")} (enforce=${enforce}).`,
      stream: "stdout",
      findings: [],
      enforce,
      failOpen: !enforce,
    };
  }

  const lines = [
    `verify:contained-writes: found ${findings.length} raw write sink(s) outside allowlist:`,
    ...findings.slice(0, 50).map((f) => `  ${f.path}:${f.line}: ${f.match}`),
  ];
  if (findings.length > 50) {
    lines.push(`  ... and ${findings.length - 50} more`);
  }

  if (enforce) {
    lines.push(
      "FAIL: --enforce is set; migrate sinks to packages/core/src/fs/contained-write.ts or add a justified allowlist entry (#2951).",
    );
    return {
      code: EXIT_ENFORCE_FINDINGS,
      message: lines.join("\n"),
      stream: "stderr",
      findings,
      enforce: true,
      failOpen: false,
    };
  }

  lines.push(
    "ADVISORY (fail-open): exit 0. Prefer containedWrite() for new sinks; pass --enforce to fail closed. See docs/reference/contained-write.md (#2951 Phase 2).",
  );
  return {
    code: EXIT_OK,
    message: lines.join("\n"),
    stream: "stdout",
    findings,
    enforce: false,
    failOpen: true,
  };
}
