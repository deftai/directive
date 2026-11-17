#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  expandReadinessPaths,
  readinessReport,
  SCAFFOLD_LAUNCH_NOTE,
  type ScaffoldItemAcceptanceInput,
  type ScaffoldNarrativeInput,
  SWARM_BLOCK_REMEDIATION_HINT,
  scaffoldSwarmDraft,
} from "./readiness.js";

type MutableNarratives = {
  -readonly [K in keyof ScaffoldNarrativeInput]: ScaffoldNarrativeInput[K];
};

/** Values-file keys (#6372 item 2): narrative inputs and item acceptance lines only. */
const VALUES_FILE_NARRATIVE_KEYS = {
  Description: "description",
  UserStory: "userStory",
  ImplementationPlan: "implementationPlan",
  Traces: "traces",
  MissingTracesJustification: "missingTracesJustification",
  AcceptanceJustification: "acceptanceJustification",
} as const satisfies Record<string, keyof ScaffoldNarrativeInput>;

/**
 * Read an operator-named values file (#6372). Only narrative inputs and an
 * `ItemAcceptance` map (item id or one-based position -> line) are accepted;
 * paths and commands are never taken from it.
 */
export function readScaffoldValuesFile(path: string):
  | {
      ok: true;
      narratives: MutableNarratives;
      itemAcceptance: ScaffoldItemAcceptanceInput[];
    }
  | { ok: false; error: string } {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
  } catch (err) {
    return {
      ok: false,
      error: `argument --values-file: cannot read JSON at ${path}: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { ok: false, error: "argument --values-file: expected a JSON object" };
  }
  const narratives: MutableNarratives = {};
  const itemAcceptance: ScaffoldItemAcceptanceInput[] = [];
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (key === "ItemAcceptance") {
      if (typeof value !== "object" || value === null || Array.isArray(value)) {
        return {
          ok: false,
          error: "argument --values-file: ItemAcceptance must map an item id or position to a line",
        };
      }
      for (const [selector, text] of Object.entries(value as Record<string, unknown>)) {
        if (typeof text !== "string") {
          return {
            ok: false,
            error: `argument --values-file: ItemAcceptance ${JSON.stringify(selector)} must be a string`,
          };
        }
        itemAcceptance.push({ selector, text });
      }
      continue;
    }
    const inputKey = (VALUES_FILE_NARRATIVE_KEYS as Record<string, keyof ScaffoldNarrativeInput>)[
      key
    ];
    if (inputKey === undefined) {
      return {
        ok: false,
        error: `argument --values-file: unknown key ${JSON.stringify(key)} (allowed: ${[...Object.keys(VALUES_FILE_NARRATIVE_KEYS), "ItemAcceptance"].join(", ")})`,
      };
    }
    if (typeof value !== "string") {
      return { ok: false, error: `argument --values-file: ${key} must be a string` };
    }
    narratives[inputKey] = value;
  }
  return { ok: true, narratives, itemAcceptance };
}

/** Flag name -> narrative input key (#6372 item 2). */
const NARRATIVE_FLAGS: Record<string, keyof ScaffoldNarrativeInput> = {
  "--description": "description",
  "--user-story": "userStory",
  "--implementation-plan": "implementationPlan",
  "--traces": "traces",
  "--missing-traces-justification": "missingTracesJustification",
  "--acceptance-justification": "acceptanceJustification",
};

function takeValue(
  argv: string[],
  i: number,
  arg: string,
): { value: string | null; next: number; error?: string } {
  const value = argv[i + 1];
  if (value === undefined || value.startsWith("--")) {
    return { value: null, next: i, error: `argument ${arg}: expected one argument` };
  }
  return { value, next: i + 1 };
}

function parseBool(raw: string): boolean | null {
  const v = raw.trim().toLowerCase();
  if (v === "true" || v === "1" || v === "yes") return true;
  if (v === "false" || v === "0" || v === "no") return false;
  return null;
}

export function readinessMain(argv: string[] = process.argv.slice(2)): number {
  let projectRoot = ".";
  let scaffold = false;
  let scaffoldPath: string | null = null;
  let soloHeadless = false;
  const paths: string[] = [];
  const fileScope: string[] = [];
  const verifyCommands: string[] = [];
  const expectedOutputs: string[] = [];
  const dependsOn: string[] = [];
  let conflictGroup: string | undefined;
  let size: string | undefined;
  let fileScopeConfidence: string | undefined;
  let modelTier: string | undefined;
  let readiness: string | undefined;
  let parallelSafe: boolean | null = null;
  let parseError: string | null = null;
  const flagNarratives: MutableNarratives = {};
  const flagItemAcceptance: ScaffoldItemAcceptanceInput[] = [];
  let valuesFile: string | null = null;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const narrativeKey = arg === undefined ? undefined : NARRATIVE_FLAGS[arg];
    if (narrativeKey !== undefined && arg !== undefined) {
      const taken = takeValue(argv, i, arg);
      if (taken.error) {
        parseError ??= taken.error;
        continue;
      }
      if (taken.value !== null) flagNarratives[narrativeKey] = taken.value;
      i = taken.next;
    } else if (arg === "--item-acceptance") {
      const taken = takeValue(argv, i, arg);
      if (taken.error) {
        parseError ??= taken.error;
        continue;
      }
      const value = taken.value ?? "";
      const eq = value.indexOf("=");
      if (eq <= 0) {
        parseError ??= "argument --item-acceptance: expected <item-id|position>=<line>";
      } else {
        flagItemAcceptance.push({ selector: value.slice(0, eq), text: value.slice(eq + 1) });
      }
      i = taken.next;
    } else if (arg === "--values-file") {
      const taken = takeValue(argv, i, arg);
      if (taken.error) {
        parseError ??= taken.error;
        continue;
      }
      valuesFile = taken.value;
      i = taken.next;
    } else if (arg === "--project-root") {
      const taken = takeValue(argv, i, arg);
      if (taken.error) {
        parseError ??= taken.error;
        continue;
      }
      projectRoot = taken.value ?? ".";
      i = taken.next;
    } else if (arg === "--scaffold") {
      scaffold = true;
      const taken = takeValue(argv, i, arg);
      if (taken.error) {
        parseError ??= taken.error;
        continue;
      }
      scaffoldPath = taken.value;
      i = taken.next;
    } else if (arg === "--solo-headless") {
      soloHeadless = true;
    } else if (arg === "--file-scope") {
      const taken = takeValue(argv, i, arg);
      if (taken.error) {
        parseError ??= taken.error;
        continue;
      }
      if (taken.value) fileScope.push(taken.value);
      i = taken.next;
    } else if (arg === "--verify-command") {
      const taken = takeValue(argv, i, arg);
      if (taken.error) {
        parseError ??= taken.error;
        continue;
      }
      if (taken.value) verifyCommands.push(taken.value);
      i = taken.next;
    } else if (arg === "--expected-output") {
      const taken = takeValue(argv, i, arg);
      if (taken.error) {
        parseError ??= taken.error;
        continue;
      }
      if (taken.value) expectedOutputs.push(taken.value);
      i = taken.next;
    } else if (arg === "--depends-on") {
      const taken = takeValue(argv, i, arg);
      if (taken.error) {
        parseError ??= taken.error;
        continue;
      }
      if (taken.value) dependsOn.push(taken.value);
      i = taken.next;
    } else if (arg === "--conflict-group") {
      const taken = takeValue(argv, i, arg);
      if (taken.error) {
        parseError ??= taken.error;
        continue;
      }
      conflictGroup = taken.value ?? undefined;
      i = taken.next;
    } else if (arg === "--size") {
      const taken = takeValue(argv, i, arg);
      if (taken.error) {
        parseError ??= taken.error;
        continue;
      }
      size = taken.value ?? undefined;
      i = taken.next;
    } else if (arg === "--file-scope-confidence") {
      const taken = takeValue(argv, i, arg);
      if (taken.error) {
        parseError ??= taken.error;
        continue;
      }
      fileScopeConfidence = taken.value ?? undefined;
      i = taken.next;
    } else if (arg === "--model-tier") {
      const taken = takeValue(argv, i, arg);
      if (taken.error) {
        parseError ??= taken.error;
        continue;
      }
      modelTier = taken.value ?? undefined;
      i = taken.next;
    } else if (arg === "--readiness") {
      const taken = takeValue(argv, i, arg);
      if (taken.error) {
        parseError ??= taken.error;
        continue;
      }
      readiness = taken.value ?? undefined;
      i = taken.next;
    } else if (arg === "--parallel-safe") {
      const taken = takeValue(argv, i, arg);
      if (taken.error) {
        parseError ??= taken.error;
        continue;
      }
      const parsed = taken.value !== null ? parseBool(taken.value) : null;
      if (parsed === null) {
        parseError ??= "argument --parallel-safe: expected true|false";
      } else {
        parallelSafe = parsed;
      }
      i = taken.next;
    } else if (arg !== undefined && !arg.startsWith("-")) {
      paths.push(arg);
    }
  }

  if (parseError !== null) {
    process.stderr.write(`${parseError}\n`);
    return 2;
  }

  if (scaffold) {
    if (scaffoldPath === null || scaffoldPath.trim().length === 0) {
      process.stderr.write("argument --scaffold: expected xBRIEF path\n");
      return 2;
    }
    if (parallelSafe === null) {
      process.stderr.write(
        "scaffold requires explicit --parallel-safe true|false (no invent from issue text)\n",
      );
      return 2;
    }
    if (size === undefined || fileScopeConfidence === undefined) {
      process.stderr.write("scaffold requires explicit --size and --file-scope-confidence\n");
      return 2;
    }
    // Values file first; explicit flags override it (#6372 item 2).
    let narratives: MutableNarratives = {};
    let itemAcceptance: ScaffoldItemAcceptanceInput[] = [];
    if (valuesFile !== null) {
      const loaded = readScaffoldValuesFile(
        isAbsolute(valuesFile) ? valuesFile : resolve(projectRoot, valuesFile),
      );
      if (!loaded.ok) {
        process.stderr.write(`${loaded.error}\n`);
        return 2;
      }
      narratives = loaded.narratives;
      itemAcceptance = loaded.itemAcceptance;
    }
    narratives = { ...narratives, ...flagNarratives };
    itemAcceptance = [...itemAcceptance, ...flagItemAcceptance];
    const result = scaffoldSwarmDraft({
      projectRoot,
      vbriefPath: scaffoldPath,
      fileScope,
      verifyCommands,
      expectedOutputs: expectedOutputs.length > 0 ? expectedOutputs : undefined,
      dependsOn: dependsOn.length > 0 ? dependsOn : undefined,
      conflictGroup,
      size,
      fileScopeConfidence,
      modelTier,
      readiness,
      parallelSafe,
      narratives,
      itemAcceptance,
    });
    if (!result.ok) {
      process.stderr.write(`${result.error}\n${SWARM_BLOCK_REMEDIATION_HINT}\n`);
      return 1;
    }
    const lines = [
      `OK scaffold wrote plan.metadata.swarm keys [${result.writtenKeys.join(", ")}] to ${result.path}`,
    ];
    if (result.writtenFields.length > 0) {
      lines.push(`OK scaffold also wrote [${result.writtenFields.join(", ")}]`);
    }
    lines.push("", "Missing fields:");
    lines.push(...(result.missing.length > 0 ? result.missing.map((m) => `- ${m}`) : ["- none"]));
    lines.push("", "Blocked conditions:");
    lines.push(...(result.blocked.length > 0 ? result.blocked.map((b) => `- ${b}`) : ["- none"]));
    lines.push("", SCAFFOLD_LAUNCH_NOTE);
    process.stdout.write(`${lines.join("\n")}\n`);
    return 0;
  }

  // solo-headless: require exactly one requested path and do not drop missing
  // targets in expandPaths (existsSync filter) before the N=1 guard (#3718).
  let expanded: string[];
  if (soloHeadless) {
    if (paths.length !== 1) {
      process.stdout.write(
        "solo-headless refuses when more than one story is targeted; use concurrent readiness for multi-story cohorts (#3718)\n",
      );
      return 2;
    }
    const only = paths[0] ?? "";
    expanded = [isAbsolute(only) ? resolve(only) : resolve(projectRoot, only)];
  } else {
    expanded = expandReadinessPaths(projectRoot, paths);
  }
  const { exitCode, report } = readinessReport(projectRoot, expanded, {
    soloHeadless,
  });
  process.stdout.write(`${report}\n`);
  return exitCode;
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exit(readinessMain());
}
