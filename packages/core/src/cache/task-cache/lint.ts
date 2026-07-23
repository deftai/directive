import type { RegistryLintFinding, TaskContract, TaskInputSpec } from "./types.js";

/** Strip trailing `*` glob wildcards without regex (CodeQL ReDoS-safe). */
function stripTrailingGlobStars(pattern: string): string {
  let end = pattern.length;
  while (end > 0 && pattern[end - 1] === "*") {
    end--;
  }
  return pattern.slice(0, end);
}

function diffSpec(superset: TaskInputSpec, declared: TaskInputSpec): string[] {
  const findings: string[] = [];
  for (const glob of superset.globs ?? []) {
    const covered = (declared.globs ?? []).some(
      (decl) => decl === glob || glob.startsWith(stripTrailingGlobStars(decl)),
    );
    if (!covered) {
      findings.push(`glob '${glob}' missing from declared inputs`);
    }
  }
  for (const envKey of superset.env ?? []) {
    if (!(declared.env ?? []).includes(envKey)) {
      findings.push(`env '${envKey}' missing from declared inputs`);
    }
  }
  return findings;
}

export function lintTaskContract(contract: TaskContract): RegistryLintFinding[] {
  const findings: RegistryLintFinding[] = [];
  if (!contract.knownReadSet) {
    return findings;
  }
  const missing = diffSpec(contract.knownReadSet, contract.inputs);
  for (const detail of missing) {
    if (contract.cacheable) {
      findings.push({
        taskId: contract.id,
        kind: "under-declared-input",
        detail,
      });
    } else {
      findings.push({
        taskId: contract.id,
        kind: "non-cacheable",
        detail: `${detail} (task marked non-cacheable)`,
      });
    }
  }
  return findings;
}

export function lintTaskRegistry(contracts: readonly TaskContract[]): RegistryLintFinding[] {
  const all: RegistryLintFinding[] = [];
  for (const contract of contracts) {
    all.push(...lintTaskContract(contract));
  }
  return all;
}
