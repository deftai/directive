/**
 * Check 1 -- staged-pack deposit closure (#3900 / #3601 C1).
 *
 * Resolves the C1 declaration against a staged pack root. Does not infer
 * required paths from AGENTS.md prose. Reuses evaluateDepositClosure.
 *
 * Three-state: 0 clean / 1 missing declared paths / 2 config.
 */

import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  type DepositClosureResult,
  type DepositRequiredDeclaration,
  evaluateDepositClosure,
  loadDepositRequiredDeclaration,
  packRelativeFromDepositPath,
  resolveDeclarationFile,
  sourcePathForPackRelative,
} from "../validate-content/deposit-required.js";

const EXIT_OK = 0;
const EXIT_MISSING = 1;
const EXIT_CONFIG = 2;

const REMEDIATION =
  "Recovery: restore the declared files in content/ (or root harness files) so they survive content-package prepack. Do not infer paths from AGENTS.md prose (#3601 C1 / #3900).";

export interface StagedDepositClosureResult {
  readonly code: 0 | 1 | 2;
  readonly message: string;
  readonly stream: "stdout" | "stderr";
  readonly missing: readonly string[];
  readonly checked: number;
}

function keepPackFile(src: string): boolean {
  const posix = src.replace(/\\/g, "/");
  if (posix.includes("__pycache__")) return false;
  if (posix.endsWith(".pyc") || posix.endsWith(".py")) return false;
  return true;
}

/** Copy declared C1 paths into dest using the content-package mapping. */
export function stageDeclaredPack(
  repoRoot: string,
  destPackRoot: string,
): DepositRequiredDeclaration {
  const declarationPath = resolveDeclarationFile(repoRoot);
  if (declarationPath === null) {
    throw new Error(
      "deposit-closure: C1 declaration missing (contracts/deposit-required-paths.json).",
    );
  }
  const declaration = loadDepositRequiredDeclaration(declarationPath);
  mkdirSync(destPackRoot, { recursive: true });
  for (const declared of declaration.paths) {
    const rel = packRelativeFromDepositPath(declared);
    const from = sourcePathForPackRelative(repoRoot, rel);
    if (!existsSync(from)) {
      continue;
    }
    if (!keepPackFile(from)) {
      continue;
    }
    const to = join(destPackRoot, ...rel.split("/"));
    mkdirSync(dirname(to), { recursive: true });
    cpSync(from, to);
  }
  return declaration;
}

export function formatStagedDepositClosureLine(result: DepositClosureResult): string {
  if (result.ok) {
    return (
      "Deposit required-paths: ok -- " +
      String(result.checked) +
      " declared C1 path(s) exist in the staged pack."
    );
  }
  const sample = result.missing.slice(0, 5).join(", ");
  const extra =
    result.missing.length > 5 ? " (+" + String(result.missing.length - 5) + " more)" : "";
  return (
    "Deposit required-paths: fail -- " +
    String(result.missing.length) +
    " declared path(s) missing from staged pack. Examples: " +
    sample +
    extra +
    ". " +
    REMEDIATION
  );
}

export function evaluateStagedDepositClosure(
  packRoot: string,
  paths: readonly string[],
): StagedDepositClosureResult {
  const root = resolve(packRoot);
  let isDir = false;
  try {
    isDir = statSync(root).isDirectory();
  } catch {
    isDir = false;
  }
  if (!isDir) {
    return {
      code: EXIT_CONFIG,
      message:
        "verify_deposit_closure: --pack-root is not a directory: " +
        root +
        "\n  Recovery: pass a staged pack root or framework checkout.",
      stream: "stderr",
      missing: [],
      checked: 0,
    };
  }
  const result = evaluateDepositClosure({ packRoot: root, paths });
  if (result.ok) {
    return {
      code: EXIT_OK,
      message: formatStagedDepositClosureLine(result),
      stream: "stdout",
      missing: result.missing,
      checked: result.checked,
    };
  }
  return {
    code: EXIT_MISSING,
    message: formatStagedDepositClosureLine(result),
    stream: "stderr",
    missing: result.missing,
    checked: result.checked,
  };
}

export function evaluateDepositClosureFromRepo(repoRoot: string): StagedDepositClosureResult {
  const root = resolve(repoRoot);
  const declarationPath = resolveDeclarationFile(root);
  if (declarationPath === null) {
    return {
      code: EXIT_CONFIG,
      message:
        "verify_deposit_closure: C1 declaration missing.\n  Recovery: add content/contracts/deposit-required-paths.json (#3601 C1).",
      stream: "stderr",
      missing: [],
      checked: 0,
    };
  }
  const tmp = mkdtempSync(join(tmpdir(), "deft-3900-pack-"));
  try {
    const declaration = stageDeclaredPack(root, tmp);
    return evaluateStagedDepositClosure(tmp, declaration.paths);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return {
      code: EXIT_CONFIG,
      message: "verify_deposit_closure: " + reason + "\n  " + REMEDIATION,
      stream: "stderr",
      missing: [],
      checked: 0,
    };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

export function evaluateDepositClosureAtRoot(
  root: string,
  packRootExplicit: boolean,
): StagedDepositClosureResult {
  if (packRootExplicit) {
    const declarationPath = resolveDeclarationFile(root);
    if (declarationPath === null) {
      return {
        code: EXIT_CONFIG,
        message:
          "verify_deposit_closure: C1 declaration missing under the given pack root.\n  Recovery: stage contracts/deposit-required-paths.json with the pack (#3601 C1).",
        stream: "stderr",
        missing: [],
        checked: 0,
      };
    }
    try {
      const declaration = loadDepositRequiredDeclaration(declarationPath);
      return evaluateStagedDepositClosure(root, declaration.paths);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      return {
        code: EXIT_CONFIG,
        message: "verify_deposit_closure: " + reason + "\n  " + REMEDIATION,
        stream: "stderr",
        missing: [],
        checked: 0,
      };
    }
  }
  return evaluateDepositClosureFromRepo(root);
}
