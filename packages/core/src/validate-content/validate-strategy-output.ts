import { existsSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  hasArtifactSuffix,
  resolveLifecycleLayout,
  resolveProjectDefinitionPath,
} from "../layout/resolve.js";
import { checkSpecMigrationFidelity } from "../spec-authority/migration-fidelity.js";
import { isFullSpecState } from "../spec-authority/resolver.js";
import { isDatePrefixedVbriefFilename } from "./filename.js";
import type { EvaluateResult } from "./types.js";

const LIFECYCLE_DIRS = ["proposed", "pending", "active", "completed", "cancelled"] as const;

function isDirSafe(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function isDeftFrameworkRoot(projectRoot: string): boolean {
  // Post-#1875 content/ move: the strategies/ marker lives under content/ in
  // the SOURCE repo (the C1 flatten strips that prefix in a consumer deposit,
  // where neither location exists). Accept either layout and never throw on a
  // missing dir -- consumers legitimately have no strategies/ at all.
  return (
    existsSync(join(projectRoot, "AGENTS.md")) &&
    existsSync(join(projectRoot, "Taskfile.yml")) &&
    (isDirSafe(join(projectRoot, "content", "strategies")) ||
      isDirSafe(join(projectRoot, "strategies")))
  );
}

/** Pure validator returning error strings (empty == pass). */
export function validateStrategyOutput(projectRoot: string, strict = false): string[] {
  const root = resolve(projectRoot);
  const errors: string[] = [];
  // Layout-aware (#2109 part 2a): resolve the lifecycle dir/suffix dynamically;
  // identical to vbrief/ on today's tree.
  let layout: ReturnType<typeof resolveLifecycleLayout>;
  try {
    layout = resolveLifecycleLayout(root);
  } catch {
    if (strict) {
      errors.push(
        "xbrief/ directory missing entirely. v0.20 strategies must emit at least " +
          "xbrief/proposed/ (with date-prefixed files) + PROJECT-DEFINITION.xbrief.json.",
      );
    }
    return errors;
  }
  const vbriefDir = layout.root;

  if (!existsSync(vbriefDir)) {
    if (strict) {
      errors.push(
        "vbrief/ directory missing entirely. v0.20 strategies must emit at least " +
          "vbrief/proposed/ (with date-prefixed files) + PROJECT-DEFINITION.vbrief.json.",
      );
    }
    return errors;
  }

  const projDef = resolveProjectDefinitionPath(root);
  if (!existsSync(projDef)) {
    errors.push(
      `Missing ${layout.artifactDir}/PROJECT-DEFINITION${layout.artifactSuffix}. ` +
        "All v0.20-conformant strategy output must include a complete project definition " +
        "(see v0-20-contract.md and task project:render).",
    );
  }

  // The legacy-spec guard intentionally stays pinned to the literal legacy
  // path (#2109 part 2a): its job is to detect a stranded pre-v0.20
  // vbrief/specification.vbrief.json, which is a legacy artifact regardless of
  // the active layout -- routing it through the resolver would make it
  // self-cancelling once an xbrief tree is live.
  const specLegacy = join(root, "vbrief", "specification.vbrief.json");
  if (existsSync(specLegacy) && !isDeftFrameworkRoot(root) && !isFullSpecState(root)) {
    errors.push(
      "Legacy artifact vbrief/specification.vbrief.json present. " +
        "v0.20 strategies MUST NOT dual-write the old specification.vbrief.json " +
        "alongside scope vBRIEFs in the lifecycle folders. " +
        "See strategies/v0-20-contract.md (contract) and issue #1166.",
    );
  }

  for (const dname of LIFECYCLE_DIRS) {
    const dpath = join(vbriefDir, dname);
    if (!existsSync(dpath) || !statSync(dpath).isDirectory()) continue;
    for (const name of readdirSync(dpath).sort()) {
      if (!hasArtifactSuffix(name)) continue;
      if (!isDatePrefixedVbriefFilename(name)) {
        errors.push(
          `Non-conformant filename in vbrief/${dname}/: ${name}. ` +
            "v0.20 requires strict YYYY-MM-DD-<slug>.vbrief.json " +
            "(date prefix from creation). Bare names (e.g. scaffold.vbrief.json) " +
            "are pre-v0.20. See strategies/v0-20-contract.md and " +
            "vbrief/vbrief.md filename convention.",
        );
      }
    }
  }

  errors.push(...checkSpecMigrationFidelity(root));

  return errors;
}

export interface StrategyOutputOptions {
  readonly projectRoot?: string;
  readonly strict?: boolean;
  readonly quiet?: boolean;
}

const FAILURE_HEADER = "❌ Strategy output shape validation FAILED (v0.20 contract gate)";
const FAILURE_FOOTER = [
  "",
  "Reference: strategies/v0-20-contract.md (once landed) + " +
    "https://github.com/deftai/directive/issues/1166 (s2-deterministic-gate)",
  "Fix: re-run the emitting strategy after the contract migration " +
    "stories land, or run `task migrate:vbrief` + `task project:render` " +
    "+ `task scope:promote` as appropriate.",
].join("\n");

/** CLI-shaped evaluator mirroring `scripts/validate_strategy_output.py::main`. */
export function evaluate(options: StrategyOutputOptions = {}): EvaluateResult {
  const projectRoot = resolve(options.projectRoot ?? ".");
  const errors = validateStrategyOutput(projectRoot, options.strict ?? false);

  if (errors.length > 0) {
    const lines = [FAILURE_HEADER];
    for (const err of errors) {
      lines.push(`  • ${err}`);
    }
    lines.push(FAILURE_FOOTER);
    return { code: 1, message: lines.join("\n"), stream: "stderr" };
  }

  if (options.quiet) {
    return { code: 0, message: "", stream: "none" };
  }
  return {
    code: 0,
    message: "✓ Strategy output shape conforms to v0.20 contract",
    stream: "stdout",
  };
}
