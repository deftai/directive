/**
 * verify:presentation-ceiling evaluation (#5056).
 *
 * Sibling of intent-constraint / class-checks. Arms from merge-base ceiling
 * artifacts (and first-PR head-only `changeClass: presentation` adds).
 * Returned failures only — no throw/reject/abort sites.
 */

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import type * as TypeScript from "typescript";
import { isMarkupPath } from "../observable-scope/extract.js";
import { isUnderConfiguredRoot } from "../scope-provenance/base-fence.js";
import { isHumanApprovalStamp } from "../scope-provenance/digest.js";
import { DEFAULT_FIXTURE_ROOTS, DEFAULT_TEST_ROOTS } from "../test-boundary/policy.js";
import {
  BUILTIN_PRESENTATION_EXTS,
  EXTRA_CEREMONY_REMEDIATION,
  GATE_ID,
  GATE_TOOLING_PREFIXES,
  LOADER_NAMES,
  PRESENTATION_CEILING_ARTIFACT_REL,
  PRESENTATION_CEILING_PLAN_KEY,
  PRESENTATION_CEILING_REMEDIATION,
  PRESENTATION_CEILING_SCHEMA,
  PRESENTATION_CHANGE_CLASS,
  type PresentationCeilingArtifact,
  type PresentationCeilingFinding,
  type PresentationCeilingResult,
  type PresentationCeilingSnapshot,
  type PresentationExtensionAmendment,
  type PresentationHumanApproval,
  REMOVAL_REMEDIATION,
  WEAKEN_REMEDIATION,
} from "./types.js";

const UNEVALUATED_NOTE =
  "Intent-constraint N/A or no-new-facts cannot be cited as ceiling evidence (#5056).";

const CSS_EXT = ".css";
const JSON_EXT = ".json";
const CHANGELOG_REL = "CHANGELOG.md";
const APPROVED_SCOPE_PREFIX = ".deft/approved-scope/";
const XBRIEF_PREFIX = "xbrief/";
const COMPLETED_PREFIX = "xbrief/completed/";

export interface PresentationCeilingOptions {
  readonly baseRef?: string | null;
  readonly snapshot?: PresentationCeilingSnapshot;
  readonly quiet?: boolean;
}

type GitRun =
  | { readonly ok: true; readonly status: number; readonly stdout: string }
  | { readonly ok: false; readonly kind: "not-found" | "spawn-error"; readonly message: string };

function git(args: readonly string[], cwd: string): GitRun {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 20 * 1024 * 1024,
  });
  if (result.error !== undefined) {
    const e = result.error as NodeJS.ErrnoException;
    if (e.code === "ENOENT") {
      return { ok: false, kind: "not-found", message: "'git' executable not found on PATH" };
    }
    return {
      ok: false,
      kind: "spawn-error",
      message: `git ${args[0]} failed: ${String(e.message)}`,
    };
  }
  if (result.signal !== null && result.signal !== undefined) {
    return {
      ok: false,
      kind: "spawn-error",
      message: `git ${args[0]} killed by signal ${String(result.signal)}`,
    };
  }
  return { ok: true, status: result.status ?? 1, stdout: String(result.stdout ?? "") };
}

export function normalizeRepoRelPath(p: string): string {
  return p
    .replace(/\\/g, "/")
    .replace(/^\.\//, "")
    .replace(/\/{2,}/g, "/");
}

export function pathExtension(relPath: string): string {
  const base = normalizeRepoRelPath(relPath).split("/").pop() ?? "";
  const dot = base.lastIndexOf(".");
  if (dot <= 0) return "";
  return base.slice(dot).toLowerCase();
}

export function isCssPath(relPath: string): boolean {
  return pathExtension(relPath) === CSS_EXT;
}

export function isBuiltinPresentationPath(relPath: string): boolean {
  return isMarkupPath(relPath) || isCssPath(relPath);
}

export function isGateToolingPath(relPath: string): boolean {
  const posix = normalizeRepoRelPath(relPath);
  for (const prefix of GATE_TOOLING_PREFIXES) {
    if (posix === prefix || posix.startsWith(prefix)) return true;
  }
  return false;
}

export function isApprovedScopeRecordPath(relPath: string): boolean {
  const posix = normalizeRepoRelPath(relPath);
  if (!posix.startsWith(APPROVED_SCOPE_PREFIX)) return false;
  if (posix.endsWith(".bak") || posix.endsWith(".tmp") || posix.endsWith(".lock.tmp")) {
    return false;
  }
  return pathExtension(posix) === JSON_EXT;
}

export function isExtraCeremonyPath(relPath: string): boolean {
  const posix = normalizeRepoRelPath(relPath);
  if (posix === "AGENTS.md") return true;
  if (posix === "docs" || posix.startsWith("docs/")) return true;
  if (posix === "content/docs" || posix.startsWith("content/docs/")) return true;
  if (posix === ".deft/core" || posix.startsWith(".deft/core/")) return true;
  return false;
}

function humanStamp(raw: unknown): PresentationHumanApproval | null {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const obj = raw as Record<string, unknown>;
  if (typeof obj.kind !== "string" || typeof obj.actor !== "string") return null;
  if (typeof obj.mintedAt !== "string") return null;
  const stamp: PresentationHumanApproval = {
    kind: obj.kind,
    actor: obj.actor,
    mintedAt: obj.mintedAt,
    mintedVia: typeof obj.mintedVia === "string" ? obj.mintedVia : undefined,
  };
  return isHumanApprovalStamp(stamp) ? stamp : null;
}

function stringList(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const item of raw) {
    if (typeof item !== "string") continue;
    const t = item.trim();
    if (t.length === 0) continue;
    out.push(t.startsWith(".") ? t.toLowerCase() : t);
  }
  return out;
}

function parseChangeClassObject(
  raw: Record<string, unknown>,
  path: string,
): PresentationCeilingArtifact | null {
  const changeClass = raw.changeClass;
  if (changeClass !== PRESENTATION_CHANGE_CLASS) return null;
  const amendmentRaw = raw.extensionAmendment;
  let extensionAmendment: PresentationExtensionAmendment | null = null;
  if (amendmentRaw !== null && typeof amendmentRaw === "object" && !Array.isArray(amendmentRaw)) {
    const rec = amendmentRaw as Record<string, unknown>;
    const stamp = humanStamp(rec.humanApproval);
    if (stamp !== null) {
      extensionAmendment = { extensions: stringList(rec.extensions), humanApproval: stamp };
    }
  }
  return {
    schema: PRESENTATION_CEILING_SCHEMA,
    changeClass: PRESENTATION_CHANGE_CLASS,
    path,
    allowedExtensions: stringList(raw.allowedExtensions ?? raw.allowlist),
    hasExtensionRestriction: raw.allowedExtensions !== undefined || raw.allowlist !== undefined,
    componentRoots: stringList(raw.componentRoots),
    extensionAmendment,
    removalStamp: humanStamp(raw.removalStamp ?? raw.humanApproval),
  };
}

