import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parsePhase2NarrativeDocument } from "../vbrief-build/phase2-narratives.js";
import { storePhase2Narratives } from "./project-render.js";

const USAGE =
  "Usage: project-write-narratives --narratives-file <path> [--title <text>] [--project-root <dir>]\n";

interface ParsedCli {
  readonly projectRoot: string;
  readonly narrativesFile: string | undefined;
  readonly title: string | undefined;
  readonly error: string | undefined;
}

function parseCli(argv: readonly string[]): ParsedCli {
  let projectRoot = ".";
  let narrativesFile: string | undefined;
  let title: string | undefined;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] as string;
    if (arg === "--project-root") {
      const value = argv[i + 1];
      if (value === undefined) return blank("missing value for --project-root");
      projectRoot = value;
      i += 1;
    } else if (arg.startsWith("--project-root=")) {
      projectRoot = arg.slice("--project-root=".length);
    } else if (arg === "--narratives-file") {
      const value = argv[i + 1];
      if (value === undefined) return blank("missing value for --narratives-file");
      narrativesFile = value;
      i += 1;
    } else if (arg.startsWith("--narratives-file=")) {
      narrativesFile = arg.slice("--narratives-file=".length);
    } else if (arg === "--title") {
      const value = argv[i + 1];
      if (value === undefined) return blank("missing value for --title");
      title = value;
      i += 1;
    } else if (arg.startsWith("--title=")) {
      title = arg.slice("--title=".length);
    } else {
      return blank(`Unknown flag: ${arg}`);
    }
  }
  return { projectRoot, narrativesFile, title, error: undefined };
}

function blank(error: string): ParsedCli {
  return { projectRoot: ".", narrativesFile: undefined, title: undefined, error };
}

/** CLI for `project:write-narratives` (#4663). */
export function writePhase2NarrativesMain(argv: readonly string[]): number {
  if (argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(USAGE);
    return 0;
  }
  const parsed = parseCli(argv);
  if (parsed.error !== undefined) {
    process.stderr.write(`${parsed.error}\n${USAGE}`);
    return 2;
  }
  if (parsed.narrativesFile === undefined || parsed.narrativesFile.length === 0) {
    process.stderr.write(`missing --narratives-file\n${USAGE}`);
    return 2;
  }

  let raw: string;
  try {
    raw = readFileSync(parsed.narrativesFile, "utf8");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`could not read narratives file: ${message}\n`);
    return 2;
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`narratives file is not valid JSON: ${message}\n`);
    return 2;
  }
  const document = parsePhase2NarrativeDocument(json);
  if ("error" in document) {
    process.stderr.write(`${document.error}\n`);
    return 2;
  }
  const title = parsed.title !== undefined ? parsed.title : document.title;
  const [ok, message] = storePhase2Narratives(resolve(parsed.projectRoot), {
    narratives: document.narratives,
    ...(title !== undefined ? { title } : {}),
  });
  if (!ok) {
    process.stderr.write(`${message}\n`);
    return 1;
  }
  process.stdout.write(`${message}\n`);
  return 0;
}
