import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * C1 declared deposit closure (#3601 / #3899).
 *
 * Required consumer-deposit paths are a closed typed declaration, not a
 * regex over AGENTS.md RFC2119 prose. Existence checks reuse existsSync
 * the same way validate-links.ts does, against a staged pack root (the
 * prepack flatten), not the source checkout.
 */

export const DEPOSIT_REQUIRED_SCHEMA = "deft.deposit-required-paths.v1" as const;
export const DEPOSIT_REQUIRED_REL = "contracts/deposit-required-paths.json";
export const DEPOSIT_PREFIX = ".deft/core/";

export interface DepositRequiredDeclaration {
  readonly schema: typeof DEPOSIT_REQUIRED_SCHEMA;
  readonly paths: readonly string[];
}

export interface DepositClosureResult {
  readonly ok: boolean;
  readonly missing: readonly string[];
  readonly checked: number;
}

/** Parser-visible field. Not a scan of ! / backtick paths. */
const DEPOSIT_REQUIRED_COMMENT = /<!--\s*deposit-required:\s+(\S+)\s*-->/g;

export function extractDepositRequiredComments(source: string): string[] {
  const out: string[] = [];
  const re = new RegExp(DEPOSIT_REQUIRED_COMMENT.source, "g");
  let match: RegExpExecArray | null = re.exec(source);
  while (match !== null) {
    const path = match[1];
    if (path !== undefined) {
      out.push(path);
    }
    match = re.exec(source);
  }
  return out;
}

export function parseDepositRequiredDeclaration(jsonText: string): DepositRequiredDeclaration {
  let data: { schema?: unknown; paths?: unknown };
  try {
    data = JSON.parse(jsonText) as { schema?: unknown; paths?: unknown };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(`deposit-required: invalid JSON (${reason})`);
  }
  if (data.schema !== DEPOSIT_REQUIRED_SCHEMA) {
    throw new Error(
      "deposit-required: expected schema " +
        DEPOSIT_REQUIRED_SCHEMA +
        ", got " +
        String(data.schema),
    );
  }
  if (!Array.isArray(data.paths) || data.paths.length === 0) {
    throw new Error("deposit-required: paths must be a non-empty array of strings");
  }
  const paths: string[] = [];
  for (const item of data.paths) {
    if (
      typeof item !== "string" ||
      !item.startsWith(DEPOSIT_PREFIX) ||
      item.includes("\\") ||
      item.includes("..")
    ) {
      throw new Error(`deposit-required: invalid path ${String(item)}`);
    }
    paths.push(item);
  }
  return { schema: DEPOSIT_REQUIRED_SCHEMA, paths };
}

export function packRelativeFromDepositPath(declared: string): string {
  if (!declared.startsWith(DEPOSIT_PREFIX)) {
    throw new Error(`deposit-required: not a deposit path: ${declared}`);
  }
  return declared.slice(DEPOSIT_PREFIX.length);
}

/** Prepack mapping used by @deftai/directive-content. */
export function sourcePathForPackRelative(repoRoot: string, packRelative: string): string {
  const rel = packRelative.replace(/\\/g, "/");
  if (
    rel === "main.md" ||
    rel === "SKILL.md" ||
    rel === "Taskfile.yml" ||
    rel.startsWith("tasks/") ||
    rel.startsWith(".githooks/")
  ) {
    return join(repoRoot, ...rel.split("/"));
  }
  return join(repoRoot, "content", ...rel.split("/"));
}

export function evaluateDepositClosure(options: {
  readonly packRoot: string;
  readonly paths: readonly string[];
}): DepositClosureResult {
  const missing: string[] = [];
  for (const declared of options.paths) {
    const rel = packRelativeFromDepositPath(declared);
    const target = join(options.packRoot, ...rel.split("/"));
    if (!existsSync(target)) {
      missing.push(declared);
    }
  }
  return { ok: missing.length === 0, missing, checked: options.paths.length };
}

export function loadDepositRequiredDeclaration(filePath: string): DepositRequiredDeclaration {
  return parseDepositRequiredDeclaration(readFileSync(filePath, "utf8"));
}

export function resolveDeclarationFile(root: string): string | null {
  const underContent = join(root, "content", DEPOSIT_REQUIRED_REL);
  if (existsSync(underContent)) {
    return underContent;
  }
  const underRoot = join(root, DEPOSIT_REQUIRED_REL);
  if (existsSync(underRoot)) {
    return underRoot;
  }
  return null;
}

export function evaluateInstalledDepositClosure(projectRoot: string): {
  readonly skipped: boolean;
  readonly missing: readonly string[];
  readonly declarationPath: string | null;
} {
  const deftDir = join(projectRoot, ".deft", "core");
  const declarationPath = resolveDeclarationFile(deftDir) ?? resolveDeclarationFile(projectRoot);
  if (declarationPath === null) {
    return { skipped: true, missing: [], declarationPath: null };
  }
  if (!existsSync(deftDir)) {
    return { skipped: true, missing: [], declarationPath };
  }
  const declaration = loadDepositRequiredDeclaration(declarationPath);
  const result = evaluateDepositClosure({ packRoot: deftDir, paths: declaration.paths });
  return { skipped: false, missing: result.missing, declarationPath };
}

export function renderDeclaredDepositClosureLine(
  result: ReturnType<typeof evaluateInstalledDepositClosure>,
): string {
  if (result.skipped) {
    return "Deposit required-paths: skip -- no C1 declaration in this tree.";
  }
  if (result.missing.length === 0) {
    return "Deposit required-paths: ok -- declared C1 paths exist in .deft/core.";
  }
  const sample = result.missing.slice(0, 5).join(", ");
  const extra = result.missing.length > 5 ? ` (+${String(result.missing.length - 5)} more)` : "";
  return (
    "Deposit required-paths: fail -- " +
    String(result.missing.length) +
    " declared path(s) missing from .deft/core. Examples: " +
    sample +
    extra +
    ". Run directive update to refresh the deposit (#3601 C1)."
  );
}
