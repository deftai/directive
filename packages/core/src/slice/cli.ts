import { fileURLToPath } from "node:url";
import {
  consumeWaveFlags,
  DEFAULT_ACTOR,
  DEFAULT_EXPECTED_CLOSE_SIGNAL,
  type RecordExistingArgs,
  runList,
  runRecordExisting,
} from "./existing.js";

export interface ParsedCli {
  readonly command: "record-existing" | "list";
  readonly recordArgs?: RecordExistingArgs;
  readonly waveMap: Map<number, number[]>;
  readonly listProjectRoot?: string | null;
  readonly listAsJson?: boolean;
  readonly error?: string;
}

function parseFlagValue(
  argv: string[],
  index: number,
  prefix: string,
): { value: string; next: number } | null {
  const arg = argv[index];
  if (arg === prefix) {
    const value = argv[index + 1];
    if (value === undefined) {
      return null;
    }
    return { value, next: index + 2 };
  }
  if (arg?.startsWith(`${prefix}=`)) {
    return { value: arg.slice(prefix.length + 1), next: index + 1 };
  }
  return undefined as unknown as null;
}

function parseRecordExisting(argv: string[]): { args: RecordExistingArgs; error?: string } {
  const parsed = {
    umbrella: 0,
    children: "",
    actor: DEFAULT_ACTOR,
    expectedCloseSignal: DEFAULT_EXPECTED_CLOSE_SIGNAL,
    slicedAt: null as string | null,
    notes: null as string | null,
    dryRun: false,
    force: false,
    skipValidation: false,
    repo: null as string | null,
    projectRoot: null as string | null,
  };
  let hasUmbrella = false;
  let hasChildren = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--dry-run") {
      parsed.dryRun = true;
    } else if (arg === "--force") {
      parsed.force = true;
    } else if (arg === "--skip-validation") {
      parsed.skipValidation = true;
    } else if (arg === "--json") {
      return { args: parsed, error: "unrecognized arguments: --json" };
    } else {
      const umbrella = parseFlagValue(argv, i, "--umbrella");
      if (umbrella !== null && umbrella !== undefined) {
        if (umbrella === null) {
          return { args: parsed, error: "argument --umbrella: expected one argument" };
        }
        parsed.umbrella = Number.parseInt(umbrella.value, 10);
        hasUmbrella = true;
        i = umbrella.next - 1;
        continue;
      }
      const children = parseFlagValue(argv, i, "--children");
      if (children !== null && children !== undefined) {
        if (children === null) {
          return { args: parsed, error: "argument --children: expected one argument" };
        }
        parsed.children = children.value;
        hasChildren = true;
        i = children.next - 1;
        continue;
      }
      const actor = parseFlagValue(argv, i, "--actor");
      if (actor !== null && actor !== undefined) {
        if (actor === null) {
          return { args: parsed, error: "argument --actor: expected one argument" };
        }
        parsed.actor = actor.value;
        i = actor.next - 1;
        continue;
      }
      const signal = parseFlagValue(argv, i, "--expected-close-signal");
      if (signal !== null && signal !== undefined) {
        if (signal === null) {
          return { args: parsed, error: "argument --expected-close-signal: expected one argument" };
        }
        parsed.expectedCloseSignal = signal.value;
        i = signal.next - 1;
        continue;
      }
      const slicedAt = parseFlagValue(argv, i, "--sliced-at");
      if (slicedAt !== null && slicedAt !== undefined) {
        if (slicedAt === null) {
          return { args: parsed, error: "argument --sliced-at: expected one argument" };
        }
        parsed.slicedAt = slicedAt.value;
        i = slicedAt.next - 1;
        continue;
      }
      const notes = parseFlagValue(argv, i, "--notes");
      if (notes !== null && notes !== undefined) {
        if (notes === null) {
          return { args: parsed, error: "argument --notes: expected one argument" };
        }
        parsed.notes = notes.value;
        i = notes.next - 1;
        continue;
      }
      const repo = parseFlagValue(argv, i, "--repo");
      if (repo !== null && repo !== undefined) {
        if (repo === null) {
          return { args: parsed, error: "argument --repo: expected one argument" };
        }
        parsed.repo = repo.value;
        i = repo.next - 1;
        continue;
      }
      const projectRoot = parseFlagValue(argv, i, "--project-root");
      if (projectRoot !== null && projectRoot !== undefined) {
        if (projectRoot === null) {
          return { args: parsed, error: "argument --project-root: expected one argument" };
        }
        parsed.projectRoot = projectRoot.value;
        i = projectRoot.next - 1;
        continue;
      }
      if (arg === "-h" || arg === "--help") {
        return { args: parsed, error: "help" };
      }
      return { args: parsed, error: `unrecognized arguments: ${arg}` };
    }
  }

  if (!hasUmbrella) {
    return { args: parsed, error: "the following arguments are required: --umbrella" };
  }
  if (!hasChildren) {
    return { args: parsed, error: "the following arguments are required: --children" };
  }
  return { args: parsed };
}

