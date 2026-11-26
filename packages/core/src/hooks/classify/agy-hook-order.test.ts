import { describe, expect, it } from "vitest";
import {
  AGY_DIRECTIVE_HOOK_NAME,
  AGY_HOOK_ORDER_OUTER_FINDINGS_SOURCE,
  AGY_HOOK_ORDER_REMEDIATION,
  type AgyHookFileSeams,
  agyConfigHasDirectiveEntry,
  agyHookOrderFindings,
  agyHookOrderFindingsFromText,
  agyHookOrderOuterSource,
  collectAgyHookOrderFindings,
  formatAgyHookOrderDenial,
} from "./agy-hook-order.js";

function hooks(names: Record<string, unknown>): string {
  const config: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(names)) config[name] = value;
  return JSON.stringify(config);
}

const PRE = { PreToolUse: [{ matcher: "*", hooks: [{ command: "x" }] }] };

/** In-memory hook files: path to text, plus folders that exist. */
function memory(files: Record<string, string>, dirs: Record<string, string[]>): AgyHookFileSeams {
  return {
    readText: (path) => {
      if (path in files) return files[path] as string;
      return null;
    },
    listDirs: (path) => dirs[path] ?? [],
  };
}

describe("agy hook files across scopes (#7378 n02 to n05)", () => {
  const WS = "/w";
  const HOME = "/h";
  const OWN = `${WS}/.agents/hooks.json`;

  it("reads workspace, workspace plugins, user scope and user plugins", () => {
    const seams = memory(
      {
        [OWN]: hooks({ [AGY_DIRECTIVE_HOOK_NAME]: PRE }),
        [`${HOME}/.gemini/config/hooks.json`]: hooks({ "zzzzz-user": PRE }),
        [`${HOME}/.gemini/config/plugins/p1/hooks.json`]: hooks({ "zzzzz-plug": PRE }),
        [`${WS}/.agents/plugins/w1/hooks.json`]: hooks({ "zzzzz-wsplug": PRE }),
      },
      {
        [`${HOME}/.gemini/config/plugins`]: ["p1"],
        [`${WS}/.agents/plugins`]: ["w1"],
      },
    );
    const findings = collectAgyHookOrderFindings([WS], HOME, seams);
    expect(findings.map((f) => f.name).sort()).toEqual([
      "zzzzz-plug",
      "zzzzz-user",
      "zzzzz-wsplug",
    ]);
    expect(findings.find((f) => f.name === "zzzzz-user")?.detail).toContain(
      `${HOME}/.gemini/config/hooks.json`,
    );
  });

  it("passes when every file is earlier or absent, and ignores earlier user hooks", () => {
    const seams = memory(
      {
        [OWN]: hooks({ [AGY_DIRECTIVE_HOOK_NAME]: PRE }),
        [`${HOME}/.gemini/config/hooks.json`]: hooks({ "aaaa-user": PRE }),
      },
      {},
    );
    expect(collectAgyHookOrderFindings([WS], HOME, seams)).toEqual([]);
  });

  it("treats Directive's name in a foreign file as an equal-name finding", () => {
    const seams = memory(
      { [`${HOME}/.gemini/config/hooks.json`]: hooks({ [AGY_DIRECTIVE_HOOK_NAME]: PRE }) },
      {},
    );
    expect(collectAgyHookOrderFindings([WS], HOME, seams).map((f) => f.kind)).toEqual([
      "equal-name",
    ]);
  });

  it("fails closed on an unreadable file, an unreadable folder and an empty workspace list", () => {
    const throwingRead: AgyHookFileSeams = {
      readText: () => {
        throw new Error("EACCES");
      },
      listDirs: () => [],
    };
    expect(collectAgyHookOrderFindings([WS], HOME, throwingRead).map((f) => f.kind)).toContain(
      "unparseable-config",
    );
    const throwingList: AgyHookFileSeams = {
      readText: () => null,
      listDirs: () => {
        throw new Error("EACCES");
      },
    };
    expect(collectAgyHookOrderFindings([WS], HOME, throwingList)[0]?.kind).toBe(
      "unparseable-config",
    );
    expect(collectAgyHookOrderFindings([], HOME, memory({}, {}))[0]?.kind).toBe(
      "unresolvable-workspace",
    );
  });

  it("skips user scope when no home is known and does not read a file twice", () => {
    const seams = memory({ [OWN]: hooks({ [AGY_DIRECTIVE_HOOK_NAME]: PRE }) }, {});
    expect(collectAgyHookOrderFindings([WS, WS], null, seams)).toEqual([]);
  });
});

