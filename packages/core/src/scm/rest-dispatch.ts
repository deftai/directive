import { extractValueFlag, filterJsonFields } from "./argv.js";
import {
  GhRestError,
  type GhRestSeams,
  InvalidRepoError,
  restIssueList,
  restIssueView,
} from "./gh-rest.js";
import { pyRepr, pythonJsonStringify } from "./py-format.js";

function parseJsonFields(jsonSpec: string | null): string[] {
  if (jsonSpec === null || jsonSpec.length === 0) {
    return [];
  }
  return jsonSpec.split(",").map((f) => f.trim());
}

/** Dispatch `scm issue view --rest <N> --repo X [--json fields]`. */
export function runRestView(
  extra: readonly string[],
  seams: GhRestSeams = {},
): {
  exitCode: number;
  stdout: string;
  stderr: string;
} {
  let remainder = [...extra];
  const [repo, afterRepo] = extractValueFlag(remainder, "--repo");
  remainder = afterRepo;
  const [jsonSpec, afterJson] = extractValueFlag(remainder, "--json");
  remainder = afterJson;

  if (repo === null || repo.length === 0) {
    return {
      exitCode: 2,
      stdout: "",
      stderr: "error: --rest issue view requires --repo OWNER/NAME\n",
    };
  }

  const positionals = remainder.filter((t) => !t.startsWith("-"));
  const leftoverFlags = remainder.filter((t) => t.startsWith("-"));
  if (leftoverFlags.length > 0) {
    return {
      exitCode: 2,
      stdout: "",
      stderr:
        `error: --rest issue view does not recognise these flags: ` +
        `${pyRepr(leftoverFlags)}. Supported flags are --repo, --json. ` +
        "Mutations / additional read filters belong on #881.\n",
    };
  }
  if (positionals.length !== 1) {
    return {
      exitCode: 2,
      stdout: "",
      stderr:
        "error: --rest issue view expects exactly one positional issue " +
        `number; got ${pyRepr(positionals)}\n`,
    };
  }
  const issueStr = positionals[0] ?? "";
  const issueN = Number.parseInt(issueStr, 10);
  if (Number.isNaN(issueN) || String(issueN) !== issueStr) {
    return {
      exitCode: 2,
      stdout: "",
      stderr: `error: issue number must be an integer; got ${pyRepr(issueStr)}\n`,
    };
  }

  try {
    const response = restIssueView(repo, issueN, seams);
    const fields = parseJsonFields(jsonSpec);
    const filtered = filterJsonFields(response, fields);
    return {
      exitCode: 0,
      stdout: `${pythonJsonStringify(filtered)}\n`,
      stderr: "",
    };
  } catch (err: unknown) {
    if (err instanceof InvalidRepoError) {
      return {
        exitCode: 2,
        stdout: "",
        stderr: `error: invalid --repo value: ${err.message}\n`,
      };
    }
    if (err instanceof GhRestError) {
      return {
        exitCode: 1,
        stdout: "",
        stderr: `error: ${err.message}\n`,
      };
    }
    throw err;
  }
}

/** Dispatch `scm issue list --rest --repo X [...flags]`. */
export function runRestList(
  extra: readonly string[],
  seams: GhRestSeams = {},
): {
  exitCode: number;
  stdout: string;
  stderr: string;
} {
  let remainder = [...extra];
  const [repo, afterRepo] = extractValueFlag(remainder, "--repo");
  remainder = afterRepo;
  const [state, afterState] = extractValueFlag(remainder, "--state", "open");
  remainder = afterState;
  const [jsonSpec, afterJson] = extractValueFlag(remainder, "--json");
  remainder = afterJson;
  const [author, afterAuthor] = extractValueFlag(remainder, "--author");
  remainder = afterAuthor;

  const labelValues: string[] = [];
  while (true) {
    const [labelPart, afterLabel] = extractValueFlag(remainder, "--label");
    if (labelPart === null) {
      break;
    }
    labelValues.push(labelPart);
    remainder = afterLabel;
  }

  const [limitStr, afterLimit] = extractValueFlag(remainder, "--limit", "30");
  remainder = afterLimit;

  const leftoverFlags = remainder.filter((t) => t.startsWith("-"));
  if (leftoverFlags.length > 0) {
    return {
      exitCode: 2,
      stdout: "",
      stderr:
        `error: --rest issue list does not recognise these flags: ` +
        `${pyRepr(leftoverFlags)}. Supported flags are --repo, --state, ` +
        "--label, --author, --limit, --json. Additional filters " +
        "belong on #881.\n",
    };
  }

  const leftoverPositionals = remainder.filter((t) => !t.startsWith("-"));
  if (leftoverPositionals.length > 0) {
    return {
      exitCode: 2,
      stdout: "",
      stderr:
        `error: --rest issue list takes no positional arguments; ` +
        `got ${pyRepr(leftoverPositionals)}. Did you mean ` +
        `\`scm.py issue view --rest ${leftoverPositionals[0]} --repo OWNER/NAME\`?\n`,
    };
  }

  if (repo === null || repo.length === 0) {
    return {
      exitCode: 2,
      stdout: "",
      stderr: "error: --rest issue list requires --repo OWNER/NAME\n",
    };
  }

  const perPage = limitStr !== null ? Number.parseInt(limitStr, 10) : 30;
  if (Number.isNaN(perPage)) {
    return {
      exitCode: 2,
      stdout: "",
      stderr: `error: --limit must be an integer; got ${pyRepr(limitStr)}\n`,
    };
  }

  const labels = labelValues.flatMap((value) =>
    value
      .split(",")
      .map((item) => item.trim())
      .filter((item) => item.length > 0),
  );

  try {
    const response = restIssueList(
      repo,
      {
        state: state ?? "open",
        labels,
        author,
        perPage,
      },
      seams,
    );
    const fields = parseJsonFields(jsonSpec);
    const filtered = filterJsonFields(response, fields);
    return {
      exitCode: 0,
      stdout: `${pythonJsonStringify(filtered)}\n`,
      stderr: "",
    };
  } catch (err: unknown) {
    if (err instanceof InvalidRepoError) {
      return {
        exitCode: 2,
        stdout: "",
        stderr: `error: invalid --repo value: ${err.message}\n`,
      };
    }
    if (err instanceof GhRestError) {
      return {
        exitCode: 1,
        stdout: "",
        stderr: `error: ${err.message}\n`,
      };
    }
    throw err;
  }
}
