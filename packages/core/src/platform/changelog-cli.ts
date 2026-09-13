import { lstatSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  ContainedWriteError,
  containedWrite,
  resolveContainedTarget,
} from "../fs/contained-write.js";
import { assertWriteTargetSafe, ProjectionContainmentError } from "../fs/projection-containment.js";
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

function lstatExistsIsFile(absPath: string): { exists: boolean; isFile: boolean } {
  try {
    const st = lstatSync(absPath);
    return { exists: true, isFile: st.isFile() };
  } catch {
    return { exists: false, isFile: false };
  }
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

  const root = resolve(process.cwd());
  let absPath: string;
  try {
    absPath = resolveContainedTarget(root, parsed.changelogPath);
  } catch (err) {
    const detail = err instanceof ContainedWriteError ? err.message : String(err);
    process.stderr.write(
      `config error: --changelog-path is outside the project root (${root}): ${parsed.changelogPath}\n  ${detail}\n`,
    );
    return 2;
  }

  try {
    assertWriteTargetSafe(root, absPath);
  } catch (err) {
    const detail =
      err instanceof ProjectionContainmentError || err instanceof ContainedWriteError
        ? err.message
        : String(err);
    process.stderr.write(
      `config error: CHANGELOG path is not a contained write target: ${detail}\n`,
    );
    return 2;
  }

  const { exists, isFile } = lstatExistsIsFile(absPath);

  const [code, message, warnings] = evaluateChangelogPath(absPath, {
    exists,
    isFile,
    readText: () => readFileSync(absPath, "utf8"),
    dryRun: parsed.dryRun,
    writeText: (content) => {
      containedWrite({
        root,
        target: absPath,
        data: content,
        mode: "replace",
      });
    },
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
