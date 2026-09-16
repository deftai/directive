/**
 * First-ship observable UI oracle (#4495 later-arc).
 *
 * Closed suffix/parser pairs: `.html` via parse5 (scriptingEnabled: false),
 * `.jsx`/`.tsx` via the consumer project's own TypeScript parser
 * (resolved, never bundled; parse-only). HTML `template` elements inside `.html` are in
 * scope; undeclared dialects (vue/svelte/njk/hbs/ejs/astro) are not.
 * Embedded scripts and subresource loading stay off. Extractor output is data.
 */

import { createRequire } from "node:module";
import { join } from "node:path";
import type * as TS from "typescript";
import {
  HTML_FRONTEND_VERSION as HTML_LITE_VERSION,
  type LiteElement,
  parseHtml,
} from "./html-spec.js";
import {
  type ArtifactParsers,
  OBSERVABLE_UI_ARTIFACT_SCHEMA,
  OBSERVABLE_UI_PROVIDER,
  OBSERVABLE_UI_PROVIDER_VERSION,
  type ObservableArtifact,
  type StructureFact,
  type StructureKind,
  type SurfaceSnapshot,
} from "./types.js";

const MARKUP_EXT = /\.(html|jsx|tsx)$/i;
const UNDECLARED_TEMPLATE_EXT = /\.(vue|svelte|njk|hbs|handlebars|ejs|astro)$/i;
const SCRIPT_SENTINEL = "__OBSERVABLE_SCOPE_SENTINEL";

type MarkupEl = LiteElement;

export function isMarkupPath(path: string): boolean {
  return MARKUP_EXT.test(path.replace(/\\/g, "/"));
}

export function isUndeclaredTemplatePath(path: string): boolean {
  return UNDECLARED_TEMPLATE_EXT.test(path.replace(/\\/g, "/"));
}

function fact(kind: StructureKind, id: string): StructureFact {
  return { kind, id };
}

function pushFact(out: StructureFact[], next: StructureFact): void {
  const same = out.filter(
    (f) => f.kind === next.kind && (f.id === next.id || f.id.startsWith(`${next.id}#`)),
  ).length;
  if (same === 0) {
    out.push(next);
    return;
  }
  out.push({ kind: next.kind, id: `${next.id}#${same + 1}` });
}

function normalizeText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function listOf(nodes: ArrayLike<MarkupEl>): MarkupEl[] {
  const out: MarkupEl[] = [];
  for (let i = 0; i < nodes.length; i += 1) {
    const item = nodes[i];
    if (item !== undefined) out.push(item);
  }
  return out;
}

function controlNameFromAttrs(
  name: string | undefined,
  ariaLabel: string | undefined,
  id: string | undefined,
  placeholder: string | undefined,
  inner: string,
): string {
  return name || ariaLabel || id || placeholder || inner;
}

function htmlSelected(el: MarkupEl): boolean {
  if (el.hasAttribute("selected")) {
    const v = el.getAttribute("selected");
    if (v === null || v === "" || v.toLowerCase() === "true" || v.toLowerCase() === "selected") {
      return true;
    }
  }
  const aria = el.getAttribute("aria-selected");
  return aria !== null && aria.toLowerCase() === "true";
}

