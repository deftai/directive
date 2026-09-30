import { describe, expect, it } from "vitest";
import {
  agentsMdContainsExactPlaceholder,
  CONSUMER_HEADER_PLACEHOLDER_ONELINER,
  compareAndSetConsumerHeaderOneLiner,
  composeGreenfieldAgentsMd,
  containsRetiredUnmanagedHeaderPatterns,
  evaluateFirstShipHeaderPlaceholderGate,
  RETIRED_UNMANAGED_HEADER_SECTIONS,
  renderConsumerHeader,
  unmanagedHeaderOneLiner,
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
    expect(fail.message).toMatch(/compareAndSetConsumerHeaderOneLiner/);

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
