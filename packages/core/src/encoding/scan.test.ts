import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  type Finding,
  isVbriefNarrativeControlScope,
  renderFinding,
  scanFile,
  scanLine,
  suffixOf,
} from "./scan.js";

const root = mkdtempSync(join(tmpdir(), "deft-scan-test-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

let counter = 0;
function fixture(name: string, content: string | Buffer): string {
  const full = join(root, `${counter++}-${name}`);
  writeFileSync(full, content);
  return full;
}

function labels(findings: Finding[]): string[] {
  return findings.map((f) => f.label);
}

describe("suffixOf", () => {
  it("lowercases the final extension", () => {
    expect(suffixOf("a/b.MD")).toBe(".md");
    expect(suffixOf("a.tar.gz")).toBe(".gz");
  });
  it("returns empty for no/leading-dot extension", () => {
    expect(suffixOf("noext")).toBe("");
    expect(suffixOf(".hidden")).toBe("");
  });
  it("handles backslash paths (Windows edge case)", () => {
    expect(suffixOf("a\\b\\c.JSON")).toBe(".json");
  });
});

describe("renderFinding", () => {
  it("renders path:line [label] context", () => {
    expect(renderFinding({ path: "a.md", line: 3, label: "X", context: "ctx" })).toBe(
      "  a.md:3 [X] ctx",
    );
  });
  it("truncates long context to 117 chars + ellipsis", () => {
    const long = "z".repeat(200);
    const out = renderFinding({ path: "a", line: 1, label: "L", context: long });
    expect(out.endsWith("...")).toBe(true);
    expect(out).toContain("z".repeat(117));
    expect(out).not.toContain("z".repeat(118));
  });
});

describe("isVbriefNarrativeControlScope", () => {
  it("is true only for in-flight vBRIEFs", () => {
    expect(isVbriefNarrativeControlScope("vbrief/active/x.vbrief.json")).toBe(true);
    expect(isVbriefNarrativeControlScope("vbrief/proposed/x.vbrief.json")).toBe(true);
    expect(isVbriefNarrativeControlScope("vbrief/completed/x.vbrief.json")).toBe(false);
    expect(isVbriefNarrativeControlScope("vbrief/active/x.json")).toBe(false);
    expect(isVbriefNarrativeControlScope("notes.md")).toBe(false);
  });
  it("normalizes backslash paths (Windows edge case)", () => {
    expect(isVbriefNarrativeControlScope("vbrief\\active\\x.vbrief.json")).toBe(true);
  });
});

describe("scanLine", () => {
  it("flags U+FFFD", () => {
    expect(labels(scanLine("a", 1, "broke \ufffd here"))).toContain("U+FFFD replacement char");
  });
  it("flags cp437 and cp1252 bigrams", () => {
    expect(scanLine("a", 1, "x \u0393\u00a3\u00f4 y").length).toBe(1);
    expect(scanLine("a", 1, "x \u00e2\u20ac\u2122 y").length).toBe(1);
  });
  it("returns nothing for clean lines", () => {
    expect(scanLine("a", 1, "all clean ascii")).toEqual([]);
  });
});

describe("scanFile", () => {
  it("flags an unexpected BOM on .json", () => {
    const full = fixture(
      "bom.json",
      Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('{"a":1}')]),
    );
    expect(labels(scanFile("bom.json", full))).toContain("unexpected UTF-8 BOM");
  });
  it("tolerates a BOM on .ps1", () => {
    const full = fixture(
      "ok.ps1",
      Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("Write-Host 1\n")]),
    );
    expect(scanFile("ok.ps1", full)).toEqual([]);
  });
  it("skips binary files (NUL in first 1024 bytes)", () => {
    const full = fixture("bin.txt", Buffer.from("\u0000 \u0393\u00a3\u00f4 mojibake"));
    expect(scanFile("bin.txt", full)).toEqual([]);
  });
  it("ignores mojibake quoted inside markdown code spans", () => {
    const full = fixture("quoted.md", "see `\u0393\u00a3\u00f4` inline\n");
    expect(scanFile("quoted.md", full)).toEqual([]);
  });
  it("flags unquoted markdown mojibake at the right line after a fenced block", () => {
    const full = fixture(
      "fenced.md",
      "intro\n```\nignored \u0393\u00a3\u00f4\n```\nreal \u0393\u00a3\u00f4 hit\n",
    );
    const findings = scanFile("fenced.md", full);
    expect(findings.length).toBe(1);
    expect(findings[0]?.line).toBe(5);
  });
  it("detects control chars in an active vBRIEF narrative", () => {
    const content = `${JSON.stringify({ plan: { narratives: { problem: "bad\u000bvtab" } } }, null, 2)}\n`;
    const full = fixture("vb.vbrief.json", content);
    const findings = scanFile("vbrief/active/vb.vbrief.json", full);
    expect(labels(findings)).toContain("U+000B vertical tab in vBRIEF narrative");
  });
  it("does not scan narrative controls for non-in-flight vBRIEFs", () => {
    const content = `${JSON.stringify({ plan: { narratives: { problem: "bad\u000bvtab" } } }, null, 2)}\n`;
    const full = fixture("done.vbrief.json", content);
    expect(scanFile("vbrief/completed/done.vbrief.json", full)).toEqual([]);
  });
  it("flags a generic control char and a non-indentation tab in a narrative", () => {
    const content = `${JSON.stringify({ plan: { narratives: { a: "x\u0007y", b: "prose\there" } } }, null, 2)}\n`;
    const full = fixture("ctl.vbrief.json", content);
    const ls = labels(scanFile("vbrief/active/ctl.vbrief.json", full));
    expect(ls).toContain("U+0007 control character in vBRIEF narrative");
    expect(ls).toContain("U+0009 tab in vBRIEF narrative");
  });
  it("allows leading-indentation tabs in a narrative", () => {
    const content = `${JSON.stringify({ plan: { narratives: { a: "\t\tindented ok" } } }, null, 2)}\n`;
    const full = fixture("indent.vbrief.json", content);
    expect(scanFile("vbrief/active/indent.vbrief.json", full)).toEqual([]);
  });
  it("returns [] for an unreadable path", () => {
    expect(scanFile("missing.md", join(root, "does-not-exist.md"))).toEqual([]);
  });
  it("ignores malformed vBRIEF JSON without throwing", () => {
    const full = fixture("broken.vbrief.json", "{not json");
    expect(scanFile("vbrief/active/broken.vbrief.json", full)).toEqual([]);
  });

  it("ignores active vBRIEFs lacking a plan.narratives object", () => {
    const cases: Array<[string, unknown]> = [
      ["arr.vbrief.json", []],
      ["noplan.vbrief.json", { other: 1 }],
      ["planstr.vbrief.json", { plan: "x" }],
      ["narrstr.vbrief.json", { plan: { narratives: "x" } }],
      ["narrnum.vbrief.json", { plan: { narratives: { problem: 5 } } }],
    ];
    for (const [name, value] of cases) {
      const full = fixture(name, `${JSON.stringify(value)}\n`);
      expect(scanFile(`vbrief/active/${name}`, full)).toEqual([]);
    }
  });
});