function walkHtmlRoot(root: MarkupEl, facts: StructureFact[]): void {
  for (const el of listOf(root.querySelectorAll("h1,h2,h3,h4,h5,h6"))) {
    const level = el.tagName.toLowerCase().slice(1) || "1";
    const text = normalizeText(el.textContent ?? "");
    if (text.length === 0) continue;
    pushFact(facts, fact("heading", `heading:${level}:${text}`));
  }

  for (const el of listOf(root.querySelectorAll('[role="tab"]'))) {
    const text =
      normalizeText(el.textContent ?? "") ||
      el.getAttribute("aria-label") ||
      el.getAttribute("data-tab") ||
      "";
    if (text.length === 0) continue;
    pushFact(facts, fact("tab", `tab:${text}`));
    if (htmlSelected(el)) pushFact(facts, fact("tab-selected", `tab-selected:${text}`));
  }

  for (const el of listOf(root.querySelectorAll("button"))) {
    const name = controlNameFromAttrs(
      el.getAttribute("name") ?? undefined,
      el.getAttribute("aria-label") ?? undefined,
      el.getAttribute("id") ?? undefined,
      undefined,
      normalizeText(el.textContent ?? ""),
    );
    if (name.length === 0) continue;
    pushFact(facts, fact("control", `control:button:${name}`));
  }

  for (const el of listOf(root.querySelectorAll("input,select,textarea"))) {
    const tag = el.tagName.toLowerCase();
    const kind = tag === "select" ? "select" : tag === "textarea" ? "textarea" : "input";
    const name = controlNameFromAttrs(
      el.getAttribute("name") ?? undefined,
      el.getAttribute("aria-label") ?? undefined,
      el.getAttribute("id") ?? undefined,
      el.getAttribute("placeholder") ?? undefined,
      "",
    );
    if (name.length === 0) continue;
    pushFact(facts, fact("control", `control:${kind}:${name}`));
  }

  for (const el of listOf(root.querySelectorAll("th"))) {
    const text = normalizeText(el.textContent ?? "") || el.getAttribute("aria-label") || "";
    if (text.length === 0) continue;
    pushFact(facts, fact("table-column", `table-column:${text}`));
  }

  for (const el of listOf(root.querySelectorAll("header,nav,main,footer,aside"))) {
    const tag = el.tagName.toLowerCase();
    const name = el.getAttribute("aria-label") ?? el.getAttribute("id") ?? tag;
    pushFact(facts, fact("landmark", `landmark:${tag}:${name}`));
  }

  for (const el of listOf(
    root.querySelectorAll(
      '[role="banner"],[role="navigation"],[role="main"],[role="contentinfo"],[role="complementary"],[role="tablist"]',
    ),
  )) {
    const role = (el.getAttribute("role") ?? "").toLowerCase();
    if (role.length === 0) continue;
    const name = el.getAttribute("aria-label") ?? el.getAttribute("id") ?? role;
    pushFact(facts, fact("landmark", `landmark:${role}:${name}`));
  }

  for (const el of listOf(root.querySelectorAll("section,article"))) {
    const tag = el.tagName.toLowerCase();
    const name =
      el.getAttribute("aria-label") ?? el.getAttribute("id") ?? el.getAttribute("class") ?? tag;
    pushFact(facts, fact("container", `container:${tag}:${name}`));
  }
}

function extractHtmlFacts(source: string, path: string): StructureFact[] {
  const facts: StructureFact[] = [];
  // parse5 has no script engine, no window, no resource loader: the sentinel
  // check below is retained only so the existing test contract keeps guarding it.
  const before = (globalThis as Record<string, unknown>)[SCRIPT_SENTINEL];
  const { document, anomalies } = parseHtml(source);
  if ((globalThis as Record<string, unknown>)[SCRIPT_SENTINEL] !== before) {
    throw new Error("extractor executed embedded script; scripts must stay off");
  }
  if (anomalies.length > 0) {
    const first = anomalies[0];
    throw new ObservableScopeProviderError(
      "observable-scope-markup-unresolved",
      `${path}: parser could not resolve ${first?.kind ?? "construct"}` +
        (first?.tag !== undefined ? ` (<${first.tag}>)` : "") +
        ` at offset ${String(first?.offset ?? 0)}; ${String(anomalies.length)} anomaly(ies). ` +
        "Fix the markup or narrow the observable-ui surfaces policy; the oracle does not report a partial fact list.",
    );
  }
  walkHtmlRoot(document, facts);
  for (const tmpl of listOf(document.querySelectorAll("template"))) {
    if (tmpl.content !== undefined) walkHtmlRoot(tmpl.content as MarkupEl, facts);
  }
  return facts;
}

type TSModule = typeof TS;

/** Named-cause failure for missing/invalid parser material (fail closed, no fallback). */
export class ObservableScopeProviderError extends Error {
  constructor(
    readonly refusal:
      | "observable-scope-parser-unresolvable"
      | "observable-scope-parser-invalid"
      | "observable-scope-markup-unresolved",
    message: string,
  ) {
    super(`${refusal}: ${message}`);
    this.name = "ObservableScopeProviderError";
  }
}

const TS_CACHE = new Map<string, TSModule>();
const TYPESCRIPT_MAJOR_FLOOR = 5;

