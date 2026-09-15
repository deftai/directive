import { describe, expect, it } from "vitest";
import {
  extractConstraintFacts,
  extractSurface,
  isProductionSourcePath,
  surfaceSnapshot,
} from "./extract.js";

const root = process.cwd();

function kinds(source: string, path = "src/ingest.ts"): string[] {
  const result = extractConstraintFacts(source, path, { projectRoot: root });
  if (!result.ok) return [`ERR:${result.message}`];
  return result.facts.map((f) => f.kind).sort();
}

function values(source: string, path = "src/ingest.ts"): string[] {
  const result = extractConstraintFacts(source, path, { projectRoot: root });
  if (!result.ok) return [];
  return result.facts.filter((f) => f.kind === "numeric-const").map((f) => f.value ?? "");
}

function ids(source: string, path = "src/ingest.ts"): string[] {
  const result = extractConstraintFacts(source, path, { projectRoot: root });
  if (!result.ok) return [];
  return result.facts.map((f) => f.id);
}

describe("intent-constraint extract (#4541)", () => {
  it("recognizes production .ts/.js and excludes tests", () => {
    expect(isProductionSourcePath("src/ingest.ts")).toBe(true);
    expect(isProductionSourcePath("src/ingest.js")).toBe(true);
    expect(isProductionSourcePath("src/ingest.test.ts")).toBe(false);
    expect(isProductionSourcePath("src/ingest.spec.js")).toBe(false);
    expect(isProductionSourcePath("tests/ingest.ts")).toBe(false);
    expect(isProductionSourcePath("src/__tests__/ingest.ts")).toBe(false);
    expect(isProductionSourcePath("src/ingest.d.ts")).toBe(false);
    expect(isProductionSourcePath("src/App.tsx")).toBe(false);
  });

  it("posted throw + same-file const is numeric-const and throw-site", () => {
    const src = `
const MAX_ITEM_BYTES = 1024;
export function publish(input: { size: number }[]): void {
  for (const item of input) {
    if (item.size > MAX_ITEM_BYTES) {
      throw new Error("item exceeds limit");
    }
  }
}
`;
    expect(kinds(src)).toEqual(["numeric-const", "throw-site"]);
    expect(values(src)).toEqual(["1024"]);
  });

  it("same-file helper extract of posted fixture is in the snapshot", () => {
    const src = `
const MAX_ITEM_BYTES = 1024;
function tooBig(item: { size: number }): boolean {
  return item.size > MAX_ITEM_BYTES;
}
function rejectItem(item: { size: number }): void {
  if (tooBig(item)) {
    throw new Error("item exceeds limit");
  }
}
export function publish(input: { size: number }[]): void {
  for (const item of input) rejectItem(item);
}
`;
    expect(kinds(src)).toEqual(["numeric-const", "throw-site"]);
  });

  it("posted throw + inline literal is throw-site only", () => {
    const src = `
export function publish(input: { size: number }[]): void {
  for (const item of input) {
    if (item.size > 1024) {
      throw new Error("item exceeds limit");
    }
  }
}
`;
    expect(kinds(src)).toEqual(["throw-site"]);
  });

  it("skip + new numeric const is numeric-const, not leftover", () => {
    const src = `
const MAX = 1024;
export function publish(input: { size: number }[]): void {
  for (const item of input) {
    if (item.size > MAX) continue;
  }
}
`;
    expect(kinds(src)).toEqual(["numeric-const"]);
  });

  it("does not harvest let/for-loop numeric indexes as numeric-const", () => {
    const src = `
export function publish(input: { size: number }[]): void {
  for (let i = 0; i < input.length; i += 1) {
    void input[i];
  }
  let n = 1024;
  void n;
}
`;
    expect(kinds(src)).toEqual([]);
  });

  it("peels as const / as number / as any / satisfies / unary / paren / type assertion", () => {
    const src = `
const a = 1024 as const;
const b = 1024 as number;
const c = 1024 as any;
const d = 1024 satisfies number;
const e = +1024;
const f = -1024;
const g = (1024);
const h = <number>1024;
const i = <const>1024;
`;
    expect(kinds(src).every((k) => k === "numeric-const")).toBe(true);
    expect(values(src)).toEqual([
      "1024",
      "1024",
      "1024",
      "1024",
      "1024",
      "-1024",
      "1024",
      "1024",
      "1024",
    ]);
  });

  it("while-unwraps mixed nesting until NumericLiteral", () => {
    const src = `
const a = (1024 as number);
const b = 1024 as unknown as number;
const c = 1024 as const satisfies number;
const d = -(1024 as number);
const e = <number>(1024 as const);
`;
    expect(kinds(src).every((k) => k === "numeric-const")).toBe(true);
    expect(values(src)).toEqual(["1024", "1024", "1024", "-1024", "1024"]);
  });

  it("does not forEachChild-harvest Number() / object-field / NonNull / bigint / tilde", () => {
    const src = `
const a = Number(1024);
const b = { max: 1024 };
const c = 1024!;
const d = (1024 as number)!;
const e = 1024n;
const f = ~1024;
export function skip(xs: number[]): void {
  for (const x of xs) {
    if (x > 1024) continue;
  }
}
`;
    expect(kinds(src)).toEqual([]);
  });

  it("skip/filter/return-error + inline literal is leftover", () => {
    const src = `
export function skip(xs: number[]): number[] {
  return xs.filter((x) => x <= 1024);
}
export function ret(x: number): string | { error: string } {
  if (x > 1024) return { error: "too big" };
  return "ok";
}
`;
    expect(kinds(src)).toEqual([]);
  });

  it("Promise.reject + inline literal is reject-site", () => {
    const src = `
export function go(x: number): Promise<void> {
  if (x > 1024) return Promise.reject(new Error("no"));
  return Promise.resolve();
}
`;
    expect(kinds(src)).toEqual(["reject-site"]);
  });

  it("abort() + inline literal is abort-site", () => {
    const src = `
export function go(x: number, abort: () => void): void {
  if (x > 1024) abort();
}
`;
    expect(kinds(src)).toEqual(["abort-site"]);
  });

  it("snapshots path plus facts", () => {
    const src = "const MAX = 1024;\n";
    const extracted = extractConstraintFacts(src, "src/ingest.ts", { projectRoot: root });
    expect(extracted.ok).toBe(true);
    if (!extracted.ok) return;
    expect(surfaceSnapshot("src/ingest.ts", extracted.facts).path).toBe("src/ingest.ts");
    const surface = extractSurface("src/ingest.ts", src, { projectRoot: root });
    expect(surface.ok).toBe(true);
  });
  it("gives each duplicate throw a unique id", () => {
    const src = `
export function go(x: number): void {
  if (x > 1) throw new Error("no");
  if (x > 2) throw new Error("no");
  if (x > 3) throw new Error("no");
}
`;
    const throwIds = ids(src).filter((id) => id.startsWith("throw-site:"));
    expect(throwIds).toHaveLength(3);
    expect(new Set(throwIds).size).toBe(3);
  });

  it("keeps throw/reject/abort ids stable when unrelated text is inserted", () => {
    const src = `
const MAX_ITEM_BYTES = 1024;
export function publish(input: { size: number }[]): void {
  for (const item of input) {
    if (item.size > MAX_ITEM_BYTES) {
      throw new Error("item exceeds limit");
    }
  }
}
`;
    const prefixed = `const BANNER = "unrelated";\n${src}`;
    const before = ids(src).filter((id) => id.startsWith("throw-site:"));
    const after = ids(prefixed).filter((id) => id.startsWith("throw-site:"));
    expect(before).toEqual(after);
    expect(before[0]).toMatch(/throw-site:throw /);
    expect(before[0]).not.toMatch(/^throw-site:\d+$/);
  });

  it("extracts numeric-const plus throw from production .js", () => {
    const src = `
const MAX = 1024;
function go(x) {
  if (x > MAX) throw new Error("no");
}
`;
    expect(kinds(src, "src/ingest.js")).toEqual(["numeric-const", "throw-site"]);
  });
});
