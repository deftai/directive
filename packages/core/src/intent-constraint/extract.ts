/**
 * Closed extract of throw/reject/abort sites and numeric consts (#4541).
 *
 * Numeric-const peel is a while-unwrap of AsExpression (any asserted type),
 * SatisfiesExpression, unary +/-, ParenthesizedExpression, and angle-bracket
 * TypeAssertion until NumericLiteral. Do not forEachChild-harvest NumericLiteral.
 */
import { createRequire } from "node:module";
import { join } from "node:path";
import type * as TS from "typescript";
import type { ConstraintFact, FactKind, SurfaceSnapshot } from "./types.js";

type TSModule = typeof TS;

const TS_CACHE = new Map<string, TSModule>();
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
  const same = out.filter((f) => f.kind === next.kind && f.id === next.id).length;
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

function loadTypeScript(projectRoot: string): TSModule | ExtractErr {
  const cached = TS_CACHE.get(projectRoot);
  if (cached !== undefined) return cached;
  const req = createRequire(join(projectRoot, "package.json"));
  let resolved: string;
  try {
    resolved = req.resolve("typescript");
  } catch {
    return {
      ok: false,
      code: "config",
      message: `no typescript resolvable from ${projectRoot}`,
    };
  }
  const mod = req(resolved) as TSModule | { default?: TSModule };
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
  TS_CACHE.set(projectRoot, ts);
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

function visit(node: TS.Node, ts: TSModule, facts: ConstraintFact[]): void {
  if (
    ts.isVariableDeclaration(node) &&
    ts.isIdentifier(node.name) &&
    node.initializer !== undefined
  ) {
    const peeled = peelNumeric(node.initializer, ts);
    if (peeled !== undefined) {
      const value = peeled.negative ? `-${peeled.text}` : peeled.text;
      pushFact(facts, fact("numeric-const", `numeric-const:${node.name.text}=${value}`, value));
    }
  }
  if (ts.isThrowStatement(node)) {
    pushFact(facts, fact("throw-site", `throw-site:${String(node.getStart())}`));
  }
  if (ts.isCallExpression(node)) {
    const name = calleeName(node, ts);
    if (name === "reject") {
      pushFact(facts, fact("reject-site", `reject-site:${String(node.getStart())}`));
    } else if (name === "abort") {
      pushFact(facts, fact("abort-site", `abort-site:${String(node.getStart())}`));
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
  const loaded = loadTypeScript(opts.projectRoot);
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
