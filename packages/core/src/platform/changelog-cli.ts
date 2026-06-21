import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { evaluateChangelogPath } from "./resolve-changelog-unreleased.js";

function parseChangelogCliArgs(argv: string[]): {
  changelogPath: string;
  dryRun: boolean;
  quiet: boolean;
  error?: string;
} {
  let changelogPath = "CHANGELOG.md";
  let dryRun = false;
  let quiet = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--changelog-path") {
      const v = argv[i + 1];
      if (v === undefined) {
        return { changelogPath, dryRun, quiet, error: "missing --changelog-path value" };
      }
      changelogPath = v;
      i += 1;
    } else if (arg?.startsWith("--changelog-path=")) {
      changelogPath = arg.slice("--changelog-path=".length);
    } else if (arg === "--dry-run") {
      dryRun = true;
    } else if (arg === "--quiet") {
      quiet = true;
    } else {
      return { changelogPath, dryRun, quiet, error: `unrecognized argument: ${arg}` };
    }
  }
  return { changelogPath, dryRun, quiet };
}

/** CLI entry for changelog:resolve-unreleased (mirrors resolve_changelog_unreleased.py). */
export function changelogResolveUnreleasedMain(argv: string[]): number {
  const parsed = parseChangelogCliArgs(argv);
  if (parsed.error !== undefined) {
    process.stderr.write(
      `resolve_changelog_unreleased: ${parsed.error}\n` +
        `Usage: changelog-resolve-unreleased [--changelog-path PATH] [--dry-run] [--quiet]\n`,
    );
    return 2;
  }

  const absPath = resolve(parsed.changelogPath);
  const exists = existsSync(absPath);
  const isFile = exists && statSync(absPath).isFile();

  const [code, message, warnings] = evaluateChangelogPath(absPath, {
    exists,
    isFile,
    readText: () => readFileSync(absPath, "utf8"),
    dryRun: parsed.dryRun,
    writeText: (content) => writeFileSync(absPath, content, "utf8"),
  });

  for (const w of warnings) {
    process.stderr.write(`warning: ${w}\n`);
  }

  if (code === 0) {
    if (!parsed.quiet) {
      process.stdout.write(`${message}\n`);
    }
  } else {
    process.stderr.write(`${message}\n`);
  }
  return code;
}
