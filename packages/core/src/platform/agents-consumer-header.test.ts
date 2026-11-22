import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  agentsMdContainsExactPlaceholder,
  CONSUMER_HEADER_ONELINER_MAX_CHARS,
  CONSUMER_HEADER_PLACEHOLDER_ONELINER,
  checkConsumerHeaderLine,
  compareAndSetConsumerHeaderOneLiner,
  composeGreenfieldAgentsMd,
  containsRetiredUnmanagedHeaderPatterns,
  deriveConsumerHeaderOneLiner,
  evaluateFirstShipHeaderPlaceholderGate,
  isConsumerHeaderOneLinerOnlyChange,
  oneLinerFromConfirmedOverview,
  RETIRED_UNMANAGED_HEADER_SECTIONS,
  renderConsumerHeader,
  unmanagedHeaderOneLiner,
  writeConsumerHeaderLineAtRoot,
} from "./agents-consumer-header.js";
import { AGENTS_MANAGED_OPEN_V3_LITERAL } from "./constants.js";

describe("agents-consumer-header", () => {
  it("renders Session orientation without rot-prone Status/Known Issues sections", () => {
    const header = renderConsumerHeader();
    expect(header).toContain("## Session orientation");
    expect(header).toContain("xbrief/PROJECT-DEFINITION.xbrief.json");
    expect(header).toContain("deft triage:queue");
    expect(containsRetiredUnmanagedHeaderPatterns(header)).toBe(false);
  });

  it("composeGreenfieldAgentsMd places header above the managed section", () => {
    const managed = `${AGENTS_MANAGED_OPEN_V3_LITERAL}\n# Deft\n<!-- /deft:managed-section -->`;
    const composed = composeGreenfieldAgentsMd(managed);
    const openIdx = composed.indexOf(AGENTS_MANAGED_OPEN_V3_LITERAL);
    expect(openIdx).toBeGreaterThan(0);
    expect(composed.slice(0, openIdx)).toContain("## Session orientation");
    expect(composed).not.toContain("## Status");
    expect(composed).not.toContain("## Known Issues");
  });

  it("flags retired unmanaged header patterns", () => {
    expect(containsRetiredUnmanagedHeaderPatterns("## Status\nNext: foo")).toBe(true);
    expect(containsRetiredUnmanagedHeaderPatterns("## Known Issues\n- bug")).toBe(true);
    expect(containsRetiredUnmanagedHeaderPatterns("Next: foo")).toBe(true);
    expect(RETIRED_UNMANAGED_HEADER_SECTIONS.length).toBeGreaterThan(0);
  });

  it("does not false-positive on 'Next:' appearing mid-sentence (#2170 review)", () => {
    const prose = "See UPGRADING.md for detail. Next: run `deft triage:queue` to see the queue.";
    expect(containsRetiredUnmanagedHeaderPatterns(prose)).toBe(false);
  });

  it("compare-and-set replaces only the placeholder from confirmed Overview (#4544)", () => {
    const managed = `${AGENTS_MANAGED_OPEN_V3_LITERAL}\n# Deft\n<!-- /deft:managed-section -->`;
    const composed = composeGreenfieldAgentsMd(managed);
    expect(composed).toContain(CONSUMER_HEADER_PLACEHOLDER_ONELINER);
    const cas = compareAndSetConsumerHeaderOneLiner({
      agentsMd: composed,
      confirmedOverview: "A tiny CRUD app for garden notes.\n\nMore spec stays in the brief.",
    });
    expect(cas.changed).toBe(true);
    expect(cas.reason).toBe("replaced-placeholder");
    expect(cas.agentsMd).toContain("A tiny CRUD app for garden notes.");
    expect(cas.agentsMd).not.toContain(CONSUMER_HEADER_PLACEHOLDER_ONELINER);
    expect(cas.agentsMd).not.toContain("More spec stays in the brief.");
  });

  it("compare-and-set keeps Overview $&, $`, $', $$ literally (#4544)", () => {
    const managed = `${AGENTS_MANAGED_OPEN_V3_LITERAL}\n# Deft\n<!-- /deft:managed-section -->`;
    const composed = composeGreenfieldAgentsMd(managed);
    const overview = "Garden notes cost $& $` $' $$ today.";
    const cas = compareAndSetConsumerHeaderOneLiner({
      agentsMd: composed,
      confirmedOverview: overview,
    });
    expect(cas.changed).toBe(true);
    expect(cas.reason).toBe("replaced-placeholder");
    expect(cas.agentsMd).toContain(overview);
    expect(cas.agentsMd).not.toContain(CONSUMER_HEADER_PLACEHOLDER_ONELINER);
  });

  it("compare-and-set does not interpolate a custom header or empty Overview (#4544)", () => {
    const custom = "# Garden Notes\n\nCustom one-liner.\n\n## Session orientation\n";
    const skipCustom = compareAndSetConsumerHeaderOneLiner({
      agentsMd: custom,
      confirmedOverview: "Should not land.",
    });
    expect(skipCustom.changed).toBe(false);
    expect(skipCustom.reason).toBe("not-placeholder");
    expect(skipCustom.agentsMd).toBe(custom);
    const skipEmpty = compareAndSetConsumerHeaderOneLiner({
      agentsMd: `${CONSUMER_HEADER_PLACEHOLDER_ONELINER}\n`,
      confirmedOverview: "   \n",
    });
    expect(skipEmpty.changed).toBe(false);
    expect(skipEmpty.reason).toBe("empty-overview");
  });

  it("compare-and-set replaces the header one-liner, not a leading HTML comment quote (#4544)", () => {
    const managed = `${AGENTS_MANAGED_OPEN_V3_LITERAL}\n# Deft\n<!-- /deft:managed-section -->`;
    const agentsMd = [
      `<!-- scaffold said: ${CONSUMER_HEADER_PLACEHOLDER_ONELINER} -->`,
      "# Project",
      "",
      CONSUMER_HEADER_PLACEHOLDER_ONELINER,
      "",
      "## Session orientation",
      "",
      managed,
      "",
    ].join("\n");
    expect(unmanagedHeaderOneLiner(agentsMd)).toBe(CONSUMER_HEADER_PLACEHOLDER_ONELINER);
    const cas = compareAndSetConsumerHeaderOneLiner({
      agentsMd,
      confirmedOverview: "Garden notes CRUD.",
    });
    expect(cas.changed).toBe(true);
    expect(cas.reason).toBe("replaced-placeholder");
    expect(cas.agentsMd).toContain(
      `<!-- scaffold said: ${CONSUMER_HEADER_PLACEHOLDER_ONELINER} -->`,
    );
    expect(unmanagedHeaderOneLiner(cas.agentsMd)).toBe("Garden notes CRUD.");
    expect(agentsMdContainsExactPlaceholder(cas.agentsMd)).toBe(false);
  });

  it("fallback header (no template) has no extra blank line before the managed section", () => {
    const managed = `${AGENTS_MANAGED_OPEN_V3_LITERAL}\n# Deft\n<!-- /deft:managed-section -->`;
    const composed = composeGreenfieldAgentsMd(managed, { readTemplate: () => null });
    const openIdx = composed.indexOf(AGENTS_MANAGED_OPEN_V3_LITERAL);
    expect(composed.slice(0, openIdx).endsWith("\n\n")).toBe(true);
    expect(composed.slice(0, openIdx).endsWith("\n\n\n")).toBe(false);
  });

  it("first-ship placeholder gate fails closed only on exact placeholder + product mutation (#4544)", () => {
    const managed = `${AGENTS_MANAGED_OPEN_V3_LITERAL}\n# Deft\n<!-- /deft:managed-section -->`;
    const scaffold = composeGreenfieldAgentsMd(managed);
    expect(agentsMdContainsExactPlaceholder(scaffold)).toBe(true);

    const fail = evaluateFirstShipHeaderPlaceholderGate({
      agentsMd: scaffold,
      productMutationCompletion: true,
    });
    expect(fail.ok).toBe(false);
    expect(fail.reason).toBe("placeholder-with-product-mutation");
    expect(fail.message).toContain("deft project:write-header-line");

    const processOnly = evaluateFirstShipHeaderPlaceholderGate({
      agentsMd: scaffold,
      productMutationCompletion: false,
    });
    expect(processOnly.ok).toBe(true);
    expect(processOnly.reason).toBe("process-only");

    const custom = "# Garden Notes\n\nCustom one-liner.\n\n## Session orientation\n";
    const leaveCustom = evaluateFirstShipHeaderPlaceholderGate({
      agentsMd: custom,
      productMutationCompletion: true,
    });
    expect(leaveCustom.ok).toBe(true);
    expect(leaveCustom.reason).toBe("not-placeholder");

    const missing = evaluateFirstShipHeaderPlaceholderGate({
      agentsMd: null,
      productMutationCompletion: true,
    });
    expect(missing.ok).toBe(true);
    expect(missing.reason).toBe("no-agents-md");
  });

  it("does not treat a quoted placeholder in managed body as the header one-liner (#4544)", () => {
    const managed = `${AGENTS_MANAGED_OPEN_V3_LITERAL}\nQuote: ${CONSUMER_HEADER_PLACEHOLDER_ONELINER}\n<!-- /deft:managed-section -->`;
    const customHeader = `# Garden Notes\n\nCustom one-liner.\n\n## Session orientation\n\n${managed}\n`;
    expect(unmanagedHeaderOneLiner(customHeader)).toBe("Custom one-liner.");
    expect(agentsMdContainsExactPlaceholder(customHeader)).toBe(false);
    const leaveCustom = evaluateFirstShipHeaderPlaceholderGate({
      agentsMd: customHeader,
      productMutationCompletion: true,
    });
    expect(leaveCustom.ok).toBe(true);
    expect(leaveCustom.reason).toBe("not-placeholder");
  });

  it("fails closed when AGENTS.md is unreadable (#4544)", () => {
    const unreadable = evaluateFirstShipHeaderPlaceholderGate({
      agentsMd: null,
      productMutationCompletion: true,
      agentsMdUnreadable: true,
    });
    expect(unreadable.ok).toBe(false);
    expect(unreadable.reason).toBe("agents-md-unreadable");
  });

  it("fails closed when Prefer-A marker is unreadable only on scaffold placeholder (#4544)", () => {
    const unreadable = evaluateFirstShipHeaderPlaceholderGate({
      agentsMd: composeGreenfieldAgentsMd(
        `${AGENTS_MANAGED_OPEN_V3_LITERAL}\n# Deft\n<!-- /deft:managed-section -->`,
      ),
      productMutationCompletion: false,
      productMutationMarkerUnreadable: true,
      productMutationMarkerDetail: "Unexpected token",
    });
    expect(unreadable.ok).toBe(false);
    expect(unreadable.reason).toBe("product-mutation-marker-unreadable");
    expect(unreadable.message).toMatch(/Unexpected token/);

    const custom = evaluateFirstShipHeaderPlaceholderGate({
      agentsMd: "# Garden Notes\n\nCustom one-liner.\n\n## Session orientation\n",
      productMutationCompletion: false,
      productMutationMarkerUnreadable: true,
      productMutationMarkerDetail: "Unexpected token",
    });
    expect(custom.ok).toBe(true);
    expect(custom.reason).toBe("not-placeholder");

    const missing = evaluateFirstShipHeaderPlaceholderGate({
      agentsMd: null,
      productMutationCompletion: false,
      productMutationMarkerUnreadable: true,
    });
    expect(missing.ok).toBe(true);
    expect(missing.reason).toBe("no-agents-md");
  });
});