/**
 * Resolve the TypeScript parser by Node semantics from the *consumer project
 * root the evaluator is already operating on* (upward walk, so a hoisted
 * workspace root counts as the consumer's declared toolchain), never from
 * Directive's own bundle and never from process.cwd(). A project with
 * .jsx/.tsx surfaces already carries typescript; one that does not gets a
 * named-cause refusal. Not exported: the published declarations must not
 * reference the "typescript" module.
 */
function loadTypeScript(projectRoot: string): TSModule {
  const cached = TS_CACHE.get(projectRoot);
  if (cached !== undefined) return cached;
  const req = createRequire(join(projectRoot, "package.json"));
  let resolved: string;
  try {
    resolved = req.resolve("typescript");
  } catch {
    throw new ObservableScopeProviderError(
      "observable-scope-parser-unresolvable",
      `no \`typescript\` resolvable from ${projectRoot}; add it as a devDependency or narrow the observable-ui surfaces policy to exclude .jsx/.tsx`,
    );
  }
  const mod = req(resolved) as TSModule | { default?: TSModule };
  const ts = "createSourceFile" in mod ? mod : (mod as { default?: TSModule }).default;
  if (
    ts === undefined ||
    typeof ts.createSourceFile !== "function" ||
    typeof ts.version !== "string"
  ) {
    throw new ObservableScopeProviderError(
      "observable-scope-parser-invalid",
      `module at ${resolved} does not expose a TypeScript parser`,
    );
  }
  const major = Number.parseInt(ts.version.split(".")[0] ?? "0", 10);
  if (!Number.isFinite(major) || major < TYPESCRIPT_MAJOR_FLOOR) {
    throw new ObservableScopeProviderError(
      "observable-scope-parser-invalid",
      `typescript@${ts.version} at ${resolved} is below the supported floor ${String(TYPESCRIPT_MAJOR_FLOOR)}.x`,
    );
  }
  TS_CACHE.set(projectRoot, ts);
  return ts;
}

// Module-scoped binding used by the JSX walker; set per parse by extractJsxFacts.
let ts!: TSModule;

function jsxTagName(node: TS.JsxOpeningLikeElement): string {
  return node.tagName.getText();
}

function jsxAttr(
  node: TS.JsxOpeningLikeElement,
  name: string,
): { kind: "flag" | "literal" | "expr"; value?: string; ident?: string } | undefined {
  for (const attr of node.attributes.properties) {
    if (!ts.isJsxAttribute(attr)) continue;
    if (attr.name.getText() !== name) continue;
    if (attr.initializer === undefined) return { kind: "flag" };
    if (
      ts.isStringLiteral(attr.initializer) ||
      ts.isNoSubstitutionTemplateLiteral(attr.initializer)
    ) {
      return { kind: "literal", value: attr.initializer.text };
    }
    if (ts.isJsxExpression(attr.initializer) && attr.initializer.expression !== undefined) {
      const expr = attr.initializer.expression;
      if (expr.kind === ts.SyntaxKind.TrueKeyword) return { kind: "literal", value: "true" };
      if (expr.kind === ts.SyntaxKind.FalseKeyword) return { kind: "literal", value: "false" };
      if (ts.isStringLiteral(expr) || ts.isNoSubstitutionTemplateLiteral(expr)) {
        return { kind: "literal", value: expr.text };
      }
      if (ts.isIdentifier(expr)) return { kind: "expr", ident: expr.text };
      return { kind: "expr" };
    }
  }
  return undefined;
}

function jsxInnerText(node: TS.JsxElement): string {
  const parts: string[] = [];
  for (const child of node.children) {
    if (ts.isJsxText(child)) parts.push(child.text);
    else if (ts.isJsxExpression(child) && child.expression !== undefined) {
      if (
        ts.isStringLiteral(child.expression) ||
        ts.isNoSubstitutionTemplateLiteral(child.expression)
      ) {
        parts.push(child.expression.text);
      }
    }
  }
  return normalizeText(parts.join(" "));
}

function jsxSelected(open: TS.JsxOpeningLikeElement): boolean {
  const selected = jsxAttr(open, "selected");
  if (selected?.kind === "flag") return true;
  if (selected?.kind === "literal" && selected.value?.toLowerCase() === "true") return true;
  const aria = jsxAttr(open, "aria-selected");
  return aria?.kind === "literal" && aria.value?.toLowerCase() === "true";
}

