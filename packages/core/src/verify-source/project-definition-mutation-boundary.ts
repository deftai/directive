/**
 * project-definition-mutation-boundary.ts -- mechanized production inventory for
 * PROJECT-DEFINITION mutation identity (#3796).
 *
 * A convention that mutators "should" use the shared lock is not checkable: a
 * caller can take the lock and then resolve, read, or write the artifact through
 * its own path, and a helper-level test still passes while a production family
 * split-brains. This scanner replaces that convention with a boundary.
 *
 * Two things are enforced:
 *
 * 1. **Boundary** -- outside the modules that own the protocol, no production
 *    source may call the raw lock, the raw write sink, or the raw loader, and no
 *    file that mutates PROJECT-DEFINITION may re-resolve the artifact path. The
 *    mutation capability is the only way in.
 * 2. **Inventory** -- the per-file census of mutation call expressions is
 *    recorded. Adding or removing a mutation site is a deliberate edit to
 *    {@link PRODUCTION_MUTATION_INVENTORY}, not a silent drift.
 *
 * Consumed fail-closed by `project-definition-mutation-boundary.test.ts`.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

/** The capability that owns load/parse/persist against the captured path. */
export const MUTATION_CAPABILITY_MODULE =
  "packages/core/src/vbrief-build/project-definition-mutation.ts";

/** The module that owns the lock protocol and the raw primitives it wraps. */
export const MUTATION_PROTOCOL_MODULE = "packages/core/src/vbrief-build/project-definition-io.ts";

/**
 * This scanner. Excluded from its own scan: it names every pattern it looks for
 * in prose and regex literals, so scanning it would count the rules as call
 * sites and let the inventory drift by editing the gate.
 */
export const MUTATION_BOUNDARY_MODULE =
  "packages/core/src/verify-source/project-definition-mutation-boundary.ts";

/**
 * Raw primitives and the only production files allowed to call them. Anything
 * else reaching for these is a bypass of the captured-path identity.
 */