export function parseCeilingPayload(
  payload: unknown,
  path: string,
): PresentationCeilingArtifact | null {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) return null;
  const obj = payload as Record<string, unknown>;
  if (obj.changeClass === PRESENTATION_CHANGE_CLASS) {
    return parseChangeClassObject(obj, path);
  }
  const plan = obj.plan;
  if (plan === null || typeof plan !== "object" || Array.isArray(plan)) return null;
  const planRec = plan as Record<string, unknown>;
  const keyed = planRec[PRESENTATION_CEILING_PLAN_KEY];
  if (typeof keyed === "string" && keyed === PRESENTATION_CHANGE_CLASS) {
    return parseChangeClassObject({ changeClass: PRESENTATION_CHANGE_CLASS }, path);
  }
  if (keyed !== null && typeof keyed === "object" && !Array.isArray(keyed)) {
    return parseChangeClassObject(keyed as Record<string, unknown>, path);
  }
  const metadata = planRec.metadata;
  if (metadata !== null && typeof metadata === "object" && !Array.isArray(metadata)) {
    const metaKeyed = (metadata as Record<string, unknown>)[PRESENTATION_CEILING_PLAN_KEY];
    if (typeof metaKeyed === "string" && metaKeyed === PRESENTATION_CHANGE_CLASS) {
      return parseChangeClassObject({ changeClass: PRESENTATION_CHANGE_CLASS }, path);
    }
    if (metaKeyed !== null && typeof metaKeyed === "object" && !Array.isArray(metaKeyed)) {
      return parseChangeClassObject(metaKeyed as Record<string, unknown>, path);
    }
  }
  return null;
}

export function effectivePresentationExts(
  baseArtifacts: readonly PresentationCeilingArtifact[],
): ReadonlySet<string> {
  const builtin = new Set<string>(BUILTIN_PRESENTATION_EXTS);
  const allowed = new Set<string>(builtin);
  // All recorded ceilings constrain the built-in set. Explicit human amendments
  // authorize additional dialects repository-wide, independently of allowlists.
  for (const art of baseArtifacts) {
    if (art.allowedExtensions.length === 0 && !art.hasExtensionRestriction) continue;
    const restriction = new Set(art.allowedExtensions.map(normalizeExtension));
    for (const ext of allowed) {
      if (!restriction.has(ext)) allowed.delete(ext);
    }
  }
  for (const art of baseArtifacts) {
    for (const ext of art.extensionAmendment?.extensions ?? []) {
      const normalized = normalizeExtension(ext);
      if (!builtin.has(normalized)) allowed.add(normalized);
    }
  }
  return allowed;
}

function normalizeExtension(ext: string): string {
  return ext.startsWith(".") ? ext.toLowerCase() : `.${ext.toLowerCase()}`;
}

function intersectRoots(defaults: readonly string[], base: readonly string[]): readonly string[] {
  const baseSet = new Set(base.map((r) => r.replace(/\\/g, "/")));
  return defaults.filter((d) => baseSet.has(d.replace(/\\/g, "/")));
}

function isJsonExemptCandidate(relPath: string, snapshot: PresentationCeilingSnapshot): boolean {
  const posix = normalizeRepoRelPath(relPath);
  if (isApprovedScopeRecordPath(posix)) return true;
  if (
    snapshot.baseActiveXbriefPaths?.includes(posix) ||
    (snapshot.baseActiveXbriefPath !== null && posix === snapshot.baseActiveXbriefPath)
  ) {
    return true;
  }
  for (const art of snapshot.baseArtifacts) {
    if (posix === art.path) return true;
  }
  for (const art of snapshot.headArtifacts) {
    if (posix === art.path) return true;
  }
  return false;
}

/**
 * Parse-only reader analysis: executable imports/calls, local path aliases and
 * approved-scope module bindings. It does not analyze persistence semantics.
 * JS/TS uses the gate's bundled parser; other languages use conservative input
 * syntax checks. Comments, labels and source examples do not execute. Unknown
 * calls carrying an exempt path are conservatively treated as consumers.
 */
interface ReaderEvidence {
  readonly inputPaths: readonly string[];
  readonly changelog: boolean;
  readonly loader: boolean;
  readonly dynamic: boolean;
}
const requireParser = createRequire(import.meta.url);
let parser: typeof TypeScript | undefined;

function protectedJsonText(text: string): boolean {
  return (
    text.includes("approved-scope") ||
    text.includes("xbrief/") ||
    text.includes("presentation-ceiling")
  );
}

function changelogPath(text: string): boolean {
  return /(?:^|\/)CHANGELOG(?:\.md)?$/.test(text);
}

function approvedScopeModule(specifier: string): boolean {
  return (
    /(?:^|\/)scope-provenance(?:\/|$)/.test(specifier) ||
    /^@deftai\/directive-core(?:\/scope-provenance)?$/.test(specifier)
  );
}

const DISPLAY_CALL = /^(?:log|warn|error|debug|info|print|printf|echo)$/;

/** Bounded fallback: mask strings/comments, then follow same-file assignments
 * into call arguments. This recognizes ordinary Python open(path) without
 * executing source or mistaking quoted code examples for calls. */