function jsxControlName(open: TS.JsxOpeningLikeElement, inner: string): string {
  const literal = (name: string): string | undefined => {
    const a = jsxAttr(open, name);
    return a?.kind === "literal" ? a.value : undefined;
  };
  return controlNameFromAttrs(
    literal("name"),
    literal("aria-label"),
    literal("id"),
    literal("placeholder") ?? literal("label") ?? literal("title"),
    inner,
  );
}

/** Same-file const useState StringLiteral unwrap (#4586). Not the #4503 TabsTrigger recognizer. */
function isUseStateCallee(expr: TS.Expression): boolean {
  if (ts.isIdentifier(expr)) return expr.text === "useState";
  if (
    ts.isPropertyAccessExpression(expr) &&
    expr.questionDotToken === undefined &&
    ts.isIdentifier(expr.expression) &&
    expr.expression.text === "React" &&
    expr.name.text === "useState"
  ) {
    return true;
  }
  return false;
}

function collectUseStateBinding(decl: TS.VariableDeclaration, bindings: Map<string, string>): void {
  if (!ts.isVariableDeclarationList(decl.parent)) return;
  if ((decl.parent.flags & ts.NodeFlags.Const) === 0) return;
  if (decl.initializer === undefined || !ts.isCallExpression(decl.initializer)) return;
  if (!isUseStateCallee(decl.initializer.expression)) return;
  const arg0 = decl.initializer.arguments[0];
  if (arg0 === undefined || !ts.isStringLiteral(arg0)) return;
  if (!ts.isArrayBindingPattern(decl.name)) return;
  const first = decl.name.elements[0];
  if (first === undefined || ts.isOmittedExpression(first)) return;
  if (first.dotDotDotToken !== undefined) return;
  if (!ts.isIdentifier(first.name)) return;
  bindings.set(first.name.text, arg0.text);
}

function collectUseStateBindings(root: TS.Node): Map<string, string> {
  const bindings = new Map<string, string>();
  const walk = (node: TS.Node): void => {
    if (ts.isVariableDeclaration(node)) collectUseStateBinding(node, bindings);
    ts.forEachChild(node, walk);
  };
  walk(root);
  return bindings;
}

interface ControlledTabUnwrap {
  readonly bindings: ReadonlyMap<string, string>;
  readonly triggerLabels: Map<string, string>;
  readonly valueIdents: string[];
}

function emitUnwrappedTabSelected(facts: StructureFact[], unwrap: ControlledTabUnwrap): void {
  const seen = new Set<string>();
  for (const ident of unwrap.valueIdents) {
    if (seen.has(ident)) continue;
    seen.add(ident);
    const lit = unwrap.bindings.get(ident);
    if (lit === undefined) continue;
    const label = unwrap.triggerLabels.get(lit);
    if (label === undefined || label.length === 0) continue;
    pushFact(facts, fact("tab-selected", `tab-selected:${label}`));
  }
}

function visitJsx(node: TS.Node, facts: StructureFact[], unwrap: ControlledTabUnwrap): void {
  if (ts.isJsxSelfClosingElement(node) || ts.isJsxOpeningElement(node)) {
    const open = ts.isJsxSelfClosingElement(node) ? node : node;
    const parent = ts.isJsxOpeningElement(node) ? node.parent : undefined;
    const inner = parent !== undefined && ts.isJsxElement(parent) ? jsxInnerText(parent) : "";
    collectJsxFacts(open, inner, facts, unwrap);
  }
  ts.forEachChild(node, (child) => visitJsx(child, facts, unwrap));
}