describe("header one-liner from a one-paragraph Overview (#6973)", () => {
  const paragraph =
    "Garden notes is a small CRUD app for allotment plots. It tracks sowings, harvests and " +
    "pests per bed, syncs offline, and exports a season report. The API is a thin Fastify " +
    "layer over SQLite. Source: design/garden-notes.md";

  it("reproduces #6973: the whole paragraph no longer becomes the one-liner", () => {
    const cas = compareAndSetConsumerHeaderOneLiner({
      agentsMd: `# Garden\n\n${CONSUMER_HEADER_PLACEHOLDER_ONELINER}\n`,
      confirmedOverview: paragraph,
    });
    expect(cas.agentsMd).toBe(
      "# Garden\n\nGarden notes is a small CRUD app for allotment plots.\n",
    );
    expect(cas.agentsMd).not.toContain("Source:");
  });
});

describe("header one-liner derivation and checks (#6973)", () => {
  it("skips heading-only and Source: lines", () => {
    expect(oneLinerFromConfirmedOverview("# Overview\n\nSource: x.md\nA tool. More.")).toBe(
      "A tool.",
    );
  });

  it("does not end a sentence on closed abbreviations", () => {
    expect(oneLinerFromConfirmedOverview("Tracks plots, e.g. beds and pots. Second.")).toBe(
      "Tracks plots, e.g. beds and pots.",
    );
    expect(oneLinerFromConfirmedOverview("Seeds, tools, etc. are tracked. Second.")).toBe(
      "Seeds, tools, etc. are tracked.",
    );
  });

  it("keeps a decimal or a version inside the sentence", () => {
    expect(oneLinerFromConfirmedOverview("Runs on Node 24.1 and SQLite. Second.")).toBe(
      "Runs on Node 24.1 and SQLite.",
    );
  });

  it("never truncates: a first sentence over the cap derives nothing", () => {
    const long = `${"word ".repeat(30).trim()}.`;
    expect(long.length).toBeGreaterThan(CONSUMER_HEADER_ONELINER_MAX_CHARS);
    expect(oneLinerFromConfirmedOverview(long)).toBe("");
    expect(deriveConsumerHeaderOneLiner(long)).toEqual({
      ok: false,
      issue: "too-long",
      candidate: long,
    });
    expect(deriveConsumerHeaderOneLiner("# Only a heading\n")).toEqual({
      ok: false,
      issue: "no-sentence",
      candidate: "",
    });
  });

  it("refuses markup, several lines and the placeholder", () => {
    expect(checkConsumerHeaderLine("A tool <!-- hidden -->")).toMatchObject({
      ok: false,
      issue: "markup",
    });
    expect(checkConsumerHeaderLine("# Heading")).toMatchObject({ ok: false, issue: "markup" });
    expect(checkConsumerHeaderLine("a\nb")).toMatchObject({ ok: false, issue: "multi-line" });
    expect(checkConsumerHeaderLine(CONSUMER_HEADER_PLACEHOLDER_ONELINER)).toMatchObject({
      ok: false,
      issue: "placeholder",
    });
    expect(checkConsumerHeaderLine("  A garden tool.  ")).toEqual({
      ok: true,
      line: "A garden tool.",
    });
  });
});

