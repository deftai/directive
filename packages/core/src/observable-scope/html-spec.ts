/**
 * html-spec: the observable-scope HTML front end over parse5, the WHATWG
 * HTML Standard tree-construction implementation (the same parser jsdom uses),
 * run with the scripting flag disabled. parse5 has one dependency (`entities`),
 * no network, filesystem, or script-evaluation code, and no window or URL.
 * The walker's narrow `MarkupEl` interface is implemented over parse5's default
 * tree; nothing else of parse5's surface is exposed.
 */

import { type DefaultTreeAdapterMap, type ParserError, parse } from "parse5";

export const HTML_FRONTEND_VERSION = "parse5@7";

type P5Node = DefaultTreeAdapterMap["node"];
type P5Element = DefaultTreeAdapterMap["element"];
type P5Parent = DefaultTreeAdapterMap["parentNode"];
type P5Template = DefaultTreeAdapterMap["template"];

export interface LiteElement {
  readonly tagName: string;
  readonly textContent: string;
  readonly content?: LiteFragment;
  getAttribute(name: string): string | null;
  hasAttribute(name: string): boolean;
  querySelectorAll(selectors: string): LiteElement[];
}

export interface LiteFragment {
  querySelectorAll(selectors: string): LiteElement[];
}

export interface ParseAnomaly {
  readonly kind: string;
  readonly offset: number;
  readonly tag?: string;
}

export interface ParseResult {
  readonly document: LiteElement;
  readonly anomalies: readonly ParseAnomaly[];
}

function isElement(node: P5Node): node is P5Element {
  return "tagName" in node && typeof (node as P5Element).tagName === "string";
}

function isTemplate(node: P5Element): node is P5Template {
  return node.tagName === "template" && "content" in node;
}

function collectText(parent: P5Parent): string {
  let out = "";
  for (const child of parent.childNodes) {
    if (child.nodeName === "#text") out += (child as DefaultTreeAdapterMap["textNode"]).value;
    else if (isElement(child) && !isTemplate(child)) out += collectText(child);
  }
  return out;
}

// ---- selectors: tag | [attr] | [attr="value"] | tag[attr="value"], comma lists ----

interface SimpleSelector {
  readonly tag: string | null;
  readonly attrs: ReadonlyArray<{ name: string; value: string | null }>;
}

const SELECTOR_CACHE = new Map<string, SimpleSelector[]>();

function compileSelectorList(list: string): SimpleSelector[] {
  const cached = SELECTOR_CACHE.get(list);
  if (cached !== undefined) return cached;
  const compiled = list
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .map(compileSimple);
  SELECTOR_CACHE.set(list, compiled);
  return compiled;
}

function compileSimple(sel: string): SimpleSelector {
  const m = /^([a-zA-Z][\w-]*|\*)?((?:\[[^\]]*\])*)$/.exec(sel);
  if (m === null) {
    throw new Error(`html-spec: unsupported selector "${sel}" (tag / [attr] / [attr="v"] only)`);
  }
  const tag = m[1] === undefined || m[1] === "*" ? null : m[1].toLowerCase();
  const attrs: Array<{ name: string; value: string | null }> = [];
  const attrRe = /\[\s*([^\s=\]]+)\s*(?:=\s*(?:"([^"]*)"|'([^']*)'|([^\s\]]+)))?\s*\]/g;
  for (const a of (m[2] ?? "").matchAll(attrRe)) {
    attrs.push({ name: (a[1] ?? "").toLowerCase(), value: a[2] ?? a[3] ?? a[4] ?? null });
  }
  return { tag, attrs };
}

function attrValue(el: P5Element, name: string): string | undefined {
  const lower = name.toLowerCase();
  for (const a of el.attrs) {
    if (a.name.toLowerCase() === lower) return a.value;
  }
  return undefined;
}

function matches(el: P5Element, sels: readonly SimpleSelector[]): boolean {
  const lowerTag = el.tagName.toLowerCase();
  for (const s of sels) {
    if (s.tag !== null && s.tag !== lowerTag) continue;
    let ok = true;
    for (const a of s.attrs) {
      const v = attrValue(el, a.name);
      if (v === undefined || (a.value !== null && v !== a.value)) {
        ok = false;
        break;
      }
    }
    if (ok) return true;
  }
  return false;
}

/** Document order; does not descend into <template> content (DOM parity). */
function selectAll(parent: P5Parent, sels: readonly SimpleSelector[]): LiteElement[] {
  const out: LiteElement[] = [];
  const walk = (p: P5Parent): void => {
    for (const child of p.childNodes) {
      if (!isElement(child)) continue;
      if (matches(child, sels)) out.push(wrap(child));
      if (!isTemplate(child)) walk(child);
    }
  };
  walk(parent);
  return out;
}

const WRAP_CACHE = new WeakMap<P5Element, LiteElement>();

function wrapFragment(frag: P5Parent): LiteFragment {
  return { querySelectorAll: (s: string) => selectAll(frag, compileSelectorList(s)) };
}

function wrap(el: P5Element): LiteElement {
  const cached = WRAP_CACHE.get(el);
  if (cached !== undefined) return cached;
  const wrapped: LiteElement = {
    tagName: el.tagName.toUpperCase(),
    get textContent() {
      return isTemplate(el) ? "" : collectText(el);
    },
    content: isTemplate(el) ? wrapFragment(el.content) : undefined,
    getAttribute: (name: string) => attrValue(el, name) ?? null,
    hasAttribute: (name: string) => attrValue(el, name) !== undefined,
    querySelectorAll: (s: string) => selectAll(el, compileSelectorList(s)),
  };
  WRAP_CACHE.set(el, wrapped);
  return wrapped;
}

/**
 * Tokenizer/tree-construction codes that mean the input ended mid-construct.
 * WHATWG recovery would still emit a partial tree; extract.ts refuses when
 * any of these land in anomalies so the oracle never compares recovered
 * partial facts. Fragment HTML without a doctype is not incomplete.
 */
const INCOMPLETE_PARSE_CODES: ReadonlySet<string> = new Set([
  "eof-in-tag",
  "eof-before-tag-name",
  "eof-in-doctype",
  "eof-in-comment",
  "eof-in-cdata",
  "eof-in-script-html-comment-like-text",
  "eof-in-element-that-can-contain-only-text",
]);

/**
 * Parse a committed HTML source as a document with the scripting flag disabled.
 *
 * onParseError collects incomplete-token errors into anomalies. extract.ts
 * refuses when anomalies.length > 0. Recoverable tree-construction noise
 * (missing doctype on fragments, implied closes) is not an anomaly.
 */
export function parseHtml(source: string): ParseResult {
  const anomalies: ParseAnomaly[] = [];
  const doc = parse(source, {
    scriptingEnabled: false,
    onParseError: (err: ParserError) => {
      if (!INCOMPLETE_PARSE_CODES.has(err.code)) return;
      anomalies.push({ kind: err.code, offset: err.startOffset });
    },
  });
  const document: LiteElement = {
    tagName: "#DOCUMENT",
    get textContent() {
      return collectText(doc);
    },
    getAttribute: () => null,
    hasAttribute: () => false,
    querySelectorAll: (s: string) => selectAll(doc, compileSelectorList(s)),
  };
  return { document, anomalies };
}
