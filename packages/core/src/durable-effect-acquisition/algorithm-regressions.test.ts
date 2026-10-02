/**
 * Golden algorithm-regression corpus for durable-effect acquisition (#5080 / PR #5101).
 *
 * Pins escaped algorithm bugs: deleted-file classification, unchanged-effect deltas,
 * and admittedPackages exact-match importFact semantics. Prefer failing assertions with
 * // REGRESSION: … over weakening probes when production is wrong.
 */
import { describe, expect, it } from "vitest";
import { evaluateDurableEffectAcquisition } from "./evaluate.js";
import { classifyTsxSource, loadProjectTypeScript } from "./jsx.js";
import { PRESENTATION_CEILING_ARTIFACT_REL, PRESENTATION_CEILING_SCHEMA } from "./types.js";

const CEILING = `${JSON.stringify({
  schema: PRESENTATION_CEILING_SCHEMA,
  changeClass: "presentation",
})}\n`;

const COLLECTOR_HTML = `<img src="https://collector.example/p?u=demo">\n`;
const COLLECTOR_TSX = `export const I = () => <img src="https://collector.example/p" />;\n`;

/**
 * Injected-snapshot helper matching fixtures.test.ts `ev()`, with optional deletions.
 * Deleted paths stay in changedFiles / presentationFiles but readAtHead returns null.
 */
function ev(
  head: Record<string, string>,
  extra?: {
    base?: Record<string, string>;
    presentation?: string[];
    deleted?: readonly string[];
    changed?: readonly string[];
    ceiling?: string;
  },
) {
  const deleted = new Set(extra?.deleted ?? []);
  const changed = [...(extra?.changed ?? [...Object.keys(head), ...deleted])];
  const ceilingText = extra?.ceiling ?? CEILING;
  const baseFiles: Record<string, string> = {
    [PRESENTATION_CEILING_ARTIFACT_REL]: ceilingText,
    ...(extra?.base ?? {}),
  };
  return evaluateDurableEffectAcquisition({
    projectRoot: process.cwd(),
    mergeBase: "injected",
    changedFiles: changed,
    presentationFiles: extra?.presentation ?? changed.filter((p) => /\.(html|jsx|tsx)$/i.test(p)),
    readAtBase: (rel) => baseFiles[rel] ?? null,
    readAtHead: (rel) => {
      if (deleted.has(rel)) return null;
      return head[rel] ?? baseFiles[rel] ?? null;
    },
  });
}

function classify(source: string, admittedPackages: readonly string[]) {
  const ts = loadProjectTypeScript(process.cwd());
  if (!ts.ok) throw new Error(ts.detail);
  return classifyTsxSource("src/A.tsx", source, {
    ts: ts.ts,
    admittedOrigins: [],
    admittedPackages,
    admittedPaths: [],
  });
}

type Probe = {
  readonly id: string;
  readonly run: () => void;
};

const probes: readonly Probe[] = [
  {
    id: "deleted-file-not-classified",
    run: () => {
      // Base has a presentation file whose collector URL would create a durable-effect
      // fact; head deletes it. Expect clean success and no findings keyed to that path.
      const deletedPath = "src/Tracker.html";
      const result = ev(
        {},
        {
          base: { [deletedPath]: COLLECTOR_HTML },
          deleted: [deletedPath],
          changed: [deletedPath],
          presentation: [deletedPath],
        },
      );
      expect(result.code).toBe(0);
      const keyed = (result.findings ?? []).filter((f) => f.id.includes(deletedPath));
      expect(keyed).toEqual([]);
      // Control: same content introduced (not deleted) must still refuse.
      const introduced = ev({ [deletedPath]: COLLECTOR_HTML });
      expect(introduced.code).toBe(1);
    },
  },
  {
    id: "unchanged-effect-not-new",
    run: () => {
      // base === head for a presentation file that would otherwise classify.
      // Expect no NEW facts / empty delta (code clean).
      const path = "src/Banner.tsx";
      const result = ev(
        { [path]: COLLECTOR_TSX },
        { base: { [path]: COLLECTOR_TSX }, changed: [path], presentation: [path] },
      );
      expect(result.code).toBe(0);
      expect(result.findings ?? []).toEqual([]);
      // Control: changing the collector target is a new acquisition.
      const changed = ev(
        { [path]: `export const I = () => <img src="https://collector.example/other" />;\n` },
        { base: { [path]: COLLECTOR_TSX } },
      );
      expect(changed.code).toBe(1);
    },
  },
  {
    id: "admitted-package-exact-match",
    run: () => {
      // importFact: admittedPackages exact name continues; package/sub creates a fact
      // unless the exact subpath (or a future prefix policy) is itself admitted.
      const exact = classify(
        `import p from 'approved-package';\nexport const A = () => <div />;\n`,
        ["approved-package"],
      );
      expect(exact.ok).toBe(true);
      if (exact.ok) {
        expect(exact.facts.filter((f) => f.id.startsWith("import:"))).toEqual([]);
      }

      const sub = classify(
        `import p from 'approved-package/sub';\nexport const A = () => <div />;\n`,
        ["approved-package"],
      );
      expect(sub.ok).toBe(true);
      if (sub.ok) {
        expect(sub.facts.some((f) => f.id.startsWith("import:approved-package/sub"))).toBe(true);
      }

      // Exact subpath admission continues (still exact-match, not prefix).
      const subExact = classify(
        `import p from 'approved-package/sub';\nexport const A = () => <div />;\n`,
        ["approved-package/sub"],
      );
      expect(subExact.ok).toBe(true);
      if (subExact.ok) {
        expect(subExact.facts.filter((f) => f.id.startsWith("import:"))).toEqual([]);
      }

      // End-to-end: ceiling admit of exact package passes; subpath import refuses.
      const ceiling = `${JSON.stringify({
        schema: PRESENTATION_CEILING_SCHEMA,
        changeClass: "presentation",
        admittedPackages: ["approved-package"],
        humanApproval: { kind: "human", actor: "David", mintedAt: "2026-09-28T00:00:00Z" },
      })}\n`;
      const admitted = ev(
        {
          "src/A.tsx": `import p from 'approved-package';\nexport const A = () => <div className="a" />;\n`,
        },
        { ceiling },
      );
      expect(admitted.code).toBe(0);

      const subViaEval = ev(
        {
          "src/A.tsx": `import p from 'approved-package/sub';\nexport const A = () => <div className="a" />;\n`,
        },
        { ceiling },
      );
      expect(subViaEval.code).toBe(1);
      expect(
        (subViaEval.findings ?? []).some((f) => f.id.includes("import:approved-package/sub")),
      ).toBe(true);
    },
  },
];

describe("durable-effect algorithm regressions (#5101 class)", () => {
  it.each(probes.map((p) => [p.id, p] as const))("%s", (_id, probe) => {
    probe.run();
  });
});