export const RAW_MUTATION_CALL_RULES: readonly {
  readonly label: string;
  readonly pattern: RegExp;
  readonly allowedFiles: readonly string[];
}[] = [
  {
    label: "raw mutation lock",
    pattern: /\bprojectDefinitionMutationLock\s*\(/,
    allowedFiles: [MUTATION_CAPABILITY_MODULE],
  },
  {
    label: "raw PROJECT-DEFINITION write sink",
    pattern: /\batomicWriteProjectDefinition\s*\(/,
    allowedFiles: [MUTATION_CAPABILITY_MODULE, MUTATION_PROTOCOL_MODULE],
  },
  {
    label: "raw captured-path parser",
    pattern: /\bparseProjectDefinitionAt\s*\(/,
    allowedFiles: [MUTATION_CAPABILITY_MODULE, MUTATION_PROTOCOL_MODULE],
  },
  {
    label: "raw unlocked loader",
    pattern: /\bloadProjectDefinitionForMutation\s*\(/,
    allowedFiles: [MUTATION_PROTOCOL_MODULE],
  },
];

/** Resolver calls that would give a mutation section a second artifact identity. */
export const RESOLVER_CALL_PATTERNS: readonly RegExp[] = [
  /\bresolveProjectDefinitionPath\s*\(/,
  /\bprojectDefinitionPath\s*\(/,
];

/** Marks a file as performing a PROJECT-DEFINITION mutation. */
const MUTATION_CALL_PATTERN = /\bwithProjectDefinitionMutation\s*\(/g;

/**
 * Character offsets of each `withProjectDefinitionMutation(...)` argument list.
 *
 * Scoping to the section is what keeps the resolver rule precise: resolving the
 * path *before* acquiring the lock is ordinary pre-check work, while resolving it
 * *inside* the critical section is the second identity the contract forbids.
 * String, template, and comment spans are skipped so their braces and parens do
 * not throw off the match.
 */
export function extractMutationSections(text: string): Array<[number, number]> {
  const sections: Array<[number, number]> = [];
  const call = /\bwithProjectDefinitionMutation\s*\(/g;
  let match: RegExpExecArray | null = call.exec(text);
  while (match !== null) {
    const open = match.index + match[0].length - 1;
    const end = matchClosingParen(text, open);
    if (end > open) sections.push([open, end]);
    call.lastIndex = end > open ? end : call.lastIndex;
    match = call.exec(text);
  }
  return sections;
}

function matchClosingParen(text: string, openIndex: number): number {
  let depth = 0;
  let i = openIndex;
  while (i < text.length) {
    const ch = text[i];
    const next = text[i + 1];
    if (ch === "/" && next === "/") {
      while (i < text.length && text[i] !== "\n") i += 1;
      continue;
    }
    if (ch === "/" && next === "*") {
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i += 1;
      i += 2;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      i = skipStringLiteral(text, i);
      continue;
    }
    if (ch === "(") depth += 1;
    if (ch === ")") {
      depth -= 1;
      if (depth === 0) return i;
    }
    i += 1;
  }
  return openIndex;
}

function skipStringLiteral(text: string, startIndex: number): number {
  const quote = text[startIndex];
  let i = startIndex + 1;
  while (i < text.length) {
    if (text[i] === "\\") {
      i += 2;
      continue;
    }
    if (text[i] === quote) return i + 1;
    i += 1;
  }
  return i;
}

/**
 * Production mutation call expressions, per file.
 *
 * The counts are the #3796 census: **18** call expressions across 13 core files
 * that previously took the shared lock, plus the **2** `packages/cli` policy
 * writers (`wipCap`, `swarmSubagentBackend`) that previously wrote
 * PROJECT-DEFINITION with no lock at all. `parity-scenarios.ts` is the fixture
 * harness for the same protocol and is counted separately below.
 */
export const PRODUCTION_MUTATION_INVENTORY: Readonly<Record<string, number>> = Object.freeze({
  "packages/cli/src/dispatch.ts": 2,
  "packages/core/src/policy/ceremony-dial.ts": 1,
  "packages/core/src/policy/host-hooks.ts": 1,
  "packages/core/src/policy/org-force-on-migration.ts": 1,
  "packages/core/src/policy/product-signal.ts": 1,
  "packages/core/src/policy/require-human-merge.ts": 1,
  "packages/core/src/policy/resolve.ts": 1,
  "packages/core/src/policy/value-feedback.ts": 2,
  "packages/core/src/render/project-render.ts": 2,
  "packages/core/src/scope/project-definition-sync.ts": 1,
  "packages/core/src/triage/scope-drift/add-ignore.ts": 1,
  "packages/core/src/triage/scope/mutations-core.ts": 2,
  "packages/core/src/triage/subscribe/index.ts": 1,
  "packages/core/src/triage/welcome/writers.ts": 3,
  "packages/core/src/vbrief-build/parity-scenarios.ts": 1,
});

/**
 * The #3796 census, split by provenance so a drift failure says which family
 * moved. 18 core call expressions across 13 files already took the shared lock;
 * the 2 `packages/cli` policy writers did not; `parity-scenarios.ts` is the
 * fixture harness for the same protocol.
 */
export const PREVIOUSLY_LOCKED_CORE_CALL_EXPRESSIONS = 18;
export const PREVIOUSLY_LOCKED_CORE_FILES = 13;
export const PREVIOUSLY_UNLOCKED_CLI_WRITERS = 2;
export const PARITY_HARNESS_CALL_EXPRESSIONS = 1;

export interface MutationBoundaryFinding {
  readonly path: string;
  readonly line: number;
  readonly rule: string;
  readonly text: string;
}

export interface MutationBoundaryScan {
  readonly findings: readonly MutationBoundaryFinding[];
  /** Mutation call expressions per production file, posix-relative. */
  readonly inventory: Readonly<Record<string, number>>;
  readonly filesScanned: number;
}

const SCAN_ROOTS: readonly string[] = ["packages/core/src", "packages/cli/src"];
const TEST_PATH_MARKERS: readonly string[] = [".test.ts", ".test.tsx", "/fixtures/"];

function toPosix(p: string): string {
  return p.split(sep).join("/");
}

function isProductionSource(relPosix: string): boolean {
  return !TEST_PATH_MARKERS.some((marker) => relPosix.includes(marker));
}

function walkTsFiles(dir: string, out: string[]): void {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of entries) {
    if (name === "node_modules" || name === "dist" || name === ".git") continue;
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

/**
 * A re-export (`export { x } from "..."`) forwards a symbol, it does not call
 * it, so it is not a bypass. Import lines are likewise declarations.
 */
function isDeclarationLine(trimmed: string): boolean {
  return (
    trimmed.startsWith("import ") ||
    trimmed.startsWith("export {") ||
    trimmed.startsWith("export type {") ||
    trimmed.startsWith("export *") ||
    trimmed.startsWith("//") ||
    trimmed.startsWith("*") ||
    trimmed.startsWith("/*")
  );
}

/**
 * Scan production TypeScript for mutation-identity bypasses and build the
 * mutation call-expression inventory. The scan reads the filesystem, not the git
 * index, so an unstaged or brand-new bypass is still caught.
 */
export function scanProjectDefinitionMutationBoundary(projectRoot: string): MutationBoundaryScan {
  const files: string[] = [];
  for (const root of SCAN_ROOTS) {
    walkTsFiles(join(projectRoot, root), files);
  }

  const findings: MutationBoundaryFinding[] = [];
  const inventory: Record<string, number> = {};
  let filesScanned = 0;

  for (const abs of files) {
    const relPosix = toPosix(relative(projectRoot, abs));
    if (!isProductionSource(relPosix) || relPosix === MUTATION_BOUNDARY_MODULE) continue;
    filesScanned += 1;

    let text: string;
    try {
      text = readFileSync(abs, "utf8");
    } catch {
      continue;
    }

    MUTATION_CALL_PATTERN.lastIndex = 0;
    const mutationCalls = text.match(MUTATION_CALL_PATTERN)?.length ?? 0;
    if (mutationCalls > 0) inventory[relPosix] = mutationCalls;
    const sections = mutationCalls > 0 ? extractMutationSections(text) : [];

    const lines = text.split(/\r?\n/);
    let offset = 0;
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i] ?? "";
      const lineStart = offset;
      offset += line.length + 1;
      const trimmed = line.trim();
      if (isDeclarationLine(trimmed)) continue;

      for (const rule of RAW_MUTATION_CALL_RULES) {
        if (rule.pattern.test(line) && !rule.allowedFiles.includes(relPosix)) {
          findings.push({ path: relPosix, line: i + 1, rule: rule.label, text: trimmed });
        }
      }

      // Inside a critical section the artifact identity is the captured one.
      const insideSection = sections.some(([start, end]) => lineStart >= start && lineStart <= end);
      if (insideSection && relPosix !== MUTATION_CAPABILITY_MODULE) {
        for (const pattern of RESOLVER_CALL_PATTERNS) {
          if (pattern.test(line)) {
            findings.push({
              path: relPosix,
              line: i + 1,
              rule: "artifact path re-resolved inside a mutation section",
              text: trimmed,
            });
          }
        }
      }
    }
  }

  return { findings, inventory, filesScanned };
}

/** Render findings as a stable, reviewable report. */
export function formatMutationBoundaryFindings(
  findings: readonly MutationBoundaryFinding[],
): string {
  return findings
    .map((f) => `  ${f.path}:${f.line} [${f.rule}] ${f.text}`)
    .sort()
    .join("\n");
}

export interface MutationBoundaryVerdict {
  readonly ok: boolean;
  readonly errors: readonly string[];
  readonly scan: MutationBoundaryScan;
}

/**
 * The fail-closed verdict: no bypass, and the mutation inventory still matches
 * the recorded census. Adding or removing a mutation site is a deliberate edit
 * to {@link PRODUCTION_MUTATION_INVENTORY} and the census constants above.
 */
export function evaluateProjectDefinitionMutationBoundary(
  projectRoot: string,
): MutationBoundaryVerdict {
  const scan = scanProjectDefinitionMutationBoundary(projectRoot);
  const errors: string[] = [];

  if (scan.findings.length > 0) {
    errors.push(
      `${scan.findings.length} raw resolver/lock/write bypass(es) outside the mutation capability:\n` +
        formatMutationBoundaryFindings(scan.findings),
    );
  }

  for (const [path, expected] of Object.entries(PRODUCTION_MUTATION_INVENTORY)) {
    const actual = scan.inventory[path] ?? 0;
    if (actual !== expected) {
      errors.push(`${path}: expected ${expected} mutation call(s), found ${actual}`);
    }
  }
  for (const path of Object.keys(scan.inventory)) {
    if (!(path in PRODUCTION_MUTATION_INVENTORY)) {
      errors.push(`${path}: mutation call site not in the recorded inventory`);
    }
  }

  const total = Object.values(scan.inventory).reduce((sum, n) => sum + n, 0);
  const expectedTotal =
    PREVIOUSLY_LOCKED_CORE_CALL_EXPRESSIONS +
    PREVIOUSLY_UNLOCKED_CLI_WRITERS +
    PARITY_HARNESS_CALL_EXPRESSIONS;
  if (total !== expectedTotal) {
    errors.push(`census total: expected ${expectedTotal} mutation call(s), found ${total}`);
  }

  const coreFiles = Object.keys(scan.inventory).filter(
    (path) => path.startsWith("packages/core/") && !path.includes("parity-scenarios"),
  );
  if (coreFiles.length !== PREVIOUSLY_LOCKED_CORE_FILES) {
    errors.push(
      `census files: expected ${PREVIOUSLY_LOCKED_CORE_FILES} core file(s), found ${coreFiles.length}`,
    );
  }

  return { ok: errors.length === 0, errors, scan };
}
