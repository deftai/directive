/**
 * Closed extract of throw/reject/abort sites and numeric consts (#4541).
 *
 * Numeric-const peel is a while-unwrap of AsExpression (any asserted type),
 * SatisfiesExpression, unary +/-, ParenthesizedExpression, and angle-bracket
 * TypeAssertion until NumericLiteral. Only const declarations; let/var loop
 * indexes are not numeric-const. Do not forEachChild-harvest NumericLiteral.
 */
import { createRequire } from "node:module";
import type * as TS from "typescript";
import type { ConstraintFact, FactKind, SurfaceSnapshot } from "./types.js";

type TSModule = typeof TS;

/**
 * Engine-relative TypeScript loader (#5194). Mirrors presentation-ceiling's
 * createRequire(import.meta.url). Intent-constraint admits .js, so consumer-root
 * resolve is not the supported path. Out of this ship: observable-scope and
 * durable-effect keep consumer-root for .jsx/.tsx.
 */
const requireParser = createRequire(import.meta.url);
let cachedParser: TSModule | undefined;

/** Clears the engine parser cache so loader tests start cold (#5194). */
export function resetTypeScriptParserCacheForTests(): void {
  cachedParser = undefined;
}

const PROD_EXT = /\.(ts|js)$/i;
const DECL_EXT = /\.d\.ts$/i;
const TEST_FILE = /\.(test|spec)\.(ts|js)$/i;
const TEST_DIR = /(^|\/)(__tests__|tests|test)(\/|$)/i;

export function isProductionSourcePath(path: string): boolean {
  const posix = path.replace(/\\/g, "/");
  if (!PROD_EXT.test(posix)) return false;
  if (DECL_EXT.test(posix)) return false;
  if (TEST_FILE.test(posix)) return false;
  if (TEST_DIR.test(posix)) return false;
  return true;
}

function fact(kind: FactKind, id: string, value?: string): ConstraintFact {
  return value === undefined ? { kind, id } : { kind, id, value };
}

function pushFact(out: ConstraintFact[], next: ConstraintFact): void {
  const same = out.filter(
    (f) => f.kind === next.kind && (f.id === next.id || f.id.startsWith(`${next.id}#`)),
  ).length;
  if (same === 0) {
    out.push(next);
    return;
  }
  out.push({ ...next, id: `${next.id}#${String(same + 1)}` });
}

export type ExtractOk = { readonly ok: true; readonly facts: ConstraintFact[] };
export type ExtractErr = {
  readonly ok: false;
  readonly code: "config";
  readonly message: string;
};
export type ExtractResult = ExtractOk | ExtractErr;

function loadTypeScript(): TSModule | ExtractErr {
  if (cachedParser !== undefined) return cachedParser;
  let resolved: string;
  try {
    resolved = requireParser.resolve("typescript");
  } catch {
    return {
      ok: false,
      code: "config",
      message: "no typescript resolvable from the Directive engine install",
    };
  }
  let mod: TSModule | { default?: TSModule };
  try {
    mod = requireParser(resolved) as TSModule | { default?: TSModule };
  } catch (err) {
    return {
      ok: false,
      code: "config",
      message: `typescript at ${resolved} failed to load from the Directive engine install: ${String(err)}`,
    };
  }
  const ts = "createSourceFile" in mod ? mod : (mod as { default?: TSModule }).default;
  if (
    ts === undefined ||
    typeof ts.createSourceFile !== "function" ||
    typeof ts.version !== "string"
  ) {
    return {
      ok: false,
      code: "config",
      message: `module at ${resolved} is not a TypeScript parser`,
    };
  }
  const major = Number.parseInt(ts.version.split(".")[0] ?? "0", 10);
  if (!Number.isFinite(major) || major < 5) {
    return {
      ok: false,
      code: "config",
      message: `typescript@${ts.version} at ${resolved} is below the supported floor 5.x`,
    };
  }
  cachedParser = ts;
  return ts;
}

