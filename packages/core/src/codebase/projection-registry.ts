import { sortedStringifyPretty } from "./json.js";

export const CODEBASE_MAP_KIND = "codebase-map";
export const CODEBASE_MAP_FORMAT_VERSION = "codebase-map.v1";
export const CODEBASE_PROVIDER_CONTRACT_VERSION = "codebase-provider.v1";

export interface ProjectionKind {
  readonly kind: string;
  readonly artifact_format_version: string;
  readonly provider_contract_version: string;
  readonly output_role: string;
  readonly generate_action: string;
  readonly freshness_action: string;
  readonly description: string;
}

const REGISTRY: readonly ProjectionKind[] = [
  {
    kind: CODEBASE_MAP_KIND,
    artifact_format_version: CODEBASE_MAP_FORMAT_VERSION,
    provider_contract_version: CODEBASE_PROVIDER_CONTRACT_VERSION,
    output_role: "architecture-map",
    generate_action: "generate-codebase-map",
    freshness_action: "verify-codebase-map-freshness",
    description:
      "Generated codebase orientation map derived from authored " +
      "codeStructure metadata plus code-derived facts.",
  },
];

/** Return registered projection kinds in deterministic order. */
export function listProjectionKinds(): ProjectionKind[] {
  return [...REGISTRY].sort((a, b) => a.kind.localeCompare(b.kind));
}

/** Resolve one projection kind or throw with a useful message. */
export function resolveProjectionKind(kind: string): ProjectionKind {
  for (const entry of REGISTRY) {
    if (entry.kind === kind) {
      return entry;
    }
  }
  const known = listProjectionKinds()
    .map((entry) => entry.kind)
    .join(", ");
  throw new Error(`unknown projection kind '${kind}'; known kinds: ${known || "<none>"}`);
}

export function projectionKindToDict(entry: ProjectionKind): Record<string, string> {
  return {
    kind: entry.kind,
    artifact_format_version: entry.artifact_format_version,
    provider_contract_version: entry.provider_contract_version,
    output_role: entry.output_role,
    generate_action: entry.generate_action,
    freshness_action: entry.freshness_action,
    description: entry.description,
  };
}

export interface ProjectionRegistryCliResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** CLI entry point for registry inspection. */
export function runProjectionRegistryCli(argv: string[]): ProjectionRegistryCliResult {
  let list = false;
  let kind: string | undefined;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--list") {
      list = true;
    } else if (arg === "--kind") {
      const value = argv[i + 1];
      if (value === undefined) {
        return { exitCode: 2, stdout: "", stderr: "argument --kind: expected one argument\n" };
      }
      kind = value;
      i += 1;
    } else if (arg?.startsWith("--kind=")) {
      kind = arg.slice("--kind=".length);
    } else if (arg === "--help" || arg === "-h") {
      return {
        exitCode: 0,
        stdout:
          "usage: projection-registry [--list] [--kind KIND]\n" +
          "Inspect codebase projection kinds.\n",
        stderr: "",
      };
    }
  }

  if (list) {
    const payload = listProjectionKinds().map(projectionKindToDict);
    return { exitCode: 0, stdout: sortedStringifyPretty(payload), stderr: "" };
  }

  if (kind !== undefined) {
    try {
      const payload = projectionKindToDict(resolveProjectionKind(kind));
      return { exitCode: 0, stdout: sortedStringifyPretty(payload), stderr: "" };
    } catch (err) {
      return { exitCode: 1, stdout: "", stderr: `${String(err)}\n` };
    }
  }

  return {
    exitCode: 0,
    stdout:
      "usage: projection-registry [--list] [--kind KIND]\n" +
      "Inspect codebase projection kinds.\n",
    stderr: "",
  };
}
