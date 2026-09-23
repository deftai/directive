/**
 * Paired tests that do not exercise the program (#4543).
 *
 * Existence fails when every assertion only says an export is a function, or
 * when the file reads the paired source as text and expects strings. The read
 * is any non-assertion use of the paired filename, not a list of APIs. An
 * empty file still counts. A normal or dynamic module import is not a text
 * read. A raw or text import is. A missing import is not a failure.
 */

export type PlaceholderReason = "function-only" | "source-text";

type Lang = "js" | "py" | "go";

const ASSERTION_LAST = new Set([
  "expect",
  "assert",
  "ok",
  "equal",
  "strictEqual",
  "deepEqual",
  "toBe",
  "toEqual",
  "toStrictEqual",
  "toContain",
  "toMatch",
  "toMatchObject",
  "toHaveLength",
  "toBeDefined",
  "toBeUndefined",
  "toBeTypeOf",
  "toBeInstanceOf",
  "toBeNull",
  "toBeTruthy",
  "toBeFalsy",
  "toBeGreaterThan",
  "toBeLessThan",
  "toThrow",
  "Fatal",
  "Fatalf",
  "Error",
  "Errorf",
  "Fail",
  "FailNow",
]);

/** Needle callees. Their string arguments are expectations, not file reads. */
const CONTAINMENT_LAST = new Set([
  "toContain",
  "toMatch",
  "includes",
  "indexOf",
  "Contains",
  "HasPrefix",
  "HasSuffix",
  "Index",
]);

/** Exact equality. A string argument is an expectation, same as containment. */
const EXACT_STRING_LAST = new Set(["toBe", "toEqual", "toStrictEqual", "strictEqual"]);

const PY_FUNCTION_TYPES =
  "FunctionType|LambdaType|BuiltinFunctionType|BuiltinMethodType|MethodType";

export function placeholderReason(
  testSource: string,
  testRelPath: string,
  pairedSourceBasename: string,
): PlaceholderReason | null {
  const lang = languageOf(testRelPath);
  const stripped = stripComments(testSource, lang);
  if (
    readsPairedSourceAsText(testSource, stripped, lang, pairedSourceBasename) &&
    expectsStrings(stripped, lang)
  ) {
    return "source-text";
  }
  if (assertionsAreFunctionOnly(stripped, lang)) {
    return "function-only";
  }
  return null;
}

function languageOf(testRelPath: string): Lang {
  const lower = testRelPath.replace(/\\/g, "/").toLowerCase();
  if (lower.endsWith(".py")) return "py";
  if (lower.endsWith(".go")) return "go";
  return "js";
}

function readsPairedSourceAsText(
  original: string,
  stripped: string,
  lang: Lang,
  basename: string,
): boolean {
  if (basename.length === 0) return false;
  if (lang === "go" && embedNamesPairedFile(original, basename)) return true;
  for (const site of stringSites(stripped, lang)) {
    if (stringIsRead(site, basename)) return true;
  }
  return false;
}

function embedNamesPairedFile(source: string, basename: string): boolean {
  for (const line of source.split(/\r\n|[\n\r]/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("//go:embed")) continue;
    const rest = trimmed.slice("//go:embed".length).trim();
    for (const token of rest.split(/\s+/)) {
      if (mentionsPairedFile(token, basename)) return true;
    }
  }
  return false;
}

interface StringSite {
  readonly value: string;
  readonly codeBefore: string;
  readonly codeAfter: string;
}

function stringIsRead(site: StringSite, basename: string): boolean {
  if (!mentionsPairedFile(site.value, basename)) return false;
  if (isRawImport(site)) return true;
  if (isNormalImport(site)) return false;
  const callee = calleeName(site.codeBefore);
  if (callee !== null && (isAssertionCallee(callee) || isContainmentCallee(callee))) {
    return false;
  }
  return true;
}

function mentionsPairedFile(value: string, basename: string): boolean {
  const norm = value.replace(/\\/g, "/");
  const pathPart = norm.split("?")[0] ?? norm;
  return pathPart === basename || pathPart.endsWith(`/${basename}`);
}