describe("agy hook ordering predicate (#7378)", () => {
  it("keeps the entry name one constant", () => {
    expect(AGY_DIRECTIVE_HOOK_NAME).toBe("zzzz-directive");
  });

  it("reports nothing for earlier names and for Directive's own entry", () => {
    const text = hooks({
      [AGY_DIRECTIVE_HOOK_NAME]: PRE,
      "0-first": PRE,
      Aaa: PRE,
      ZZZZ: PRE,
      _under: PRE,
      "obs-a": PRE,
      "zzz-directive": PRE,
      zzzz: PRE,
      "zzzz-": PRE,
      "zzzz-directivd": PRE,
    });
    expect(agyHookOrderFindings(text)).toEqual([]);
  });

  it.each([
    ["zzzz-directive-x", "extends-directive-name"],
    ["zzzz-directive0", "extends-directive-name"],
    ["zzzz-directive_x", "extends-directive-name"],
    ["zzzz-directivf", "sorts-at-or-after"],
    ["zzzz.dot", "sorts-at-or-after"],
    ["zzzzz", "sorts-at-or-after"],
    ["~tilde", "sorts-at-or-after"],
    ["é-name", "out-of-observed-alphabet"],
    ["has space", "out-of-observed-alphabet"],
    ["a/b", "out-of-observed-alphabet"],
  ])("reports %s as at-or-after (%s)", (name, kind) => {
    const findings = agyHookOrderFindings(hooks({ [AGY_DIRECTIVE_HOOK_NAME]: PRE, [name]: PRE }));
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ name, kind });
  });

  it("counts a name equal to the constant as at-or-after when it is not the Directive entry key", () => {
    const findings = agyHookOrderFindingsFromText(hooks({ "late-x": PRE }), "late-x");
    expect(findings).toEqual([]);
    const other = agyHookOrderFindingsFromText(hooks({ "late-x": PRE, "late-x2": PRE }), "late-x");
    expect(other.map((f) => f.kind)).toEqual(["extends-directive-name"]);
  });

  it("ignores matcher and counts any non-empty PreToolUse list", () => {
    const matchers = ["*", "", "run_command", "write_file", "(", "browser_.*"];
    for (const matcher of matchers) {
      const findings = agyHookOrderFindings(
        hooks({ zzzzz: { PreToolUse: [{ matcher, hooks: [{ command: "x" }] }] } }),
      );
      expect(findings, `matcher ${JSON.stringify(matcher)}`).toHaveLength(1);
    }
  });

  it("skips entries that cannot run a PreToolUse hook", () => {
    const findings = agyHookOrderFindings(
      hooks({
        zzzzz: { SessionStart: [{ command: "x" }] },
        zzzzzz: { PreToolUse: [] },
        zzzzzzz: { enabled: false, ...PRE },
      }),
    );
    expect(findings).toEqual([]);
  });

  it("reports entries whose shape cannot be read", () => {
    const findings = agyHookOrderFindings(
      hooks({ alpha: "not-an-object", beta: { PreToolUse: { not: "a list" } }, gamma: [1] }),
    );
    expect(findings.map((f) => [f.name, f.kind])).toEqual([
      ["alpha", "undeterminable-entry"],
      ["beta", "undeterminable-entry"],
      ["gamma", "undeterminable-entry"],
    ]);
  });

  it("reports an unparseable config and a non-object root", () => {
    for (const text of ["{not json", "[]", "null", '"str"', ""]) {
      const findings = agyHookOrderFindings(text);
      expect(findings).toHaveLength(1);
      expect(findings[0]?.kind).toBe("unparseable-config");
    }
  });

  it("detects the Directive entry only in a valid object config", () => {
    expect(agyConfigHasDirectiveEntry(hooks({ [AGY_DIRECTIVE_HOOK_NAME]: PRE }))).toBe(true);
    expect(agyConfigHasDirectiveEntry(hooks({ other: PRE }))).toBe(false);
    expect(agyConfigHasDirectiveEntry("{bad")).toBe(false);
    expect(agyConfigHasDirectiveEntry("[]")).toBe(false);
  });

  it("formats one denial with every finding and the single remediation", () => {
    const text = formatAgyHookOrderDenial(
      agyHookOrderFindings(hooks({ zzzzz: PRE, "zzzz-directive-x": PRE })),
    );
    expect(text).toContain('Hook "zzzzz"');
    expect(text).toContain('Hook "zzzz-directive-x"');
    expect(text.split(AGY_HOOK_ORDER_REMEDIATION)).toHaveLength(2);
    expect(AGY_HOOK_ORDER_REMEDIATION).toContain(
      "deft policy:disable-host-hooks --host agy --confirm",
    );
  });

  it("carries the outer copy in the deposited source", () => {
    const source = agyHookOrderOuterSource();
    expect(source).toContain(AGY_HOOK_ORDER_OUTER_FINDINGS_SOURCE);
    expect(source).toContain("function agyHookOrderPayloadFindings(");
    expect(source).toContain(JSON.stringify(AGY_DIRECTIVE_HOOK_NAME));
  });

  it("conformance: the outer copy returns the same findings as the typed predicate", () => {
    const outerCopy = new Function(
      "Buffer",
      `${AGY_HOOK_ORDER_OUTER_FINDINGS_SOURCE}; return agyHookOrderFindingsFromText;`,
    )(Buffer) as (text: string, name: string, source?: string, ownFile?: boolean) => unknown;
    const names = [
      "0-first",
      "Aaa",
      "obs-a",
      "zzzz",
      "zzzz-directivd",
      "zzzz-directive",
      "zzzz-directive-x",
      "zzzz-directive0",
      "zzzz-directivf",
      "zzzzz",
      "~tilde",
      "é-name",
      "has space",
    ];
    const corpus: string[] = [
      "{bad",
      "[]",
      "null",
      "",
      hooks({ alpha: "x", beta: { PreToolUse: 1 } }),
    ];
    for (const name of names) {
      corpus.push(hooks({ [AGY_DIRECTIVE_HOOK_NAME]: PRE, [name]: PRE }));
      corpus.push(hooks({ [name]: { enabled: false, ...PRE } }));
      corpus.push(hooks({ [name]: { PreToolUse: [] } }));
      corpus.push(hooks({ [name]: { SessionStart: [{ command: "x" }] } }));
    }
    corpus.push(hooks({ [AGY_DIRECTIVE_HOOK_NAME]: PRE }));
    for (const text of corpus) {
      expect(outerCopy(text, AGY_DIRECTIVE_HOOK_NAME), text).toEqual(
        agyHookOrderFindingsFromText(text, AGY_DIRECTIVE_HOOK_NAME),
      );
      expect(outerCopy(text, AGY_DIRECTIVE_HOOK_NAME, "/u/h.json", false), text).toEqual(
        agyHookOrderFindingsFromText(text, AGY_DIRECTIVE_HOOK_NAME, "/u/h.json", false),
      );
    }
  });
});