function parseList(argv: string[]): {
  projectRoot: string | null;
  asJson: boolean;
  error?: string;
} {
  let projectRoot: string | null = null;
  let asJson = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--json") {
      asJson = true;
      continue;
    }
    const root = parseFlagValue(argv, i, "--project-root");
    if (root !== null && root !== undefined) {
      if (root === null) {
        return { projectRoot, asJson, error: "argument --project-root: expected one argument" };
      }
      projectRoot = root.value;
      i = root.next - 1;
      continue;
    }
    if (arg === "-h" || arg === "--help") {
      return { projectRoot, asJson, error: "help" };
    }
    return { projectRoot, asJson, error: `unrecognized arguments: ${arg}` };
  }
  return { projectRoot, asJson };
}

/** Parse argv mirroring slice_record_existing.py argparse surface. */
export function parseCli(argv: string[]): ParsedCli {
  let raw = [...argv];
  if (raw.length > 0 && !["record-existing", "list", "-h", "--help"].includes(raw[0] ?? "")) {
    raw = ["record-existing", ...raw];
  } else if (raw.length === 0) {
    raw = ["record-existing"];
  }

  let waveMap = new Map<number, number[]>();
  if (raw[0] === "record-existing") {
    try {
      const consumed = consumeWaveFlags(raw);
      waveMap = consumed.waveMap;
      raw = consumed.remaining;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        command: "record-existing",
        waveMap,
        error: `error: ${msg}`,
      };
    }
  }

  const command = raw[0];
  if (command === "-h" || command === "--help") {
    return { command: "record-existing", waveMap, error: "help" };
  }
  if (command === "list") {
    const parsed = parseList(raw.slice(1));
    if (parsed.error !== undefined) {
      return { command: "list", waveMap, error: parsed.error };
    }
    return {
      command: "list",
      waveMap,
      listProjectRoot: parsed.projectRoot,
      listAsJson: parsed.asJson,
    };
  }

  const parsed = parseRecordExisting(raw.slice(1));
  if (parsed.error !== undefined) {
    return { command: "record-existing", waveMap, error: parsed.error };
  }
  return { command: "record-existing", recordArgs: parsed.args, waveMap };
}

/** Run slice CLI and return exit code + captured output. */
export function runCli(argv: string[]): { exitCode: number; stdout: string; stderr: string } {
  const parsed = parseCli(argv);
  if (parsed.error !== undefined) {
    if (parsed.error === "help") {
      return { exitCode: 0, stdout: "", stderr: "" };
    }
    if (parsed.error.startsWith("error: ")) {
      return { exitCode: 2, stdout: "", stderr: `${parsed.error}\n` };
    }
    return { exitCode: 2, stdout: "", stderr: `error: ${parsed.error}\n` };
  }

  if (parsed.command === "list") {
    const result = runList({
      projectRoot: parsed.listProjectRoot ?? null,
      asJson: parsed.listAsJson ?? false,
    });
    return result;
  }

  if (parsed.recordArgs === undefined) {
    return { exitCode: 2, stdout: "", stderr: "error: missing record-existing arguments\n" };
  }

  const result = runRecordExisting(parsed.recordArgs, parsed.waveMap);
  return result;
}

/** CLI entrypoint writing directly to stdio. */
export function main(argv: string[]): number {
  const result = runCli(argv);
  if (result.stdout.length > 0) {
    process.stdout.write(result.stdout);
  }
  if (result.stderr.length > 0) {
    process.stderr.write(result.stderr);
  }
  return result.exitCode;
}

export const CLI_HELP =
  "usage: slice_record_existing.py [-h] {record-existing,list} ... (ported TS CLI)";

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exit(main(process.argv.slice(2)));
}
