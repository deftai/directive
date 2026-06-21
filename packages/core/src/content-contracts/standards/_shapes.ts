export interface ShapeSchema {
  name: string;
  requiredSections?: readonly string[];
  oneOfSections?: readonly string[];
  minH2Count?: number;
}

export const LANGUAGE_SHAPE: ShapeSchema = {
  name: "language",
  requiredSections: ["Standards", "Commands", "Patterns"],
};

export const STRATEGY_SHAPE: ShapeSchema = {
  name: "strategy",
  requiredSections: ["When to Use", "Workflow"],
};

export const INTERFACE_SHAPE: ShapeSchema = {
  name: "interface",
  oneOfSections: ["Core Architecture", "Framework Selection"],
};

export const TOOL_SHAPE: ShapeSchema = {
  name: "tool",
  minH2Count: 1,
};

const H2_RE = /^##\s+(.+)$/gm;

export function validateShape(text: string, schema: ShapeSchema): string[] {
  const headers: string[] = [];
  for (const m of text.matchAll(H2_RE)) {
    if (m[1]) {
      headers.push(m[1]);
    }
  }
  const headersLower = headers.map((h) => h.toLowerCase());
  const violations: string[] = [];

  for (const section of schema.requiredSections ?? []) {
    if (!headersLower.some((h) => h.includes(section.toLowerCase()))) {
      violations.push(`missing required section '## ${section}'`);
    }
  }

  if (schema.oneOfSections?.length) {
    const hit = schema.oneOfSections.some((s) =>
      headersLower.some((h) => h.includes(s.toLowerCase())),
    );
    if (!hit) {
      const options = schema.oneOfSections.map((s) => `'## ${s}'`).join(" or ");
      violations.push(`missing at least one of: ${options}`);
    }
  }

  const min = schema.minH2Count ?? 0;
  if (min > 0 && headers.length < min) {
    violations.push(`needs at least ${min} '##' section(s), found ${headers.length}`);
  }

  return violations;
}
