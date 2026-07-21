#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  decideHook,
  type HookEvent,
  type HookHost,
  type HookPayloadContext,
  hookPayloadTopLevelKeys,
  isHookEvent,
  isHookHost,
  projectRootFromHookPayload,
  renderHostDecision,
} from "@deftai/directive-core/hooks";

interface ParsedArgs {
  host?: HookHost;
  event?: HookEvent;
  projectRoot?: string;
  error?: string;
}

export interface HookDispatchCliSeams {
  readonly readStdin?: () => string;
  readonly writeOut?: (text: string) => void;
  readonly writeErr?: (text: string) => void;
  readonly cwd?: () => string;
}

function takeValue(
  argv: readonly string[],
  index: number,
  flag: string,
): { value?: string; next: number; error?: string } {
  const token = argv[index];
  const prefix = `${flag}=`;
  if (token?.startsWith(prefix)) return { value: token.slice(prefix.length), next: index };
  const value = argv[index + 1];
  if (value === undefined) return { next: index, error: `argument ${flag}: expected one argument` };
  return { value, next: index + 1 };
}

export function parseArgs(argv: readonly string[]): ParsedArgs {
  const parsed: ParsedArgs = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === "--host" || token?.startsWith("--host=")) {
      const taken = takeValue(argv, i, "--host");
      if (taken.error) return { error: taken.error };
      const value = taken.value ?? "";
      if (!isHookHost(value)) {
        return { error: `unsupported host: ${JSON.stringify(taken.value)}` };
      }
      parsed.host = value;
      i = taken.next;
      continue;
    }
    if (token === "--event" || token?.startsWith("--event=")) {
      const taken = takeValue(argv, i, "--event");
      if (taken.error) return { error: taken.error };
      const value = taken.value ?? "";
      if (!isHookEvent(value)) {
        return { error: `unsupported event: ${JSON.stringify(taken.value)}` };
      }
      parsed.event = value;
      i = taken.next;
      continue;
    }
    if (token === "--project-root" || token?.startsWith("--project-root=")) {
      const taken = takeValue(argv, i, "--project-root");
      if (taken.error) return { error: taken.error };
      parsed.projectRoot = taken.value;
      i = taken.next;
      continue;
    }
    return { error: `unrecognized argument: ${token}` };
  }
  if (parsed.host === undefined) return { error: "--host is required" };
  if (parsed.event === undefined) return { error: "--event is required" };
  return parsed;
}

export interface ParsedPayload {
  readonly payload: unknown;
  readonly context: HookPayloadContext;
}

const UTF8_BOM = "\uFEFF";
const APPLY_PATCH_BEGIN_MARKER = "*** Begin Patch";
/** Single-file Add/Update only — other *** … File: ops must fail closed (#2738 Greptile). */
const APPLY_PATCH_MUTATION_LINE_RE =
  /^\*\*\* (Add File|Update File|Delete File|Move File|Rename File): (.+)$/gm;

function stripUtf8Bom(raw: string): string {
  return raw.startsWith(UTF8_BOM) ? raw.slice(UTF8_BOM.length) : raw;
}

function trySynthesizeFreeFormApplyPatch(normalized: string): ParsedPayload | null {
  if (!normalized.includes(APPLY_PATCH_BEGIN_MARKER)) return null;
  const mutations: { op: string; path: string }[] = [];
  for (const match of normalized.matchAll(APPLY_PATCH_MUTATION_LINE_RE)) {
    const op = match[1];
    const path = match[2]?.trim();
    if (op === undefined || !path) continue;
    mutations.push({ op, path });
  }
  if (mutations.length !== 1) return null;
  const sole = mutations[0];
  if (sole === undefined || (sole.op !== "Add File" && sole.op !== "Update File")) return null;
  return {
    payload: {
      tool_name: "ApplyPatch",
      tool_input: {
        path: sole.path,
        patch: normalized,
      },
    },
    context: {},
  };
}

export function parsePayload(raw: string): ParsedPayload {
  if (raw.trim().length === 0) {
    return { payload: {}, context: { stdinEmpty: true } };
  }
  const normalized = stripUtf8Bom(raw);
  if (normalized.trim().length === 0) {
    return { payload: {}, context: { stdinEmpty: true } };
  }
  try {
    return { payload: JSON.parse(normalized) as unknown, context: {} };
  } catch {
    const synthesized = trySynthesizeFreeFormApplyPatch(normalized);
    if (synthesized !== null) return synthesized;
    // tool.before is installed only on direct-write matchers, so an unreadable
    // payload becomes a missing-tool denial rather than a fail-open crash.
    return { payload: {}, context: { parseFailed: true } };
  }
}

export function run(argv: string[], seams: HookDispatchCliSeams = {}): number {
  const args = parseArgs(argv);
  const writeOut = seams.writeOut ?? ((text: string) => process.stdout.write(text));
  const writeErr = seams.writeErr ?? ((text: string) => process.stderr.write(text));
  if (args.error !== undefined || args.host === undefined || args.event === undefined) {
    writeErr(`${args.error ?? "invalid hook-dispatch arguments"}\n`);
    return 2;
  }

  const readStdin = seams.readStdin ?? (() => readFileSync(0, "utf8"));
  const cwd = (seams.cwd ?? process.cwd)();
  const { payload, context: payloadContext } = parsePayload(readStdin());
  const projectRoot = args.projectRoot
    ? resolve(args.projectRoot)
    : projectRootFromHookPayload(payload, cwd);
  const decision = decideHook({
    host: args.host,
    event: args.event,
    projectRoot,
    payload,
    payloadContext,
  });
  const rendered = renderHostDecision(args.host, decision);
  if (rendered.length > 0) writeOut(`${rendered}\n`);
  if (decision.code === "invalid-input" && args.host === "cursor") {
    // Keys are already embedded in decision.message; stderr helps operators tailing logs.
    const keys = hookPayloadTopLevelKeys(payload);
    if (keys.length > 0) {
      writeErr(`Directive hook diagnostic: payload top-level keys: ${keys.join(", ")}\n`);
    }
  }
  if (decision.code === "session-start-degraded") writeErr(`${decision.message}\n`);
  if (
    decision.code === "session-compact-rearm" ||
    decision.code === "session-compact-rearm-degraded" ||
    decision.code === "session-compact-noop"
  ) {
    writeErr(`${decision.message}\n`);
  }
  return 0;
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exit(run(process.argv.slice(2)));
}