function fallbackReaderEvidence(content: string): ReaderEvidence {
  const values = new Map<string, string>();
  const executable = content.replace(
    /"""[\s\S]*?"""|'''[\s\S]*?'''|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`|\/\*[\s\S]*?\*\/|(?:#|\/\/)[^\n]*/g,
    (token) => {
      if (/^(?:#|\/\/|\/\*)/.test(token)) return token.replace(/[^\n]/g, " ");
      const width = token.startsWith('"""') || token.startsWith("'''") ? 3 : 1;
      const key = `__ceiling_literal_${values.size}`;
      values.set(key, token.slice(width, -width));
      // Keep Python r/b/u/f prefixes separate from the masked literal token.
      return ` ${key} `;
    },
  );
  // Preserve multiline calls and expand Python's single-line suites before
  // applying statement order. Literal/comment masking makes delimiter counts
  // independent of prose inside strings.
  const logicalLines: string[] = [];
  let pending = "",
    depth = 0;
  for (const line of executable.split("\n")) {
    pending += pending ? ` ${line.trim()}` : line;
    for (const char of line) {
      if ("([{".includes(char)) depth++;
      if (")]}".includes(char)) depth--;
    }
    if (depth > 0 || /\\\s*$/.test(line)) continue;
    if (
      /^\s*(?:(?:async\s+)?def|class|if|elif|else|for|while|try|except|finally|with)\b/.test(
        pending,
      )
    ) {
      let nested = 0,
        colon = -1;
      for (let i = 0; i < pending.length; i++) {
        const char = pending[i] ?? "";
        if ("([{".includes(char)) nested++;
        if (")]}".includes(char)) nested--;
        if (char === ":" && nested === 0) {
          colon = i;
          break;
        }
      }
      if (colon >= 0 && pending.slice(colon + 1).trim()) {
        logicalLines.push(
          pending.slice(0, colon + 1),
          `${pending.match(/^\s*/)?.[0] ?? ""}    ${pending.slice(colon + 1).trim()}`,
        );
      } else logicalLines.push(pending);
    } else logicalLines.push(pending);
    pending = "";
  }
  if (pending) logicalLines.push(pending);
  type Inputs = ReadonlySet<string>;
  type Environment = Map<string, Inputs>;
  const merge = (...environments: Environment[]): Environment => {
    const result: Environment = new Map();
    for (const env of environments)
      for (const [name, paths] of env)
        result.set(name, new Set([...(result.get(name) ?? []), ...paths]));
    return result;
  };
  const resolveInputs = (text: string, env: Environment): Inputs => {
    const paths = new Set<string>();
    for (const match of text.matchAll(/\b[A-Za-z_]\w*\b/g)) {
      const literal = values.get(match[0]);
      if (literal !== undefined) paths.add(literal);
      for (const path of env.get(match[0]) ?? []) paths.add(path);
    }
    return paths;
  };
  const inputPaths = new Set<string>();
  let dynamic = false;
  const scan = (expression: string, env: Environment): void => {
    for (const match of expression.matchAll(/\b([A-Za-z_]\w*)\s*\(/g)) {
      const name = match[1] ?? "";
      if (/\b(?:def|class)\s+$/.test(expression.slice(0, match.index))) continue;
      if (DISPLAY_CALL.test(name) || /^(?:if|while|for|switch|return|def|class)$/.test(name))
        continue;
      const start = match.index + match[0].length;
      let end = start,
        depth = 1;
      while (end < expression.length && depth > 0) {
        if (expression[end] === "(") depth++;
        if (expression[end] === ")") depth--;
        end++;
      }
      for (const path of resolveInputs(expression.slice(start, end - 1), env)) inputPaths.add(path);
    }
    if (
      /\+|\$\{|\b(?:join|resolve)\s*\(/.test(expression) &&
      [...resolveInputs(expression, env)].some(protectedJsonText)
    )
      dynamic = true;
  };
  const possible: Environment = new Map();
  let version = 0;
  const remember = (name: string, paths: Inputs): void => {
    const previous = possible.get(name) ?? new Set<string>();
    const next = new Set([...previous, ...paths]);
    if (next.size !== previous.size) {
      possible.set(name, next);
      version++;
    }
  };
  type Deferred = {
    lines: string[];
    captured: Environment;
    parentLocals: ReadonlySet<string>;
    parentKey: string;
    parameters: Environment;
  };
  const deferred = new Map<string, Deferred>();
  const localPossibilities = new Map<string, Environment>();
  const indent = (line: string): number =>
    line.match(/^\s*/)?.[0].replace(/\t/g, "    ").length ?? 0;
  const localAssignments = (lines: string[]): string[] => {
    const names: string[] = [];
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] ?? "";
      if (/^\s*(?:(?:async\s+)?def|class)\b/.test(line)) {
        const level = indent(line);
        while (
          i + 1 < lines.length &&
          (!(lines[i + 1] ?? "").trim() || indent(lines[i + 1] ?? "") > level)
        )
          i++;
        continue;
      }
      for (const part of line.split(";")) {
        const name = part.match(/^\s*([A-Za-z_]\w*)\s*=(?!=)/)?.[1];
        if (name) names.push(name);
      }
    }
    return names;
  };
  const run = (
    lines: string[],
    env: Environment,
    locals: ReadonlySet<string> = new Set(),
    scopeKey = "file",
    functionKey = scopeKey,
  ): void => {
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] ?? "";
      const header = line.trim();
      const isDefinition = /^(?:async\s+)?def\s+/.test(header);
      const isBlock =
        /^(?:(?:async\s+)?def|class|if|elif|else|for|while|try|except|finally|with)\b/.test(
          header,
        ) && header.endsWith(":");
      if (isBlock) {
        scan(header, env);
        let end = i + 1;
        while (
          end < lines.length &&
          (!(lines[end] ?? "").trim() || indent(lines[end] ?? "") > indent(line))
        )
          end++;
        const body = lines.slice(i + 1, end);
        if (isDefinition) {
          const parameters: Environment = new Map();
          const signature = header.slice(header.indexOf("(") + 1, header.lastIndexOf(")"));
          for (const part of signature.split(",")) {
            const name = part.trim().match(/^\**([A-Za-z_]\w*)/)?.[1];
            if (name)
              parameters.set(
                name,
                resolveInputs(part.includes("=") ? part.slice(part.indexOf("=") + 1) : "", env),
              );
          }
          const key = `${scopeKey}:${i}`;
          const existing = deferred.get(key);
          deferred.set(key, {
            lines: body,
            captured: merge(existing?.captured ?? new Map(), env),
            parentLocals: locals,
            parentKey: functionKey,
            parameters: merge(existing?.parameters ?? new Map(), parameters),
          });
        } else {
          let entry = new Map(env);
          const repeats = /^(?:for|while)\b/.test(header);
          for (;;) {
            const outcome = new Map(entry);
            run(body, outcome, locals, `${scopeKey}:${i}:block`, functionKey);
            const next = merge(entry, outcome);
            const stable = [...next].every(
              ([name, paths]) => paths.size === (entry.get(name)?.size ?? 0),
            );
            entry = next;
            if (!repeats || stable) break;
          }
          env.clear();
          for (const [name, paths] of entry) env.set(name, paths);
        }
        i = end - 1;
        continue;
      }
      // Supported simple statements execute in source order. Each assignment
      // snapshots its RHS before replacing the binding; later writes cannot
      // retroactively change a prior call or alias.
      for (const statement of line.split(";")) {
        scan(statement, env);
        const match = statement.match(/^\s*([A-Za-z_]\w*)\s*=(?!=)(.*)$/);
        if (!match?.[1]) continue;
        const paths = resolveInputs(match[2] ?? "", env);
        env.set(match[1], paths);
        if (!locals.has(match[1])) remember(match[1], paths);
        else {
          const summary = localPossibilities.get(functionKey) ?? new Map<string, Inputs>();
          const previous = summary.get(match[1]) ?? new Set<string>();
          const next = new Set([...previous, ...paths]);
          if (next.size !== previous.size) version++;
          summary.set(match[1], next);
          localPossibilities.set(functionKey, summary);
        }
      }
    }
  };
  run(logicalLines, new Map());
  // Python bodies are deferred. Unknown invocation order keeps possible outer
  // values, while parameters and local assignments have their own bindings.
  for (;;) {
    const before = version,
      count = deferred.size;
    for (const [key, item] of deferred) {
      const body = item.lines;
      const globals = new Set(
        body.flatMap((line) =>
          line.trim().startsWith("global ")
            ? line
                .trim()
                .slice(7)
                .split(",")
                .map((name) => name.trim())
            : [],
        ),
      );
      const ownLocals = new Set(
        [...item.parameters.keys(), ...localAssignments(body)].filter((name) => !globals.has(name)),
      );
      const env = merge(item.captured, possible);
      for (const name of item.parentLocals)
        env.set(
          name,
          new Set([
            ...(item.captured.get(name) ?? []),
            ...(localPossibilities.get(item.parentKey)?.get(name) ?? []),
          ]),
        );
      for (const name of ownLocals) env.delete(name);
      for (const [name, paths] of item.parameters) env.set(name, paths);
      run(body, env, new Set([...item.parentLocals, ...ownLocals]), key);
    }
    if (before === version && count === deferred.size) break;
  }
  return {
    inputPaths: [...inputPaths],
    changelog: [...inputPaths].some(changelogPath),
    loader: false,
    dynamic,
  };
}

function readerEvidence(path: string, content: string): ReaderEvidence {
  const empty: ReaderEvidence = { inputPaths: [], changelog: false, loader: false, dynamic: false };
  if (/\.(?:md|mdx|txt|rst|json|lock|csv|svg|css)$/i.test(path)) return empty;
  if (/\.html?$/i.test(path))
    // Delimiter-aware end-tag: match CodeQL-cited closes such as </script\t\n bar>
    // without truncating lookalike non-closes like </script-not-a-close> (#5747 / alert #143).
    content = [
      ...content.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script(?=[\t\n\f\r />])[^>]*>/gi),
    ]
      .map((match) => match[1] ?? "")
      .join("\n");
  if (!/\.(?:[cm]?[jt]sx?|html?)$/i.test(path)) return fallbackReaderEvidence(content);
  // Lazy: importing core or evaluating an unarmed ceiling never loads TypeScript.
  parser ??= requireParser("typescript") as typeof TypeScript;
  const ts = parser;
  const source = ts.createSourceFile(
    path,
    content,
    ts.ScriptTarget.Latest,
    true,
    /\.[jt]sx$/i.test(path) ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const inputPaths = new Set<string>();
  type Value = { paths: ReadonlySet<string>; loader: boolean; namespace: boolean };
  type Binding = { name: string; scope: Scope };
  type Scope = { parent?: Scope; functionScope: boolean; bindings: Map<string, Binding> };
  type State = Map<Binding, Value>;
  const emptyValue: Value = { paths: new Set(), loader: false, namespace: false };
  const mergeValues = (...values: Value[]): Value => ({
    paths: new Set(values.flatMap((value) => [...value.paths])),
    loader: values.some((value) => value.loader),
    namespace: values.some((value) => value.namespace),
  });
  const root: Scope = { functionScope: true, bindings: new Map() };
  const scopes = new Map<TypeScript.Node, Scope>();
  const declare = (name: TypeScript.BindingName, scope: Scope): void => {
    if (ts.isIdentifier(name)) {
      if (!scope.bindings.has(name.text)) scope.bindings.set(name.text, { name: name.text, scope });
    } else
      for (const element of name.elements)
        if (ts.isBindingElement(element)) declare(element.name, scope);
  };
  const index = (node: TypeScript.Node, outer: Scope): void => {
    if ((ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) && node.name)
      declare(node.name, outer);
    const isFunction = ts.isFunctionLike(node);
    const scope =
      isFunction ||
      ts.isBlock(node) ||
      ts.isCatchClause(node) ||
      ts.isForStatement(node) ||
      ts.isForOfStatement(node) ||
      ts.isForInStatement(node)
        ? { parent: outer, functionScope: isFunction, bindings: new Map<string, Binding>() }
        : outer;
    scopes.set(node, scope);
    if (ts.isFunctionExpression(node) && node.name) declare(node.name, scope);
    if (ts.isParameter(node)) declare(node.name, scope);
    if (ts.isVariableDeclaration(node)) {
      let owner = scope;
      if (
        ts.isVariableDeclarationList(node.parent) &&
        !(node.parent.flags & ts.NodeFlags.BlockScoped)
      )
        while (!owner.functionScope && owner.parent) owner = owner.parent;
      declare(node.name, owner);
    }
    if (ts.isImportClause(node) && node.name) declare(node.name, scope);
    if (ts.isImportSpecifier(node) || ts.isNamespaceImport(node)) declare(node.name, scope);
    ts.forEachChild(node, (child) => index(child, scope));
  };
  index(source, root);
  const binding = (node: TypeScript.Identifier): Binding => {
    let scope: Scope | undefined = scopes.get(node) ?? root;
    while (scope) {
      const found = scope.bindings.get(node.text);
      if (found) return found;
      scope = scope.parent;
    }
    // Undeclared assignments share the file's global binding, not a shadowed local.
    let found = root.bindings.get(node.text);
    if (!found) {
      found = { name: node.text, scope: root };
      root.bindings.set(node.text, found);
    }
    return found;
  };
  const possible: State = new Map();
  let possibleVersion = 0;
  const sameValue = (a: Value, b: Value): boolean =>
    a.loader === b.loader &&
    a.namespace === b.namespace &&
    a.paths.size === b.paths.size &&
    [...a.paths].every((path) => b.paths.has(path));
  const write = (id: Binding, value: Value, state: State): void => {
    state.set(id, value);
    const before = possible.get(id) ?? emptyValue;
    const after = mergeValues(before, value);
    if (!sameValue(before, after)) {
      possible.set(id, after);
      possibleVersion++;
    }
  };
  const joinStates = (...states: State[]): State => {
    const joined: State = new Map();
    for (const state of states)
      for (const [id, value] of state)
        joined.set(id, mergeValues(joined.get(id) ?? emptyValue, value));
    return joined;
  };
  const replaceState = (state: State, next: State): void => {
    state.clear();
    for (const [id, value] of next) state.set(id, value);
  };
  const assign = (name: TypeScript.BindingName, value: Value, state: State): void => {
    if (ts.isIdentifier(name)) write(binding(name), value, state);
    else
      for (const element of name.elements) {
        if (!ts.isBindingElement(element)) continue;
        const original = element.propertyName?.getText(source) ?? element.name.getText(source);
        assign(
          element.name,
          {
            paths: value.paths,
            loader:
              value.loader || (value.namespace && LOADER_NAMES.some((known) => known === original)),
            namespace: value.namespace && original === "scopeProvenance",
          },
          state,
        );
      }
  };
  let loader = false;
  let dynamic = false;
  const deferred = new Map<TypeScript.Node, State>();
  const assignUnknownTarget = (target: TypeScript.Node, value: Value, state: State): void => {
    if (ts.isIdentifier(target)) {
      const id = binding(target);
      write(id, mergeValues(state.get(id) ?? emptyValue, value), state);
    } else if (ts.isPropertyAccessExpression(target) || ts.isElementAccessExpression(target)) {
      assignUnknownTarget(target.expression, value, state);
    } else if (ts.isPropertyAssignment(target))
      assignUnknownTarget(target.initializer, value, state);
    else ts.forEachChild(target, (child) => assignUnknownTarget(child, value, state));
  };
  const read = (node: TypeScript.Node, state: State): Value => {
    if (ts.isStringLiteralLike(node)) return { ...emptyValue, paths: new Set([node.text]) };
    if (ts.isIdentifier(node)) return state.get(binding(node)) ?? emptyValue;
    if (ts.isFunctionLike(node)) {
      deferred.set(node, joinStates(deferred.get(node) ?? new Map(), state));
      return emptyValue;
    }
    if (ts.isConditionalExpression(node)) {
      read(node.condition, state);
      const yes = new Map(state),
        no = new Map(state);
      const values = mergeValues(read(node.whenTrue, yes), read(node.whenFalse, no));
      replaceState(state, joinStates(yes, no));
      return values;
    }
    if (ts.isBinaryExpression(node)) {
      if (node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
        const value = read(node.right, state);
        if (ts.isIdentifier(node.left)) write(binding(node.left), value, state);
        else {
          read(node.left, state);
          // Unsupported member/destructuring writes retain MAY values on their
          // receiving bindings rather than silently dropping a protected path.
          assignUnknownTarget(node.left, value, state);
        }
        return value;
      }
      const left = read(node.left, state);
      const beforeRight = new Map(state);
      const right = read(node.right, state);
      if (
        [
          ts.SyntaxKind.AmpersandAmpersandToken,
          ts.SyntaxKind.BarBarToken,
          ts.SyntaxKind.QuestionQuestionToken,
        ].includes(node.operatorToken.kind)
      )
        replaceState(state, joinStates(beforeRight, state));
      const value = mergeValues(left, right);
      if (
        [ts.SyntaxKind.PlusToken, ts.SyntaxKind.PlusEqualsToken].includes(
          node.operatorToken.kind,
        ) &&
        [...value.paths].some(protectedJsonText)
      )
        dynamic = true;
      if (node.operatorToken.kind === ts.SyntaxKind.PlusEqualsToken && ts.isIdentifier(node.left))
        write(binding(node.left), value, state);
      return value;
    }
    if (ts.isPropertyAccessExpression(node)) {
      const value = read(node.expression, state);
      return {
        ...value,
        loader:
          value.loader ||
          (value.namespace && LOADER_NAMES.some((known) => known === node.name.text)),
      };
    }
    if (ts.isPropertyAssignment(node))
      return mergeValues(
        ts.isComputedPropertyName(node.name) || ts.isStringLiteralLike(node.name)
          ? read(node.name, state)
          : emptyValue,
        read(node.initializer, state),
      );
    if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
      const callee = read(node.expression, state);
      const args = (node.arguments ?? []).map((arg) => read(arg, state));
      const value = mergeValues(...args);
      const name = ts.isIdentifier(node.expression)
        ? node.expression.text
        : ts.isPropertyAccessExpression(node.expression)
          ? node.expression.name.text
          : "";
      if (!DISPLAY_CALL.test(name)) for (const path of value.paths) inputPaths.add(path);
      if (callee.loader) loader = true;
      if (/^(?:join|resolve)$/.test(name) && [...value.paths].some(protectedJsonText))
        dynamic = true;
      if (name === "require" && [...value.paths].some(approvedScopeModule))
        return { ...value, namespace: true };
      return value;
    }
    const children: Value[] = [];
    ts.forEachChild(node, (child) => {
      children.push(read(child, state));
    });
    const value = mergeValues(...children);
    if (ts.isTemplateExpression(node) && [...value.paths].some(protectedJsonText)) dynamic = true;
    return value;
  };
  const run = (node: TypeScript.Node, state: State): void => {
    if (ts.isFunctionLike(node)) {
      read(node, state);
      return;
    }
    if (ts.isVariableDeclaration(node)) {
      // A repeated `var p;` does not overwrite an earlier initialized value.
      if (
        !node.initializer &&
        ts.isIdentifier(node.name) &&
        ts.isVariableDeclarationList(node.parent) &&
        !(node.parent.flags & ts.NodeFlags.BlockScoped) &&
        state.has(binding(node.name))
      )
        return;
      assign(node.name, node.initializer ? read(node.initializer, state) : emptyValue, state);
      return;
    }
    if (ts.isImportDeclaration(node)) {
      const value = read(node.moduleSpecifier, state);
      for (const path of value.paths) inputPaths.add(path);
      const ownsLoader = [...value.paths].some(approvedScopeModule);
      const clause = node.importClause;
      if (clause?.name) assign(clause.name, { ...emptyValue, namespace: ownsLoader }, state);
      const named = clause?.namedBindings;
      if (named && ts.isNamespaceImport(named))
        assign(named.name, { ...emptyValue, namespace: ownsLoader }, state);
      if (named && ts.isNamedImports(named))
        for (const element of named.elements) {
          const original = element.propertyName?.text ?? element.name.text;
          assign(
            element.name,
            {
              ...emptyValue,
              loader: ownsLoader && LOADER_NAMES.some((known) => known === original),
              namespace: ownsLoader && original === "scopeProvenance",
            },
            state,
          );
        }
      return;
    }
    if (ts.isExportDeclaration(node) && node.moduleSpecifier) {
      for (const path of read(node.moduleSpecifier, state).paths) inputPaths.add(path);
      return;
    }
    if (ts.isIfStatement(node)) {
      read(node.expression, state);
      const yes = new Map(state),
        no = new Map(state);
      run(node.thenStatement, yes);
      if (node.elseStatement) run(node.elseStatement, no);
      replaceState(state, joinStates(yes, no));
      return;
    }
    if (
      ts.isForStatement(node) ||
      ts.isForOfStatement(node) ||
      ts.isForInStatement(node) ||
      ts.isWhileStatement(node) ||
      ts.isDoStatement(node)
    ) {
      if (ts.isForStatement(node) && node.initializer) run(node.initializer, state);
      if (ts.isForOfStatement(node) || ts.isForInStatement(node)) {
        const value = read(node.expression, state);
        if (ts.isVariableDeclarationList(node.initializer))
          for (const declaration of node.initializer.declarations)
            assign(declaration.name, value, state);
        else if (ts.isIdentifier(node.initializer)) write(binding(node.initializer), value, state);
      }
      // Finite MAY-value fixed point: include zero iterations and loop-carried
      // values, so a read before a write in one iteration is checked next time.
      let entry = new Map(state);
      for (;;) {
        const iteration = new Map(entry);
        if (ts.isForStatement(node)) {
          if (node.condition) read(node.condition, iteration);
        } else read(node.expression, iteration);
        run(node.statement, iteration);
        if (ts.isForStatement(node) && node.incrementor) read(node.incrementor, iteration);
        const next = joinStates(entry, iteration);
        const stable =
          next.size === entry.size &&
          [...next].every(([id, value]) => sameValue(value, entry.get(id) ?? emptyValue));
        entry = next;
        if (stable) break;
      }
      replaceState(state, entry);
      return;
    }
    if (ts.isSwitchStatement(node)) {
      read(node.expression, state);
      const outcomes = [new Map(state)];
      let fallthrough = new Map(state);
      for (const clause of node.caseBlock.clauses) {
        fallthrough = joinStates(state, fallthrough);
        if (ts.isCaseClause(clause)) read(clause.expression, fallthrough);
        for (const statement of clause.statements) run(statement, fallthrough);
        outcomes.push(new Map(fallthrough));
      }
      replaceState(state, joinStates(...outcomes));
      return;
    }
    if (ts.isTryStatement(node)) {
      const body = new Map(state);
      run(node.tryBlock, body);
      const caught = joinStates(state, body, possible);
      if (node.catchClause) run(node.catchClause, caught);
      replaceState(state, joinStates(state, body, caught));
      if (node.finallyBlock) run(node.finallyBlock, state);
      return;
    }
    if (ts.isExpressionStatement(node) || ts.isReturnStatement(node) || ts.isThrowStatement(node)) {
      if (node.expression) read(node.expression, state);
      return;
    }
    // Expressions also execute in exports, class fields, decorators and bases.
    if (ts.isExpression(node)) {
      read(node, state);
      return;
    }
    ts.forEachChild(node, (child) => run(child, state));
  };
  const initial: State = new Map();
  // ESM bindings exist before module execution, even when their declaration is
  // textually after a use. CommonJS require retains ordinary assignment order.
  for (const statement of source.statements)
    if (ts.isImportDeclaration(statement)) run(statement, initial);
  run(source, initial);
  // A closure may execute after a later outer assignment. Keep that uncertainty
  // local to deferred bodies; it must not contaminate earlier straight-line uses.
  for (;;) {
    const version = possibleVersion,
      count = deferred.size;
    for (const [node, captured] of deferred) {
      if (!ts.isFunctionLike(node) || !("body" in node) || !node.body) continue;
      const state = joinStates(captured, possible);
      for (const id of state.keys()) {
        let owner: Scope | undefined = id.scope;
        while (owner && owner !== scopes.get(node)) owner = owner.parent;
        if (owner) state.delete(id);
      }
      for (const parameter of node.parameters)
        assign(
          parameter.name,
          parameter.initializer ? read(parameter.initializer, state) : emptyValue,
          state,
        );
      if (ts.isBlock(node.body)) run(node.body, state);
      else read(node.body, state);
    }
    if (version === possibleVersion && count === deferred.size) break;
  }
  return {
    inputPaths: [...inputPaths],
    changelog: [...inputPaths].some(changelogPath),
    loader,
    dynamic,
  };
}

function standingNonGateHits(
  snapshot: PresentationCeilingSnapshot,
  predicate: (evidence: ReaderEvidence) => boolean,
): string[] {
  const hits = new Set<string>();
  for (const contents of [
    snapshot.standingFileContents,
    snapshot.baseFileContents ?? new Map<string, string>(),
  ]) {
    for (const [rawPath, content] of contents) {
      const path = normalizeRepoRelPath(rawPath);
      if (!isGateToolingPath(path) && predicate(readerEvidence(path, content))) hits.add(path);
    }
  }
  return [...hits];
}

function changelogHasProductionReader(snapshot: PresentationCeilingSnapshot): boolean {
  return standingNonGateHits(snapshot, (evidence) => evidence.changelog).length > 0;
}

function jsonExemptionPulled(
  relPath: string,
  snapshot: PresentationCeilingSnapshot,
): PresentationCeilingFinding | null {
  const posix = normalizeRepoRelPath(relPath);
  const loaderHits = isApprovedScopeRecordPath(posix)
    ? standingNonGateHits(snapshot, (evidence) => evidence.loader)
    : [];
  if (loaderHits.length > 0) {
    return {
      kind: "json-exemption-referenced",
      path: posix,
      detail:
        `non-gate loader-output consumption (${loaderHits.join(", ")}) of ${posix}; ` +
        "JSON exemption does not hold",
      remediation: PRESENTATION_CEILING_REMEDIATION,
    };
  }
  const refHits = standingNonGateHits(snapshot, (evidence) =>
    evidence.inputPaths.some(
      (text) =>
        text === posix ||
        text.endsWith(`/${posix}`) ||
        (posix.startsWith(APPROVED_SCOPE_PREFIX) && text.startsWith(APPROVED_SCOPE_PREFIX)),
    ),
  );
  if (refHits.length > 0) {
    return {
      kind: "json-exemption-referenced",
      path: posix,
      detail: `non-gate reference to ${posix} from ${refHits.join(", ")}`,
      remediation: PRESENTATION_CEILING_REMEDIATION,
    };
  }
  const dynamicHits = standingNonGateHits(snapshot, (evidence) => evidence.dynamic);
  if (dynamicHits.length > 0) {
    return {
      kind: "dynamic-exempt-path",
      path: posix,
      detail: `dynamic construction of an exempt JSON path in non-gate code (${dynamicHits.join(", ")})`,
      remediation: PRESENTATION_CEILING_REMEDIATION,
    };
  }
  return null;
}

function artifactByPath(
  artifacts: readonly PresentationCeilingArtifact[],
): Map<string, PresentationCeilingArtifact> {
  const map = new Map<string, PresentationCeilingArtifact>();
  for (const art of artifacts) map.set(normalizeRepoRelPath(art.path), art);
  return map;
}

function isXbriefPath(relPath: string): boolean {
  return normalizeRepoRelPath(relPath).startsWith(XBRIEF_PREFIX);
}

function isCompletedXbrief(relPath: string): boolean {
  return normalizeRepoRelPath(relPath).startsWith(COMPLETED_PREFIX);
}

export function evaluatePresentationCeilingFromSnapshot(
  snapshot: PresentationCeilingSnapshot,
): PresentationCeilingResult {
  const changed = snapshot.changedFiles.map(normalizeRepoRelPath).filter((p) => p.length > 0);
  const baseMap = artifactByPath(snapshot.baseArtifacts);
  const headMap = artifactByPath(snapshot.headArtifacts);
  const addedRestrictions = snapshot.headArtifacts
    .filter((art) => !baseMap.has(normalizeRepoRelPath(art.path)))
    .map((art) => ({ ...art, extensionAmendment: null }));
  const headAddsRestriction = addedRestrictions.length > 0;
  const armed = snapshot.baseArtifacts.length > 0 || headAddsRestriction;

  if (!armed) {
    return {
      exitCode: 0,
      findings: [],
      message: `${GATE_ID}: skipped — no recorded presentation ceiling at merge-base or head restriction add. ${UNEVALUATED_NOTE}`,
      armed: false,
      evaluatedPaths: changed,
      unevaluatedNote: UNEVALUATED_NOTE,
    };
  }

  const findings: PresentationCeilingFinding[] = [];
  const productPaths = changed.filter((p) => {
    if (baseMap.has(p) || headMap.has(p)) return false;
    if (p === snapshot.baseActiveXbriefPath) return false;
    return true;
  });

  for (const [basePath, baseArt] of baseMap.entries()) {
    const headArt = headMap.get(basePath);
    if (headArt !== undefined) {
      const baseAllowed = effectivePresentationExts([{ ...baseArt, extensionAmendment: null }]);
      const headAllowed = effectivePresentationExts([{ ...headArt, extensionAmendment: null }]);
      if ([...headAllowed].some((ext) => !baseAllowed.has(ext))) {
        findings.push({
          kind: "ceiling-weaken",
          path: basePath,
          detail: "head allowlist weakens a merge-base presentation restriction",
          remediation: WEAKEN_REMEDIATION,
        });
      }
      continue;
    }
    if (snapshot.headFileContents.has(basePath)) {
      findings.push({
        kind: "ceiling-weaken",
        path: basePath,
        detail: "same-PR weaken of a merge-base presentation ceiling",
        remediation: WEAKEN_REMEDIATION,
      });
      continue;
    }
    const authorized = baseArt.removalStamp !== null;
    if (!authorized) {
      findings.push({
        kind: "ceiling-removal",
        path: basePath,
        detail:
          productPaths.length > 0
            ? `ceiling-bound path removed/moved and mixed with product paths (${productPaths.join(", ")})`
            : "ceiling-bound path removed or renamed without a merge-base removal stamp",
        remediation: REMOVAL_REMEDIATION,
      });
    } else if (productPaths.length > 0) {
      findings.push({
        kind: "ceiling-removal",
        path: basePath,
        detail: `removal stamp cannot mix with product paths (${productPaths.join(", ")})`,
        remediation: REMOVAL_REMEDIATION,
      });
    }
  }

  // Head-only additions can narrow built-ins; only baseline stamps grant extras.
  const effectiveExts = effectivePresentationExts([
    ...snapshot.baseArtifacts,
    ...addedRestrictions,
  ]);
  const testRoots = intersectRoots(snapshot.defaultTestRoots, snapshot.baseTestRoots);
  const fixtureRoots = intersectRoots(snapshot.defaultFixtureRoots, snapshot.baseFixtureRoots);
  const changelogReader = changelogHasProductionReader(snapshot);

  for (const rel of changed) {
    if (isCompletedXbrief(rel) && !isBuiltinPresentationPath(rel)) {
      findings.push({
        kind: "out-of-class-path",
        path: rel,
        detail: "xBRIEF completed-path is not exempt under a presentation ceiling",
        remediation: PRESENTATION_CEILING_REMEDIATION,
      });
      continue;
    }

    if (rel === CHANGELOG_REL) {
      if (changelogReader) {
        findings.push({
          kind: "changelog-production-reader",
          path: rel,
          detail:
            "CHANGELOG.md exemption does not hold while a non-gate production reader is present",
          remediation: PRESENTATION_CEILING_REMEDIATION,
        });
      }
      continue;
    }

    if (isJsonExemptCandidate(rel, snapshot)) {
      const pulled = jsonExemptionPulled(rel, snapshot);
      if (pulled !== null) findings.push(pulled);
      continue;
    }

    const ext = pathExtension(rel);
    if (effectiveExts.has(ext) && isBuiltinPresentationPath(rel)) {
      continue;
    }
    if (effectiveExts.has(ext) && !isBuiltinPresentationPath(rel)) {
      continue;
    }

    const underTestOrFixture =
      isUnderConfiguredRoot(rel, testRoots) || isUnderConfiguredRoot(rel, fixtureRoots);
    if (underTestOrFixture && isBuiltinPresentationPath(rel)) {
      continue;
    }

    if (baseMap.has(rel) || headMap.has(rel)) {
      continue;
    }

    if (isExtraCeremonyPath(rel)) {
      findings.push({
        kind: "extra-ceremony",
        path: rel,
        detail: "presentation-story ceremony is fail-closed extra ceremony, not P1",
        remediation: EXTRA_CEREMONY_REMEDIATION,
      });
      continue;
    }

    if (isXbriefPath(rel) && rel === snapshot.baseActiveXbriefPath) {
      continue;
    }

    findings.push({
      kind: "out-of-class-path",
      path: rel,
      detail:
        `changed path ${rel} is outside the built-in presentation extension set ` +
        `(ext=${ext || "none"}) under a recorded presentation ceiling`,
      remediation: PRESENTATION_CEILING_REMEDIATION,
    });
  }

  if (findings.length === 0) {
    return {
      exitCode: 0,
      findings: [],
      message: `${GATE_ID}: pass — ${String(changed.length)} changed path(s) within the presentation ceiling. ${UNEVALUATED_NOTE}`,
      armed: true,
      evaluatedPaths: changed,
      unevaluatedNote: UNEVALUATED_NOTE,
    };
  }

  const listed = findings.map((f) => `${f.kind}:${f.path}`).join("; ");
  return {
    exitCode: 1,
    findings,
    message: `${GATE_ID}: FAIL — ${String(findings.length)} finding(s): ${listed}. ${UNEVALUATED_NOTE}`,
    armed: true,
    evaluatedPaths: changed,
    unevaluatedNote: UNEVALUATED_NOTE,
  };
}

function configResult(message: string): PresentationCeilingResult {
  return {
    exitCode: 2,
    findings: [],
    message,
    armed: false,
    evaluatedPaths: [],
    unevaluatedNote: UNEVALUATED_NOTE,
  };
}

export function resolvePresentationCeilingBaseRef(projectRoot: string): string | null {
  const envCandidates = [
    process.env.DEFT_BASE_REF,
    process.env.GITHUB_BASE_REF ? `origin/${process.env.GITHUB_BASE_REF}` : undefined,
    process.env.GITHUB_BASE_REF,
  ].filter((x): x is string => typeof x === "string" && x.trim().length > 0);
  for (const cand of [...envCandidates, "origin/master", "origin/main", "master", "main"]) {
    const ran = git(["rev-parse", "--verify", "-q", cand], projectRoot);
    if (!ran.ok) {
      if (ran.kind === "not-found") return null;
      continue;
    }
    if (ran.status === 0) return cand;
  }
  return null;
}

type Collection<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly message: string };

function gitOutput(
  projectRoot: string,
  args: readonly string[],
  allowNoMatch = false,
): Collection<string> {
  const result = git(args, projectRoot);
  if (!result.ok) return result;
  if (result.status !== 0 && !(allowNoMatch && result.status === 1)) {
    return { ok: false, message: `git ${args[0]} failed (exit ${String(result.status)})` };
  }
  return { ok: true, value: result.stdout };
}

function paths(output: string): string[] {
  return output.split("\0").filter(Boolean).map(normalizeRepoRelPath);
}

function changedFilesVsBase(projectRoot: string, baseline: string): Collection<string[]> {
  const names = new Set<string>();
  for (const args of [
    ["diff", "--name-only", "--no-renames", "-z", baseline, "HEAD", "--"],
    ["diff", "--name-only", "--no-renames", "-z", "HEAD", "--"],
    ["ls-files", "--others", "--exclude-standard", "-z"],
  ]) {
    const result = gitOutput(projectRoot, args);
    if (!result.ok) return result;
    for (const path of paths(result.value)) names.add(path);
  }
  return { ok: true, value: [...names] };
}

function isCeilingCandidatePath(relPath: string): boolean {
  const posix = normalizeRepoRelPath(relPath);
  return (
    posix === PRESENTATION_CEILING_ARTIFACT_REL ||
    posix.endsWith("/presentation-ceiling.json") ||
    /^xbrief\/(?:active|pending|proposed)\/.*\.xbrief\.json$/.test(posix)
  );
}

/** Git grep distinguishes no matches (1) from a failed read (2+). */
function grepPaths(
  projectRoot: string,
  ref: string | null,
  patterns: readonly string[],
): Collection<string[]> {
  const args = ["grep", "-I", "-l", "-z", "-F"];
  for (const pattern of patterns) args.push("-e", pattern);
  if (ref !== null) args.push(ref);
  args.push("--");
  const result = gitOutput(projectRoot, args, true);
  if (!result.ok) return result;
  const prefix = ref === null ? "" : `${ref}:`;
  return {
    ok: true,
    value: paths(result.value).map((path) =>
      prefix && path.startsWith(prefix) ? path.slice(prefix.length) : path,
    ),
  };
}

function readContents(
  projectRoot: string,
  ref: string | null,
  names: readonly string[],
): Collection<Map<string, string>> {
  const contents = new Map<string, string>();
  for (const path of names) {
    if (ref !== null) {
      const result = gitOutput(projectRoot, ["show", `${ref}:${path}`]);
      if (!result.ok) return { ok: false, message: `${path}: ${result.message}` };
      contents.set(path, result.value);
    } else {
      try {
        contents.set(path, readFileSync(join(projectRoot, path), "utf8"));
      } catch (error) {
        // A tracked deletion is expected; every other read error fails closed.
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        return { ok: false, message: `cannot read ${path}: ${String(error)}` };
      }
    }
  }
  return { ok: true, value: contents };
}

function parseArtifacts(
  contents: ReadonlyMap<string, string>,
): Collection<PresentationCeilingArtifact[]> {
  const artifacts: PresentationCeilingArtifact[] = [];
  for (const [path, text] of contents) {
    if (!isCeilingCandidatePath(path)) continue;
    try {
      const payload: unknown = JSON.parse(text);
      if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
        return { ok: false, message: `invalid ceiling candidate object: ${path}` };
      }
      const artifact = parseCeilingPayload(payload, path);
      if (artifact !== null) artifacts.push(artifact);
    } catch {
      return { ok: false, message: `invalid ceiling candidate JSON: ${path}` };
    }
  }
  return { ok: true, value: artifacts };
}

function loadBaseRoots(
  contents: ReadonlyMap<string, string>,
): Collection<{ testRoots: readonly string[]; fixtureRoots: readonly string[] }> {
  const text = contents.get(".deft/test-boundary.policy.json");
  if (text === undefined)
    return {
      ok: true,
      value: { testRoots: DEFAULT_TEST_ROOTS, fixtureRoots: DEFAULT_FIXTURE_ROOTS },
    };
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed))
      return { ok: false, message: "invalid baseline test-boundary policy object" };
    const policy = parsed as Record<string, unknown>;
    for (const name of ["testRoots", "fixtureRoots"]) {
      const value = policy[name];
      if (
        value !== undefined &&
        (!Array.isArray(value) || value.some((root) => typeof root !== "string"))
      )
        return { ok: false, message: `invalid baseline test-boundary ${name}` };
    }
    return {
      ok: true,
      value: {
        testRoots: (policy.testRoots as string[] | undefined) ?? DEFAULT_TEST_ROOTS,
        fixtureRoots: (policy.fixtureRoots as string[] | undefined) ?? DEFAULT_FIXTURE_ROOTS,
      },
    };
  } catch {
    return { ok: false, message: "invalid baseline test-boundary policy JSON" };
  }
}

/** All baseline authority and readers use the one resolved merge-base commit. */
export function evaluatePresentationCeiling(
  projectRoot: string,
  options: PresentationCeilingOptions = {},
): PresentationCeilingResult {
  if (options.snapshot !== undefined)
    return evaluatePresentationCeilingFromSnapshot(options.snapshot);
  const root = resolve(projectRoot);
  const inside = gitOutput(root, ["rev-parse", "--is-inside-work-tree"]);
  if (!inside.ok) return configResult(`${GATE_ID}: ${inside.message}`);
  const ref =
    options.baseRef ?? process.env.DEFT_BASE_REF ?? resolvePresentationCeilingBaseRef(root);
  if (ref === null) return configResult(`${GATE_ID}: no merge-base ref; pass --base-ref`);
  const mergeBase = gitOutput(root, ["merge-base", "--", ref, "HEAD"]);
  if (!mergeBase.ok || !mergeBase.value.trim())
    return configResult(`${GATE_ID}: cannot resolve merge-base for ${ref}`);
  const baseline = mergeBase.value.trim();
  const changed = changedFilesVsBase(root, baseline);
  if (!changed.ok) return configResult(`${GATE_ID}: ${changed.message}`);
  const tree = gitOutput(root, ["ls-tree", "-r", "--name-only", "-z", baseline]);
  if (!tree.ok) return configResult(`${GATE_ID}: ${tree.message}`);
  const baseTree = paths(tree.value);
  const baseHits = grepPaths(root, baseline, [
    PRESENTATION_CEILING_PLAN_KEY,
    PRESENTATION_CEILING_SCHEMA,
    "changeClass",
  ]);
  const headHits = grepPaths(root, null, [
    PRESENTATION_CEILING_PLAN_KEY,
    PRESENTATION_CEILING_SCHEMA,
    "changeClass",
  ]);
  if (!baseHits.ok) return configResult(`${GATE_ID}: ${baseHits.message}`);
  if (!headHits.ok) return configResult(`${GATE_ID}: ${headHits.message}`);
  const baseNames = new Set(baseHits.value.filter(isCeilingCandidatePath));
  for (const path of baseTree) if (path.endsWith("/presentation-ceiling.json")) baseNames.add(path);
  const baseContents = readContents(root, baseline, [...baseNames]);
  const headNames = [
    ...new Set([...baseNames, ...headHits.value, ...changed.value].filter(isCeilingCandidatePath)),
  ];
  const headContents = readContents(root, null, headNames);
  if (!baseContents.ok) return configResult(`${GATE_ID}: ${baseContents.message}`);
  if (!headContents.ok) return configResult(`${GATE_ID}: ${headContents.message}`);
  const baseArtifacts = parseArtifacts(baseContents.value);
  const headArtifacts = parseArtifacts(headContents.value);
  if (!baseArtifacts.ok) return configResult(`${GATE_ID}: ${baseArtifacts.message}`);
  if (!headArtifacts.ok) return configResult(`${GATE_ID}: ${headArtifacts.message}`);
  const snapshot: PresentationCeilingSnapshot = {
    changedFiles: changed.value,
    baseArtifacts: baseArtifacts.value,
    headArtifacts: headArtifacts.value,
    baseActiveXbriefPath: null,
    baseActiveXbriefPaths: baseArtifacts.value
      .map((artifact) => artifact.path)
      .filter((path) => path.startsWith("xbrief/active/")),
    headFileContents: headContents.value,
    standingFileContents: new Map(),
    baseTestRoots: DEFAULT_TEST_ROOTS,
    baseFixtureRoots: DEFAULT_FIXTURE_ROOTS,
    defaultTestRoots: DEFAULT_TEST_ROOTS,
    defaultFixtureRoots: DEFAULT_FIXTURE_ROOTS,
  };
  if (baseArtifacts.value.length === 0 && headArtifacts.value.length === 0)
    return evaluatePresentationCeilingFromSnapshot(snapshot);

  const patterns = [
    "approved-scope",
    "scope-provenance",
    "@deftai/directive-core",
    ...LOADER_NAMES,
    "CHANGELOG",
    "presentation-ceiling",
    "xbrief/",
  ];
  const baseReaders = grepPaths(root, baseline, patterns);
  const headReaders = grepPaths(root, null, patterns);
  if (!baseReaders.ok) return configResult(`${GATE_ID}: ${baseReaders.message}`);
  if (!headReaders.ok) return configResult(`${GATE_ID}: ${headReaders.message}`);
  // Raw grep cannot see decoded JS/TS literals (for example "\\x43HANGELOG.md").
  // Parse every tracked script candidate, including unchanged readers.
  const scriptPath = (path: string) => /\.(?:[cm]?[jt]sx?|html?)$/i.test(path);
  const liveTree = gitOutput(root, ["ls-files", "-z"]);
  if (!liveTree.ok) return configResult(`${GATE_ID}: ${liveTree.message}`);
  const policyPath = ".deft/test-boundary.policy.json";
  const baselineFiles = readContents(root, baseline, [
    ...new Set([
      ...baseReaders.value,
      ...baseTree.filter(scriptPath),
      ...(baseTree.includes(policyPath) ? [policyPath] : []),
    ]),
  ]);
  const liveFiles = readContents(root, null, [
    ...new Set([
      ...headReaders.value,
      ...paths(liveTree.value).filter(scriptPath),
      ...changed.value,
    ]),
  ]);
  if (!baselineFiles.ok) return configResult(`${GATE_ID}: ${baselineFiles.message}`);
  if (!liveFiles.ok) return configResult(`${GATE_ID}: ${liveFiles.message}`);
  const roots = loadBaseRoots(baselineFiles.value);
  if (!roots.ok) return configResult(`${GATE_ID}: ${roots.message}`);
  return evaluatePresentationCeilingFromSnapshot({
    ...snapshot,
    baseFileContents: baselineFiles.value,
    standingFileContents: liveFiles.value,
    baseTestRoots: roots.value.testRoots,
    baseFixtureRoots: roots.value.fixtureRoots,
  });
}
