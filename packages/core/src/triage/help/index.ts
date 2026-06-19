import { registryData } from "./registry-data.js";

export interface VerbHelp {
  readonly name: string;
  readonly summary: string;
  readonly refs: string;
  readonly description: string;
  readonly usage: string;
  readonly flags: ReadonlyArray<readonly [string, string, string]>;
  readonly examples: readonly string[];
  readonly see_also: readonly string[];
  readonly placeholder: boolean;
}

export const REGISTRY: Readonly<Record<string, VerbHelp>> = registryData.registry;

export const CATEGORIES_TRIAGE: ReadonlyArray<readonly [string, readonly string[]]> =
  registryData.categoriesTriage as ReadonlyArray<readonly [string, readonly string[]]>;

export const CATEGORIES_SCOPE: ReadonlyArray<readonly [string, readonly string[]]> =
  registryData.categoriesScope as ReadonlyArray<readonly [string, readonly string[]]>;

export const SCRIPT_SUBCOMMAND_MAP: Readonly<Record<string, Readonly<Record<string, string>>>> =
  registryData.scriptSubcommandMap as Readonly<Record<string, Readonly<Record<string, string>>>>;

export const HELP_FLAGS = ["--help", "-h"] as const;

const USAGE = `usage: python -m scripts.triage_help <triage|scope|help <verb>|list>

  triage              Print the categorized triage verb list.
  scope               Print the categorized scope verb list.
  help <verb>         Print structured help for a single verb.
                      Accepts both 'task triage:queue' and 'triage:queue'.
  list                Print every registered verb (tooling discovery).
`;

function formatCategoryRow(verb: string, entry: VerbHelp, summaryCol = 60): string {
  const prefix = `  ${verb.padEnd(28, " ")}`;
  let middle = entry.summary;
  if (middle.length > summaryCol) {
    middle = `${middle.slice(0, summaryCol - 1)}…`;
  }
  const padded = middle.padEnd(summaryCol, " ");
  return `${prefix}${padded} ${entry.refs}`;
}

export function renderCategoryList(category: string): string {
  if (category === "triage") {
    const title = "Task triage — operator-facing cache verbs";
    const sections = CATEGORIES_TRIAGE;
    const suffix =
      "Run any verb with --help for usage examples (e.g. " + "`task triage:queue --help`).";
    const lines: string[] = [title, ""];
    for (const [label, verbs] of sections) {
      lines.push(`${label}:`);
      for (const verb of verbs) {
        const entry = REGISTRY[verb];
        if (entry === undefined) {
          lines.push(`  ${verb.padEnd(28, " ")}(missing registry entry)`);
          continue;
        }
        lines.push(formatCategoryRow(verb, entry));
      }
      lines.push("");
    }
    lines.push(suffix);
    return lines.join("\n");
  }
  if (category === "scope") {
    const title = "Task scope — vBRIEF lifecycle verbs";
    const sections = CATEGORIES_SCOPE;
    const suffix =
      "Run any verb with --help for usage examples (e.g. " + "`task scope:promote --help`).";
    const lines: string[] = [title, ""];
    for (const [label, verbs] of sections) {
      lines.push(`${label}:`);
      for (const verb of verbs) {
        const entry = REGISTRY[verb];
        if (entry === undefined) {
          lines.push(`  ${verb.padEnd(28, " ")}(missing registry entry)`);
          continue;
        }
        lines.push(formatCategoryRow(verb, entry));
      }
      lines.push("");
    }
    lines.push(suffix);
    return lines.join("\n");
  }
  throw new Error(`unknown category ${JSON.stringify(category)}; expected 'triage' or 'scope'`);
}