function isRawImport(site: StringSite): boolean {
  if (!isImportShaped(site.codeBefore)) return false;
  if (/\?(?:raw|text|source)\b/.test(site.value)) return true;
  return /\b(?:assert|with)\s*:?\s*\{[^}]*type\s*:\s*["'](?:text|string)["']/.test(site.codeAfter);
}

function isNormalImport(site: StringSite): boolean {
  return isImportShaped(site.codeBefore) && !isRawImport(site);
}

function isImportShaped(codeBefore: string): boolean {
  const t = codeBefore.trimEnd();
  return (
    endsWithKeyword(t, "from") ||
    endsWithKeyword(t, "import") ||
    endsWithKeyword(t, "require") ||
    t.endsWith("import(") ||
    t.endsWith("require(") ||
    t.endsWith("require.resolve(")
  );
}

function endsWithKeyword(text: string, keyword: string): boolean {
  if (!text.endsWith(keyword)) return false;
  if (text.length === keyword.length) return true;
  return /[^A-Za-z0-9_$]/.test(text.charAt(text.length - keyword.length - 1));
}

function calleeName(codeBefore: string): string | null {
  const t = codeBefore.trimEnd();
  if (t.length === 0) return null;
  const last = t.charAt(t.length - 1);
  if (last !== "(" && last !== ",") return null;
  // The owning call is the '(' at depth 0 walking backward, so
  // strings.Contains(string(b), "needle") names Contains, not string.
  let depth = 0;
  for (let i = t.length - 1; i >= 0; i -= 1) {
    const c = t.charAt(i);
    if (c === ")") depth += 1;
    else if (c === "(") {
      if (depth === 0) {
        const before = t.slice(0, i).trimEnd();
        const match = /([A-Za-z_$][\w$.]*)$/.exec(before);
        return match?.[1] ?? null;
      }
      depth -= 1;
    }
  }
  return null;
}

function lastSegment(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot < 0 ? name : name.slice(dot + 1);
}

function isAssertionCallee(name: string): boolean {
  return ASSERTION_LAST.has(lastSegment(name));
}

function isContainmentCallee(name: string): boolean {
  return CONTAINMENT_LAST.has(lastSegment(name));
}

function isExactStringCallee(name: string): boolean {
  return EXACT_STRING_LAST.has(lastSegment(name));
}

function expectsStrings(stripped: string, lang: Lang): boolean {
  for (const site of stringSites(stripped, lang)) {
    if (site.value.length === 0) continue;
    const callee = calleeName(site.codeBefore);
    if (callee !== null && (isContainmentCallee(callee) || isExactStringCallee(callee))) {
      return true;
    }
    if (lang === "py" && /^\s*in\b/.test(site.codeAfter)) return true;
  }
  return false;
}

function assertionsAreFunctionOnly(stripped: string, lang: Lang): boolean {
  if (lang === "py") return pyAssertionsAreFunctionOnly(stripped);
  if (lang === "go") return goAssertionsAreFunctionOnly(stripped);
  return jsAssertionsAreFunctionOnly(stripped);
}

function looksLikeCall(source: string, afterIdent: number): boolean {
  return /^\s*(?:<[^>\n]+>\s*)?\(/.test(source.slice(afterIdent));
}

function jsAssertionsAreFunctionOnly(source: string): boolean {
  let saw = false;
  let i = 0;
  while (i < source.length) {
    const skipped = skipString(source, i, "js");
    if (skipped > i) {
      i = skipped;
      continue;
    }
    if (identAt(source, i, "expect")) {
      const parsed = parseExpect(source, i + "expect".length);
      if (parsed === null) {
        if (looksLikeCall(source, i + "expect".length)) return false;
        i += "expect".length;
        continue;
      }
      saw = true;
      if (!parsed.functionOnly) return false;
      i = parsed.end;
      continue;
    }
    if (identAt(source, i, "assert")) {
      const parsed = parseAssert(source, i + "assert".length);
      if (parsed === null) {
        if (looksLikeCall(source, i + "assert".length)) return false;
        i += "assert".length;
        continue;
      }
      saw = true;
      if (!parsed.functionOnly) return false;
      i = parsed.end;
      continue;
    }
    i += 1;
  }
  return saw;
}

interface ParsedAssertion {
  readonly end: number;
  readonly functionOnly: boolean;
}

function parseExpect(source: string, i: number): ParsedAssertion | null {
  let cursor = skipWs(source, i);
  if (source.startsWith("<", cursor)) {
    const generic = readBalanced(source, cursor, "<", ">");
    if (generic === null) return null;
    cursor = skipWs(source, generic.end);
  }
  const call = readBalanced(source, cursor, "(", ")");
  if (call === null) return null;
  const arg = call.inner;
  cursor = call.end;
  let not = false;
  const matchers: { not: boolean; name: string; args: string }[] = [];
  while (cursor < source.length) {
    cursor = skipWs(source, cursor);
    if (source.charAt(cursor) !== ".") break;
    cursor = skipWs(source, cursor + 1);
    const name = readIdent(source, cursor);
    if (name === null) break;
    cursor += name.length;
    if (name === "not") {
      not = true;
      continue;
    }
    if (name === "resolves" || name === "rejects") {
      return { end: cursor, functionOnly: false };
    }
    cursor = skipWs(source, cursor);
    if (source.charAt(cursor) !== "(") break;
    const args = readBalanced(source, cursor, "(", ")");
    if (args === null) return null;
    matchers.push({ not, name, args: args.inner });
    not = false;
    cursor = args.end;
  }
  if (matchers.length === 0) return { end: cursor, functionOnly: false };
  const functionOnly = matchers.every((matcher) =>
    matcherIsFunctionOnly(arg, matcher.not, matcher.name, matcher.args),
  );
  return { end: cursor, functionOnly };
}

function parseAssert(source: string, i: number): ParsedAssertion | null {
  let cursor = skipWs(source, i);
  let method: string | null = null;
  if (source.charAt(cursor) === ".") {
    const name = readIdent(source, cursor + 1);
    if (name === null) return null;
    method = name;
    cursor = skipWs(source, cursor + 1 + name.length);
  }
  const call = readBalanced(source, cursor, "(", ")");
  if (call === null) return null;
  return {
    end: call.end,
    functionOnly: assertIsFunctionOnly(method, call.inner),
  };
}

function matcherIsFunctionOnly(arg: string, not: boolean, name: string, args: string): boolean {
  if (argInvokesBehavior(arg)) return false;
  const literal = unquote(args.trim());
  if (name === "toBeTypeOf" && literal === "function" && !not) return true;
  if (
    (name === "toBe" || name === "toEqual" || name === "toStrictEqual") &&
    literal === "function" &&
    !not &&
    /\btypeof\b/.test(arg)
  ) {
    return true;
  }
  if (name === "toBeDefined" && !not && args.trim().length === 0) return true;
  if (name === "toBeUndefined" && not && args.trim().length === 0) return true;
  if (
    (name === "toBe" || name === "toEqual" || name === "toStrictEqual") &&
    !not &&
    /expect\.any\(\s*Function\s*\)/.test(args)
  ) {
    return true;
  }
  if (name === "toBeInstanceOf" && !not && args.trim() === "Function") return true;
  if (
    (name === "toBe" || name === "toEqual") &&
    !not &&
    (literal === "true" || args.trim() === "true") &&
    isTypeofFunctionExpr(arg)
  ) {
    return true;
  }
  return false;
}

function assertIsFunctionOnly(method: string | null, args: string): boolean {
  if (method === null || method === "ok") {
    return isTypeofFunctionExpr(args) && !argInvokesBehavior(args);
  }
  if (method === "equal" || method === "strictEqual" || method === "deepEqual") {
    const parts = splitArgs(args);
    const left = parts[0];
    const right = parts[1];
    if (left === undefined || right === undefined) return false;
    return (
      /\btypeof\b/.test(left) && unquote(right.trim()) === "function" && !argInvokesBehavior(left)
    );
  }
  return false;
}

function argInvokesBehavior(arg: string): boolean {
  return arg.replace(/\btypeof\b/g, "").includes("(");
}

function isTypeofFunctionExpr(expr: string): boolean {
  return /\btypeof\s+(?:\(?\s*)[\w$.]+\s*\)?\s*[!=]==?\s*["'`]function["'`]/.test(expr);
}

function pyAssertionsAreFunctionOnly(source: string): boolean {
  let saw = false;
  let i = 0;
  while (i < source.length) {
    const skipped = skipString(source, i, "py");
    if (skipped > i) {
      i = skipped;
      continue;
    }
    if (!identAt(source, i, "assert")) {
      i += 1;
      continue;
    }
    const bodyEnd = readAssertBody(source, i + "assert".length);
    const body = source.slice(i + "assert".length, bodyEnd).trim();
    saw = true;
    if (!pyBodyIsFunctionOnly(body)) return false;
    i = bodyEnd;
  }
  return saw;
}

function pyBodyIsFunctionOnly(body: string): boolean {
  const head = splitArgs(body)[0]?.trim() ?? body.trim();
  const normalized = head.replace(/\s*(?:==|is)\s*True$/i, "").trim();
  if (normalized.startsWith("not ") || normalized.startsWith("not(")) return false;
  const name = "[A-Za-z_][\\w.]*";
  const patterns = [
    new RegExp(`^callable\\s*\\(\\s*${name}\\s*\\)$`),
    new RegExp(`^inspect\\.isfunction\\s*\\(\\s*${name}\\s*\\)$`),
    new RegExp(`^inspect\\.isroutine\\s*\\(\\s*${name}\\s*\\)$`),
    new RegExp(`^isinstance\\s*\\(\\s*${name}\\s*,\\s*types\\.(?:${PY_FUNCTION_TYPES})\\s*\\)$`),
    new RegExp(`^type\\s*\\(\\s*${name}\\s*\\)\\s*(?:is|==)\\s*types\\.(?:${PY_FUNCTION_TYPES})$`),
  ];
  return patterns.some((pattern) => pattern.test(normalized));
}

function readAssertBody(source: string, i: number): number {
  let depth = 0;
  for (let j = i; j < source.length; j += 1) {
    const started = tryString(source, j, "py");
    if (started !== null) {
      j = started.end - 1;
      continue;
    }
    const c = source.charAt(j);
    if (c === "(" || c === "[" || c === "{") depth += 1;
    else if (c === ")" || c === "]" || c === "}") depth = Math.max(0, depth - 1);
    else if ((c === "\n" || c === "\r") && depth === 0) return j;
  }
  return source.length;
}

function goAssertionsAreFunctionOnly(source: string): boolean {
  let saw = false;
  let i = 0;
  while (i < source.length) {
    const skipped = skipString(source, i, "go");
    if (skipped > i) {
      i = skipped;
      continue;
    }
    if (!identAt(source, i, "if")) {
      i += 1;
      continue;
    }
    const parsed = parseGoIf(source, i + "if".length);
    if (parsed === null) {
      i += "if".length;
      continue;
    }
    if (parsed.fatal) {
      saw = true;
      if (!goCondIsFunctionOnly(parsed.cond)) return false;
    }
    i = parsed.end;
  }
  return saw;
}

function parseGoIf(
  source: string,
  i: number,
): { end: number; cond: string; fatal: boolean } | null {
  let depth = 0;
  let quote: string | null = null;
  let brace = -1;
  for (let j = i; j < source.length; j += 1) {
    const c = source.charAt(j);
    if (quote !== null) {
      if (c === "\\") {
        j += 1;
        continue;
      }
      if (c === quote) quote = null;
      continue;
    }
    if (c === "`") {
      const end = source.indexOf("`", j + 1);
      j = end < 0 ? source.length : end;
      continue;
    }
    if (c === '"') {
      quote = '"';
      continue;
    }
    if (c === "(") depth += 1;
    else if (c === ")") depth = Math.max(0, depth - 1);
    else if (c === "{" && depth === 0) {
      brace = j;
      break;
    }
  }
  if (brace < 0) return null;
  const body = readBalanced(source, brace, "{", "}");
  if (body === null) return null;
  return {
    end: body.end,
    cond: source.slice(i, brace),
    fatal: /\b(?:Fatal|Fatalf|Error|Errorf|Fail|FailNow)\b/.test(body.inner),
  };
}

function goCondIsFunctionOnly(cond: string): boolean {
  if (!/\breflect\.Func\b/.test(cond)) return false;
  const callRe = /([A-Za-z_][\w.]*)\s*\(/g;
  let match = callRe.exec(cond);
  while (match !== null) {
    const name = match[1] ?? "";
    if (name !== "reflect.TypeOf" && name !== "reflect.ValueOf" && name !== "Kind") {
      return false;
    }
    match = callRe.exec(cond);
  }
  return true;
}

function identAt(source: string, i: number, name: string): boolean {
  if (!source.startsWith(name, i)) return false;
  const before = i === 0 ? "" : source.charAt(i - 1);
  if (before === "." || /[A-Za-z0-9_$]/.test(before)) return false;
  const after = source.charAt(i + name.length);
  return !/[A-Za-z0-9_$]/.test(after);
}

function readIdent(source: string, i: number): string | null {
  const match = /^[A-Za-z_$][\w$]*/.exec(source.slice(i));
  return match?.[0] ?? null;
}

function skipWs(source: string, i: number): number {
  let j = i;
  while (j < source.length && /\s/.test(source.charAt(j))) j += 1;
  return j;
}

function unquote(value: string): string | null {
  const t = value.trim();
  if (t.length < 2) return null;
  const q = t.charAt(0);
  if ((q === '"' || q === "'" || q === "`") && t.endsWith(q)) {
    return t.slice(1, -1);
  }
  return null;
}

function splitArgs(args: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  let i = 0;
  while (i < args.length) {
    const skipped = skipString(args, i, "js");
    if (skipped > i) {
      i = skipped;
      continue;
    }
    const c = args.charAt(i);
    if (c === "(" || c === "[" || c === "{") depth += 1;
    else if (c === ")" || c === "]" || c === "}") depth = Math.max(0, depth - 1);
    else if (c === "," && depth === 0) {
      parts.push(args.slice(start, i));
      start = i + 1;
    }
    i += 1;
  }
  parts.push(args.slice(start));
  return parts;
}

function stripComments(source: string, lang: Lang): string {
  let out = "";
  let i = 0;
  while (i < source.length) {
    const line = lineStart(source, i);
    const embedAt = skipWs(source, line);
    if (lang === "go" && i === line && source.startsWith("//go:embed", embedAt)) {
      const lineEnd = source.indexOf("\n", i);
      const end = lineEnd < 0 ? source.length : lineEnd + 1;
      out += source.slice(i, end);
      i = end;
      continue;
    }
    const started = tryString(source, i, lang);
    if (started !== null) {
      out += source.slice(i, started.end);
      i = started.end;
      continue;
    }
    if (lang !== "py" && source.startsWith("//", i)) {
      const lineEnd = source.indexOf("\n", i);
      out += " ";
      i = lineEnd < 0 ? source.length : lineEnd;
      continue;
    }
    if (lang !== "py" && source.startsWith("/*", i)) {
      const end = source.indexOf("*/", i + 2);
      out += " ";
      i = end < 0 ? source.length : end + 2;
      continue;
    }
    if (lang === "py" && source.charAt(i) === "#") {
      const lineEnd = source.indexOf("\n", i);
      out += " ";
      i = lineEnd < 0 ? source.length : lineEnd;
      continue;
    }
    out += source.charAt(i);
    i += 1;
  }
  return out;
}

function lineStart(source: string, i: number): number {
  const prior = source.lastIndexOf("\n", i - 1);
  return prior < 0 ? 0 : prior + 1;
}

function stringSites(source: string, lang: Lang): StringSite[] {
  const sites: StringSite[] = [];
  let i = 0;
  let codeStart = 0;
  // Gaps only. A later argument must still see the callee before an earlier string.
  let codeBefore = "";
  while (i < source.length) {
    if (lang === "go" && source.charAt(i) === "'") {
      const end = consumeGoRune(source, i);
      if (end > i) {
        i = end;
        continue;
      }
    }
    const started = tryString(source, i, lang);
    if (started === null) {
      i += 1;
      continue;
    }
    codeBefore += source.slice(codeStart, i);
    sites.push({
      value: started.value,
      codeBefore,
      codeAfter: source.slice(started.end, started.end + 160),
    });
    i = started.end;
    codeStart = started.end;
  }
  return sites;
}

function skipString(source: string, i: number, lang: Lang): number {
  if (lang === "go" && source.charAt(i) === "'") {
    const end = consumeGoRune(source, i);
    if (end > i) return end;
  }
  const started = tryString(source, i, lang);
  return started === null ? i : started.end;
}

function tryString(source: string, i: number, lang: Lang): { end: number; value: string } | null {
  if (lang === "py") {
    const triple = pythonTripleAt(source, i);
    if (triple !== null) return consumeQuoted(source, i, triple);
  }
  const q = source.charAt(i);
  if (lang === "go") {
    if (q === "`") return consumeRaw(source, i);
    if (q === '"') return consumeQuoted(source, i, '"');
    return null;
  }
  if (q === "'" || q === '"') return consumeQuoted(source, i, q);
  if (q === "`") return consumeTemplate(source, i);
  return null;
}

function pythonTripleAt(source: string, i: number): string | null {
  if (source.startsWith('"""', i)) return '"""';
  if (source.startsWith("'''", i)) return "'''";
  return null;
}

function consumeQuoted(source: string, i: number, quote: string): { end: number; value: string } {
  let j = i + quote.length;
  let value = "";
  while (j < source.length) {
    if (source.startsWith(quote, j)) {
      return { end: j + quote.length, value };
    }
    if (source.charAt(j) === "\\" && j + 1 < source.length) {
      value += source.charAt(j + 1);
      j += 2;
      continue;
    }
    value += source.charAt(j);
    j += 1;
  }
  return { end: source.length, value };
}

function consumeRaw(source: string, i: number): { end: number; value: string } {
  const end = source.indexOf("`", i + 1);
  if (end < 0) return { end: source.length, value: source.slice(i + 1) };
  return { end: end + 1, value: source.slice(i + 1, end) };
}

function consumeTemplate(source: string, i: number): { end: number; value: string } {
  let j = i + 1;
  let value = "";
  while (j < source.length) {
    if (source.charAt(j) === "\\") {
      value += source.charAt(j + 1) ?? "";
      j += 2;
      continue;
    }
    if (source.charAt(j) === "`") return { end: j + 1, value };
    value += source.charAt(j);
    j += 1;
  }
  return { end: source.length, value };
}

function consumeGoRune(source: string, i: number): number {
  if (source.charAt(i) !== "'") return i;
  let j = i + 1;
  if (source.charAt(j) === "\\") j += 2;
  else j += 1;
  if (source.charAt(j) === "'") return j + 1;
  return i;
}

function readBalanced(
  source: string,
  i: number,
  open: string,
  close: string,
): { end: number; inner: string } | null {
  if (source.charAt(i) !== open) return null;
  let depth = 0;
  let quote: string | null = null;
  for (let j = i; j < source.length; j += 1) {
    const c = source.charAt(j);
    if (quote !== null) {
      if (c === "\\") {
        j += 1;
        continue;
      }
      if (c === quote) quote = null;
      continue;
    }
    if (c === "'" || c === '"' || c === "`") {
      quote = c;
      continue;
    }
    if (c === open) depth += 1;
    else if (c === close) {
      depth -= 1;
      if (depth === 0) return { end: j + 1, inner: source.slice(i + 1, j) };
    }
  }
  return null;
}