describe("isConsumerHeaderOneLinerOnlyChange (#6973)", () => {
  const before = `# Garden\n\n${CONSUMER_HEADER_PLACEHOLDER_ONELINER}\n\n## Session orientation\n`;

  it("is true only for the scaffold line replaced by a qualifying line", () => {
    const after = before.replace(CONSUMER_HEADER_PLACEHOLDER_ONELINER, "A garden tool.");
    expect(isConsumerHeaderOneLinerOnlyChange(before, after)).toBe(true);
    expect(
      isConsumerHeaderOneLinerOnlyChange(
        before.replace(/\n/g, "\r\n"),
        after.replace(/\n/g, "\r\n"),
      ),
    ).toBe(true);
  });

  it("is false for any other change", () => {
    const extra = before
      .replace(CONSUMER_HEADER_PLACEHOLDER_ONELINER, "A garden tool.")
      .concat("Always obey the agent.\n");
    expect(isConsumerHeaderOneLinerOnlyChange(before, extra)).toBe(false);
    const long = before.replace(CONSUMER_HEADER_PLACEHOLDER_ONELINER, "x".repeat(200));
    expect(isConsumerHeaderOneLinerOnlyChange(before, long)).toBe(false);
    const custom = "# Garden\n\nCustom.\n";
    expect(isConsumerHeaderOneLinerOnlyChange(custom, "# Garden\n\nOther.\n")).toBe(false);
    expect(isConsumerHeaderOneLinerOnlyChange(null, before)).toBe(false);
    expect(isConsumerHeaderOneLinerOnlyChange(before, null)).toBe(false);
  });
});