export function renderVerbHelp(verb: string): string {
  const entry = REGISTRY[verb];
  if (entry === undefined) {
    throw new Error(
      `unknown verb ${JSON.stringify(verb)}; not in scripts/triage_help.py REGISTRY. ` +
        "Run `task triage` or `task scope` to see the catalog.",
    );
  }

  const lines: string[] = [];
  const header = `${entry.name} -- ${entry.summary} ${entry.refs}`.trimEnd();
  lines.push(header);
  if (entry.placeholder) {
    lines.push("  (not yet implemented -- placeholder entry; see refs)");
  }
  lines.push("");
  lines.push(entry.description);
  lines.push("");
  lines.push("Usage:");
  lines.push(`  ${entry.usage}`);
  if (entry.flags.length > 0) {
    lines.push("");
    lines.push("Flags:");
    const flagWidth = Math.min(Math.max(...entry.flags.map(([f]) => f.length)), 32);
    for (const [flag, def, desc] of entry.flags) {
      const head = `  ${flag.padEnd(flagWidth, " ")}`;
      const tail = def ? `${desc} (default: ${def})` : desc;
      lines.push(`${head}  ${tail}`);
    }
  }
  if (entry.examples.length > 0) {
    lines.push("");
    lines.push("Examples:");
    for (const ex of entry.examples) {
      lines.push(`  ${ex}`);
    }
  }
  if (entry.see_also.length > 0) {
    lines.push("");
    lines.push("See also:");
    for (const ref of entry.see_also) {
      lines.push(`  ${ref}`);
    }
  }
  return lines.join("\n");
}

function hasHelpFlag(argv: readonly string[]): boolean {
  return argv.some((arg) => (HELP_FLAGS as readonly string[]).includes(arg));
}

export function resolveVerbFromArgv(scriptName: string, argv: readonly string[]): string | null {
  const subMap = SCRIPT_SUBCOMMAND_MAP[scriptName];
  if (subMap === undefined) {
    return null;
  }
  const keys = Object.keys(subMap);
  if ("__default__" in subMap && keys.length === 1) {
    return subMap.__default__ ?? null;
  }
  for (const arg of argv) {
    if (!arg.startsWith("-")) {
      const verb = subMap[arg];
      if (verb !== undefined) {
        return verb;
      }
    }
  }
  return subMap.__default__ ?? null;
}

export function interceptHelp(
  scriptName: string,
  argv?: readonly string[] | null,
  out?: { write: (text: string) => void },
): number | null {
  const args = argv !== null && argv !== undefined ? [...argv] : [];
  if (!hasHelpFlag(args)) {
    return null;
  }

  const verb = resolveVerbFromArgv(scriptName, args);
  const sink = out ?? { write: (t: string) => process.stdout.write(t) };
  if (verb === null || REGISTRY[verb] === undefined) {
    return null;
  }
  try {
    sink.write(`${renderVerbHelp(verb)}\n`);
  } catch (exc: unknown) {
    sink.write(`triage_help: ${String(exc)}\n`);
    return 2;
  }
  return 0;
}

function normalizeVerbArg(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.startsWith("task ")) {
    return trimmed;
  }
  return `task ${trimmed}`;
}

/** CLI dispatcher mirroring triage_help.main(). */
export function runHelp(argv: readonly string[]): number {
  if (argv.length === 0) {
    process.stderr.write(USAGE);
    return 2;
  }
  const [head, ...rest] = argv;
  if (head === "-h" || head === "--help") {
    process.stdout.write(USAGE);
    return 0;
  }
  if (head === "triage") {
    process.stdout.write(`${renderCategoryList("triage")}\n`);
    return 0;
  }
  if (head === "scope") {
    process.stdout.write(`${renderCategoryList("scope")}\n`);
    return 0;
  }
  if (head === "list") {
    for (const verb of Object.keys(REGISTRY).sort()) {
      const entry = REGISTRY[verb];
      if (entry === undefined) continue;
      const tag = entry.placeholder ? " [coming]" : "";
      process.stdout.write(`${verb}${tag}\n`);
    }
    return 0;
  }
  if (head === "help") {
    if (rest.length === 0) {
      process.stderr.write("triage_help: missing <verb> argument for `help`.\n");
      process.stderr.write(USAGE);
      return 2;
    }
    const first = rest[0];
    if (first === undefined) {
      process.stderr.write("triage_help: missing <verb> argument for `help`.\n");
      process.stderr.write(USAGE);
      return 2;
    }
    const verb = normalizeVerbArg(first);
    if (REGISTRY[verb] === undefined) {
      process.stderr.write(
        `triage_help: unknown verb ${JSON.stringify(verb)}. ` +
          "Run `python -m scripts.triage_help list` to see all registered verbs.\n",
      );
      return 2;
    }
    process.stdout.write(`${renderVerbHelp(verb)}\n`);
    return 0;
  }
  process.stderr.write(`triage_help: unknown command ${JSON.stringify(head)}.\n`);
  process.stderr.write(USAGE);
  return 2;
}