function collectJsxFacts(
  open: TS.JsxOpeningLikeElement,
  inner: string,
  facts: StructureFact[],
  unwrap: ControlledTabUnwrap,
): void {
  const tag = jsxTagName(open);
  const lower = tag.toLowerCase();

  if (/^h[1-6]$/.test(lower) || tag === "Heading") {
    const levelAttr = jsxAttr(open, "level") ?? jsxAttr(open, "as");
    const level =
      lower.startsWith("h") && lower.length === 2
        ? lower.slice(1)
        : levelAttr?.kind === "literal"
          ? (levelAttr.value ?? "1")
          : "1";
    const text =
      inner ||
      (jsxAttr(open, "aria-label")?.kind === "literal"
        ? (jsxAttr(open, "aria-label")?.value ?? "")
        : "");
    if (text.length > 0) pushFact(facts, fact("heading", `heading:${level}:${text}`));
  }

  const role = jsxAttr(open, "role");
  const isTab =
    (role?.kind === "literal" && role.value === "tab") || tag === "Tab" || tag === "Tabs.Tab";
  if (isTab) {
    const text =
      inner ||
      (jsxAttr(open, "aria-label")?.kind === "literal"
        ? (jsxAttr(open, "aria-label")?.value ?? "")
        : "") ||
      (jsxAttr(open, "label")?.kind === "literal" ? (jsxAttr(open, "label")?.value ?? "") : "") ||
      (jsxAttr(open, "title")?.kind === "literal" ? (jsxAttr(open, "title")?.value ?? "") : "") ||
      (jsxAttr(open, "name")?.kind === "literal" ? (jsxAttr(open, "name")?.value ?? "") : "") ||
      (jsxAttr(open, "data-tab")?.kind === "literal"
        ? (jsxAttr(open, "data-tab")?.value ?? "")
        : "");
    if (text.length > 0) {
      pushFact(facts, fact("tab", `tab:${text}`));
      if (jsxSelected(open)) pushFact(facts, fact("tab-selected", `tab-selected:${text}`));
    }
  }

  if (tag === "TabsTrigger") {
    const triggerValue = jsxAttr(open, "value");
    if (
      triggerValue?.kind === "literal" &&
      triggerValue.value !== undefined &&
      triggerValue.value.length > 0
    ) {
      unwrap.triggerLabels.set(triggerValue.value, inner.length > 0 ? inner : triggerValue.value);
    }
  }
  const controlledValue = jsxAttr(open, "value");
  if (controlledValue?.kind === "expr" && controlledValue.ident !== undefined) {
    unwrap.valueIdents.push(controlledValue.ident);
  }

  if (lower === "button" || tag === "Button") {
    const name = jsxControlName(open, inner);
    if (name.length > 0) pushFact(facts, fact("control", `control:button:${name}`));
  }

  if (
    lower === "input" ||
    tag === "Input" ||
    lower === "select" ||
    tag === "Select" ||
    lower === "textarea" ||
    tag === "Textarea"
  ) {
    const kind =
      lower === "select" || tag === "Select"
        ? "select"
        : lower === "textarea" || tag === "Textarea"
          ? "textarea"
          : "input";
    const name = jsxControlName(open, "");
    if (name.length > 0) pushFact(facts, fact("control", `control:${kind}:${name}`));
  }

  if (lower === "th" || tag === "Th" || tag === "TableHead" || tag === "TableHeaderCell") {
    const text =
      inner ||
      (jsxAttr(open, "aria-label")?.kind === "literal"
        ? (jsxAttr(open, "aria-label")?.value ?? "")
        : "");
    if (text.length > 0) pushFact(facts, fact("table-column", `table-column:${text}`));
  }

  if (
    lower === "header" ||
    lower === "nav" ||
    lower === "main" ||
    lower === "footer" ||
    lower === "aside"
  ) {
    const name =
      (jsxAttr(open, "aria-label")?.kind === "literal"
        ? jsxAttr(open, "aria-label")?.value
        : undefined) ??
      (jsxAttr(open, "id")?.kind === "literal" ? jsxAttr(open, "id")?.value : undefined) ??
      lower;
    pushFact(facts, fact("landmark", `landmark:${lower}:${name}`));
  }

  if (role?.kind === "literal") {
    const r = role.value ?? "";
    if (["banner", "navigation", "main", "contentinfo", "complementary", "tablist"].includes(r)) {
      const name =
        (jsxAttr(open, "aria-label")?.kind === "literal"
          ? jsxAttr(open, "aria-label")?.value
          : undefined) ??
        (jsxAttr(open, "id")?.kind === "literal" ? jsxAttr(open, "id")?.value : undefined) ??
        r;
      pushFact(facts, fact("landmark", `landmark:${r}:${name}`));
    }
  }

  if (lower === "section" || lower === "article") {
    const name =
      (jsxAttr(open, "aria-label")?.kind === "literal"
        ? jsxAttr(open, "aria-label")?.value
        : undefined) ??
      (jsxAttr(open, "id")?.kind === "literal" ? jsxAttr(open, "id")?.value : undefined) ??
      (jsxAttr(open, "className")?.kind === "literal"
        ? jsxAttr(open, "className")?.value
        : undefined) ??
      lower;
    pushFact(facts, fact("container", `container:${lower}:${name}`));
  }
}