function peelNumeric(
  node: TS.Expression,
  ts: TSModule,
): { readonly text: string; readonly negative: boolean } | undefined {
  let cur: TS.Node = node;
  let negative = false;
  while (true) {
    if (ts.isNumericLiteral(cur)) {
      return { text: cur.text, negative };
    }
    if (ts.isAsExpression(cur)) {
      cur = cur.expression;
      continue;
    }
    if (ts.isSatisfiesExpression(cur)) {
      cur = cur.expression;
      continue;
    }
    if (ts.isParenthesizedExpression(cur)) {
      cur = cur.expression;
      continue;
    }
    if (ts.isTypeAssertionExpression(cur)) {
      cur = cur.expression;
      continue;
    }
    if (ts.isPrefixUnaryExpression(cur)) {
      if (cur.operator === ts.SyntaxKind.MinusToken) {
        negative = !negative;
        cur = cur.operand;
        continue;
      }
      if (cur.operator === ts.SyntaxKind.PlusToken) {
        cur = cur.operand;
        continue;
      }
    }
    return undefined;
  }
}

function calleeName(node: TS.CallExpression, ts: TSModule): string {
  const callee = node.expression;
  if (ts.isIdentifier(callee)) return callee.text;
  if (ts.isPropertyAccessExpression(callee)) return callee.name.text;
  return "";
}

function compactSource(node: TS.Node): string {
  return node.getText().replace(/\s+/g, " ").trim();
}

function isConstVariableDeclaration(node: TS.VariableDeclaration, ts: TSModule): boolean {
  const parent = node.parent;
  return ts.isVariableDeclarationList(parent) && (parent.flags & ts.NodeFlags.Const) !== 0;
}

function visit(node: TS.Node, ts: TSModule, facts: ConstraintFact[]): void {
  if (
    ts.isVariableDeclaration(node) &&
    ts.isIdentifier(node.name) &&
    node.initializer !== undefined &&
    isConstVariableDeclaration(node, ts)
  ) {
    const peeled = peelNumeric(node.initializer, ts);
    if (peeled !== undefined) {
      const value = peeled.negative ? `-${peeled.text}` : peeled.text;
      pushFact(facts, fact("numeric-const", `numeric-const:${node.name.text}=${value}`, value));
    }
  }
  if (ts.isThrowStatement(node)) {
    pushFact(facts, fact("throw-site", `throw-site:${compactSource(node)}`));
  }
  if (ts.isCallExpression(node)) {
    const name = calleeName(node, ts);
    if (name === "reject") {
      pushFact(facts, fact("reject-site", `reject-site:${compactSource(node)}`));
    } else if (name === "abort") {
      pushFact(facts, fact("abort-site", `abort-site:${compactSource(node)}`));
    }
  }
  ts.forEachChild(node, (child) => visit(child, ts, facts));
}

export function extractConstraintFacts(
  source: string,
  path: string,
  opts: { readonly projectRoot: string },
): ExtractResult {
  const posix = path.replace(/\\/g, "/");
  if (!isProductionSourcePath(posix)) return { ok: true, facts: [] };
  // projectRoot remains in the public opts for call-site identity; parser
  // resolve is engine-relative (#5194) and does not consult the consumer tree.
  void opts.projectRoot;
  const loaded = loadTypeScript();
  if ("ok" in loaded && loaded.ok === false) return loaded;
  const ts = loaded as TSModule;
  const kind = posix.toLowerCase().endsWith(".js") ? ts.ScriptKind.JS : ts.ScriptKind.TS;
  const sf = ts.createSourceFile(posix, source, ts.ScriptTarget.Latest, true, kind);
  const facts: ConstraintFact[] = [];
  visit(sf, ts, facts);
  return { ok: true, facts };
}

export function extractSurface(
  path: string,
  source: string,
  opts: { readonly projectRoot: string },
): ExtractResult & { readonly path?: string } {
  const extracted = extractConstraintFacts(source, path, opts);
  if (!extracted.ok) return extracted;
  return extracted;
}

export function surfaceSnapshot(path: string, facts: readonly ConstraintFact[]): SurfaceSnapshot {
  return { path: path.replace(/\\/g, "/"), facts };
}
