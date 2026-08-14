/**
 * Production call-site scan for run-summary event kinds / emitter methods (#3362).
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { isKindEmitterMethod, methodsForKind, RUN_SUMMARY_EVENT_KINDS } from "./kinds.js";

export const DEFAULT_SCAN_ROOTS: readonly string[] = ["packages/core/src"];
export const EMITTER_MODULE_REL = "packages/core/src/run-summary/emit.ts";

const SKIP_DIR_NAMES = new Set(["node_modules", "dist", ".git", "coverage"]);

export interface CallerHit {
  readonly path: string;
  readonly line: number;
  readonly match: string;
}

export interface CallerScanResult {
  readonly callersByKind: Readonly<Record<string, readonly CallerHit[]>>;
  readonly callersByMethod: Readonly<Record<string, readonly CallerHit[]>>;
  readonly discoveredMethods: readonly string[];
}

function toPosix(rel: string): string {
  return rel.split(sep).join("/");
}

function isTestFile(relPosix: string): boolean {
  return relPosix.endsWith(".test.ts") || relPosix.endsWith(".test.tsx");
}

function isExcludedProductionPath(relPosix: string): boolean {
  if (isTestFile(relPosix)) {
    return true;
  }
  if (relPosix.includes("/telemetry-coverage/")) {
    return true;
  }
  return relPosix === EMITTER_MODULE_REL;
}

function walkTsFiles(dir: string, out: string[]): void {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of entries) {
    if (SKIP_DIR_NAMES.has(name)) {
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

function skipNoiseLine(trimmed: string): boolean {
  return (
    trimmed.startsWith("import ") ||
    trimmed.startsWith("export ") ||
    trimmed.startsWith("//") ||
    trimmed.startsWith("*") ||
    trimmed.startsWith("/*")
  );
}

function discoverEmitterMethods(emitSource: string): string[] {
  const names = new Set<string>();
  const re = /^\s+(emit[A-Z][A-Za-z0-9]*)\s*\(/gm;
  let match: RegExpExecArray | null = re.exec(emitSource);
  while (match !== null) {
    const name = match[1];
    if (name !== undefined && isKindEmitterMethod(name)) {
      names.add(name);
    }
    match = re.exec(emitSource);
  }
  return [...names].sort();
}

function kindLiteralPatterns(kind: string): readonly RegExp[] {
  const escaped = kind.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return [
    new RegExp(`\\.emit\\s*\\(\\s*['"]${escaped}['"]`),
    new RegExp(`event\\s*:\\s*['"]${escaped}['"]`),
  ];
}

function methodCallPattern(method: string): RegExp {
  const escaped = method.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`\\b${escaped}\\s*\\(`);
}

function collectHits(
  relPosix: string,
  lines: readonly string[],
  patterns: readonly RegExp[],
): CallerHit[] {
  const hits: CallerHit[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? "";
    const trimmed = line.trim();
    if (skipNoiseLine(trimmed)) {
      continue;
    }
    for (const re of patterns) {
      if (re.test(line)) {
        hits.push({
          path: relPosix,
          line: i + 1,
          match: trimmed.length > 100 ? `${trimmed.slice(0, 97)}...` : trimmed,
        });
        break;
      }
    }
  }
  return hits;
}

/**
 * Scan production TypeScript for emitter method / event-kind call sites.
 * Excludes the emitter module, this detector, and `*.test.ts`.
 */
export function scanProductionCallers(options: {
  readonly projectRoot: string;
  readonly scanRoots?: readonly string[];
  readonly kinds?: readonly string[];
}): CallerScanResult {
  const root = resolve(options.projectRoot);
  const scanRoots = options.scanRoots ?? DEFAULT_SCAN_ROOTS;
  const kinds = options.kinds ?? [...RUN_SUMMARY_EVENT_KINDS];

  const callersByKind: Record<string, CallerHit[]> = {};
  const callersByMethod: Record<string, CallerHit[]> = {};
  for (const kind of kinds) {
    callersByKind[kind] = [];
    for (const method of methodsForKind(kind)) {
      callersByMethod[method] = callersByMethod[method] ?? [];
    }
  }

  let discoveredMethods: string[] = [];
  const emitAbs = resolve(root, EMITTER_MODULE_REL);
  if (existsSync(emitAbs)) {
    try {
      discoveredMethods = discoverEmitterMethods(readFileSync(emitAbs, "utf8"));
      for (const method of discoveredMethods) {
        callersByMethod[method] = callersByMethod[method] ?? [];
      }
    } catch {
      discoveredMethods = [];
    }
  }

  for (const scanRel of scanRoots) {
    const scanAbs = resolve(root, scanRel);
    if (!existsSync(scanAbs)) {
      continue;
    }
    const files: string[] = [];
    walkTsFiles(scanAbs, files);
    for (const abs of files) {
      const relPosix = toPosix(relative(root, abs));
      if (isExcludedProductionPath(relPosix)) {
        continue;
      }
      let text: string;
      try {
        text = readFileSync(abs, "utf8");
      } catch {
        continue;
      }
      const lines = text.split(/\r?\n/);
      for (const kind of kinds) {
        const patterns = [
          ...kindLiteralPatterns(kind),
          ...methodsForKind(kind).map(methodCallPattern),
        ];
        callersByKind[kind]?.push(...collectHits(relPosix, lines, patterns));
      }
      for (const method of Object.keys(callersByMethod)) {
        callersByMethod[method]?.push(...collectHits(relPosix, lines, [methodCallPattern(method)]));
      }
    }
  }

  return { callersByKind, callersByMethod, discoveredMethods };
}