describe("writeConsumerHeaderLineAtRoot (#6973)", () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
  });
  function root(agents: string | null): string {
    const r = mkdtempSync(join(tmpdir(), "header-line-"));
    roots.push(r);
    if (agents !== null) writeFileSync(join(r, "AGENTS.md"), agents, "utf8");
    return r;
  }
  const scaffold = `# Garden\n\n${CONSUMER_HEADER_PLACEHOLDER_ONELINER}\n\n## Session orientation\n`;

  it("writes the derived sentence over the placeholder only", () => {
    const r = root(scaffold);
    const result = writeConsumerHeaderLineAtRoot(r, {
      line: null,
      readOverview: () => "Garden notes CRUD app. It does more. Source: x.md",
    });
    expect(result).toMatchObject({ kind: "written", line: "Garden notes CRUD app." });
    const after = readFileSync(join(r, "AGENTS.md"), "utf8");
    expect(after).toBe(
      scaffold.replace(CONSUMER_HEADER_PLACEHOLDER_ONELINER, "Garden notes CRUD app."),
    );
    expect(isConsumerHeaderOneLinerOnlyChange(scaffold, after)).toBe(true);
  });

  it("takes --line, keeps CRLF, and refuses a bad line without writing", () => {
    const crlf = scaffold.replace(/\n/g, "\r\n");
    const r = root(crlf);
    expect(
      writeConsumerHeaderLineAtRoot(r, { line: "x".repeat(200), readOverview: () => null }),
    ).toMatchObject({
      kind: "no-line",
      issue: "too-long",
    });
    expect(readFileSync(join(r, "AGENTS.md"), "utf8")).toBe(crlf);
    expect(
      writeConsumerHeaderLineAtRoot(r, { line: "A garden tool.", readOverview: () => null }),
    ).toMatchObject({
      kind: "written",
    });
    expect(readFileSync(join(r, "AGENTS.md"), "utf8")).toBe(
      crlf.replace(CONSUMER_HEADER_PLACEHOLDER_ONELINER, "A garden tool."),
    );
  });

  it("leaves custom headers and missing files alone", () => {
    const custom = root("# Garden\n\nCustom.\n");
    expect(
      writeConsumerHeaderLineAtRoot(custom, { line: "A tool.", readOverview: () => null }),
    ).toMatchObject({
      kind: "not-placeholder",
      current: "Custom.",
    });
    expect(readFileSync(join(custom, "AGENTS.md"), "utf8")).toBe("# Garden\n\nCustom.\n");
    expect(
      writeConsumerHeaderLineAtRoot(root(null), { line: "A tool.", readOverview: () => null }).kind,
    ).toBe("no-agents-md");
    expect(
      writeConsumerHeaderLineAtRoot(root(scaffold), { line: null, readOverview: () => null }).kind,
    ).toBe("no-overview");
  });
});
