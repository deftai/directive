import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import {
  CodeStructureConfigError,
  configErrorToDict,
  defaultCodeStructurePath,
} from "./default-extractor.js";
import { sortedStringifyPretty } from "./json.js";
import { GENERATED_SENTINEL, projectionOutputPath, renderCodebaseMap } from "./map.js";
import { selectCodebaseMap } from "./provider.js";

export function checkCodebaseMapFresh(
  projectRoot: string,
  options: {
    outputPath: string;
    artifactPath?: string | null;
  },
): string[] {
  const resolvedOutput = isAbsolute(options.outputPath)
    ? options.outputPath
    : join(projectRoot, options.outputPath);
  // #1932: the generated MAP is an on-demand, gitignored artifact. An absent
  // projection is OK (advisory) -- the gate must not force per-branch regeneration
  // + commit, which guaranteed mechanical MAP.md collisions across concurrent
  // branches. When a MAP IS present locally the freshness check below still flags
  // it if stale; the durable plan.architecture.codeStructure stays gated by
  // codebase:validate-structure.
  if (!existsSync(resolvedOutput)) {
    return [];
  }

  let current: string;
  try {
    current = readFileSync(resolvedOutput, { encoding: "utf8" });
  } catch (err) {
    return [`generated codebase MAP could not be read: ${String(err)}`];
  }
  if (!current.slice(0, 4096).includes(GENERATED_SENTINEL)) {
    return [`generated codebase MAP lacks the '${GENERATED_SENTINEL}' banner: ${resolvedOutput}`];
  }

  // Freshness tracks durable provider policy/artifact paths only; one-off
  // `--generate-with` commands are intentionally not replayed by this gate.
  const selection = selectCodebaseMap(projectRoot, null, { artifactPath: options.artifactPath });
  const expected = renderCodebaseMap(selection.artifact);
  if (current !== expected) {
    return [
      `generated codebase MAP is stale; run \`task codebase:map\` to refresh ${resolvedOutput}`,
    ];
  }
  return [];
}

export interface CodebaseMapFreshCliResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export function runCodebaseMapFreshCli(argv: string[]): CodebaseMapFreshCliResult {
  let projectRoot = ".";
  let output: string | undefined;
  let artifactPath: string | undefined;
  let json = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--project-root") {
      const value = argv[i + 1];
      if (value === undefined) {
        return {
          exitCode: 2,
          stdout: "",
          stderr: "argument --project-root: expected one argument\n",
        };
      }
      projectRoot = value;
      i += 1;
    } else if (arg?.startsWith("--project-root=")) {
      projectRoot = arg.slice("--project-root=".length);
    } else if (arg === "--output") {
      const value = argv[i + 1];
      if (value === undefined) {
        return { exitCode: 2, stdout: "", stderr: "argument --output: expected one argument\n" };
      }
      output = value;
      i += 1;
    } else if (arg?.startsWith("--output=")) {
      output = arg.slice("--output=".length);
    } else if (arg === "--artifact-path") {
      const value = argv[i + 1];
      if (value === undefined) {
        return {
          exitCode: 2,
          stdout: "",
          stderr: "argument --artifact-path: expected one argument\n",
        };
      }
      artifactPath = value;
      i += 1;
    } else if (arg?.startsWith("--artifact-path=")) {
      artifactPath = arg.slice("--artifact-path=".length);
    } else if (arg === "--json") {
      json = true;
    }
  }

  const root = resolve(projectRoot);
  let outputPath: string;
  let errors: string[];
  try {
    outputPath = projectionOutputPath(root, output);
    errors = checkCodebaseMapFresh(root, { outputPath, artifactPath });
  } catch (err) {
    if (err instanceof CodeStructureConfigError || err instanceof Error) {
      const payload = sortedStringifyPretty(configErrorToDict(defaultCodeStructurePath(root), err));
      if (json) {
        return { exitCode: 2, stdout: payload, stderr: "" };
      }
      return { exitCode: 2, stdout: "", stderr: `${String(err)}\n` };
    }
    throw err;
  }

  const resolvedOutput = isAbsolute(outputPath) ? outputPath : join(root, outputPath);
  if (json) {
    return {
      exitCode: errors.length > 0 ? 1 : 0,
      stdout: sortedStringifyPretty({
        ok: errors.length === 0,
        path: resolvedOutput,
        errors,
      }),
      stderr: "",
    };
  }
  if (errors.length > 0) {
    return {
      exitCode: 1,
      stdout: "",
      stderr: `${errors.map((error) => `Error: ${error}`).join("\n")}\n`,
    };
  }
  return { exitCode: 0, stdout: "OK: generated codebase MAP is fresh\n", stderr: "" };
}