function extractJsxFacts(source: string, path: string, projectRoot: string): StructureFact[] {
  ts = loadTypeScript(projectRoot);
  const facts: StructureFact[] = [];
  const kind = path.replace(/\\/g, "/").toLowerCase().endsWith(".jsx")
    ? ts.ScriptKind.JSX
    : ts.ScriptKind.TSX;
  const sf = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, kind);
  const diagnostics =
    (sf as unknown as { parseDiagnostics?: readonly TS.DiagnosticWithLocation[] })
      .parseDiagnostics ?? [];
  if (diagnostics.length > 0) {
    const first = diagnostics[0];
    const message =
      first === undefined ? "parse error" : ts.flattenDiagnosticMessageText(first.messageText, " ");
    throw new ObservableScopeProviderError(
      "observable-scope-markup-unresolved",
      `${path}: ${String(diagnostics.length)} parse diagnostic(s); first: ${message}. The oracle does not report a partial fact list.`,
    );
  }
  const unwrap: ControlledTabUnwrap = {
    bindings: collectUseStateBindings(sf),
    triggerLabels: new Map(),
    valueIdents: [],
  };
  visitJsx(sf, facts, unwrap);
  emitUnwrappedTabSelected(facts, unwrap);
  return facts;
}

export interface ExtractOptions {
  /**
   * Consumer project root the evaluator is operating on; used to resolve the
   * .jsx/.tsx parser. Required for .jsx/.tsx surfaces. There is no cwd default.
   */
  readonly projectRoot?: string;
}

/** Extract a versioned snapshot from one first-ship source file. */
export function extractMarkupFacts(
  source: string,
  path = "snippet.html",
  opts: ExtractOptions = {},
): StructureFact[] {
  const norm = path.replace(/\\/g, "/");
  if (norm.toLowerCase().endsWith(".html")) return extractHtmlFacts(source, norm);
  if (norm.toLowerCase().endsWith(".jsx") || norm.toLowerCase().endsWith(".tsx")) {
    if (opts.projectRoot === undefined || opts.projectRoot.length === 0) {
      throw new ObservableScopeProviderError(
        "observable-scope-parser-unresolvable",
        `${norm}: no projectRoot supplied for a .jsx/.tsx surface; the evaluator must pass the project root it is operating on (no cwd default)`,
      );
    }
    return extractJsxFacts(source, norm, opts.projectRoot);
  }
  return [];
}

export function extractSurface(
  path: string,
  source: string,
  opts: ExtractOptions = {},
): SurfaceSnapshot {
  return { path: path.replace(/\\/g, "/"), facts: extractMarkupFacts(source, path, opts) };
}

/** Parser identity for one artifact, derived from the surfaces that artifact actually parsed. */
export function parsersFor(
  surfaces: readonly SurfaceSnapshot[],
  projectRoot: string | undefined,
): ArtifactParsers {
  const usedTs = surfaces.some((s) => /\.(jsx|tsx)$/i.test(s.path));
  return {
    html: HTML_LITE_VERSION,
    typescript: usedTs && projectRoot !== undefined ? loadTypeScript(projectRoot).version : null,
  };
}

export function buildArtifact(
  surfaces: readonly SurfaceSnapshot[],
  parsers: ArtifactParsers,
): ObservableArtifact {
  return {
    schema: OBSERVABLE_UI_ARTIFACT_SCHEMA,
    provider: OBSERVABLE_UI_PROVIDER,
    version: OBSERVABLE_UI_PROVIDER_VERSION,
    parsers,
    surfaces: [...surfaces].sort((a, b) => a.path.localeCompare(b.path)),
  };
}

export { SCRIPT_SENTINEL };
