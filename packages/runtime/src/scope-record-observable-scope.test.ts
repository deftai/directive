import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseArgs, run } from "./scope-record-observable-scope.js";

const temps: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** An agent shell with no TTY: the declared writer needs neither (#7031). */
const agentSeams = {
  isTty: () => false,
  hasControllingTerminal: () => false,
  readInteractiveConfirm: () => null,
  environ: { CURSOR_AGENT: "1" },
};

function storyBrief(root: string, contract: Record<string, unknown>): string {
  mkdirSync(join(root, "xbrief", "pending"), { recursive: true });
  const xbrief = join(root, "xbrief", "pending", "story.xbrief.json");
  writeFileSync(
    xbrief,
    JSON.stringify({
      xBRIEFInfo: { version: "0.8" },
      plan: {
        id: "story-1",
        title: "T",
        status: "pending",
        items: [],
        "x-directive/observableChange": contract,
      },
    }),
    "utf8",
  );
  return xbrief;
}

describe("scope-record-observable-scope CLI (#4495 / #7031)", () => {
  it("prints usage", () => {
    expect(parseArgs(["--help"]).help).toBe(true);
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    expect(run(["--help"])).toBe(0);
  });

  it("writes a declared record from an agent shell with no TTY (#7031)", () => {
    const root = mkdtempSync(join(tmpdir(), "obs-declared-"));
    temps.push(root);
    const xbrief = storyBrief(root, {
      changeKind: "fields-only",
      allowedChanges: [{ kind: "control", op: "add", name: "email" }],
    });
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    expect(run([xbrief, "--actor", "david", "--project-root", root], agentSeams)).toBe(0);
    const rec = JSON.parse(
      readFileSync(join(root, ".deft", "observable-scope", "story-1.json"), "utf8"),
    ) as {
      humanApproval: { kind: string; actor: string; mintedVia?: string };
      allowedChanges: unknown[];
      xbriefRelPath: string;
    };
    expect(rec.humanApproval).toMatchObject({
      kind: "declared",
      actor: "david",
      mintedVia: "scope:record-observable-scope",
    });
    expect(rec.allowedChanges).toEqual([{ kind: "control", op: "add", name: "email" }]);
    expect(rec.xbriefRelPath).toBe("xbrief/active/story.xbrief.json");
  });

  it("refuses --kind and --minted-via (#7031)", () => {
    expect(parseArgs(["story.xbrief.json", "--kind", "operator"]).error).toMatch(/--kind is not/);
    expect(parseArgs(["story.xbrief.json", "--minted-via=in-harness-ask"]).error).toMatch(
      /--minted-via is not/,
    );
  });

  it("refuses worker-declared baselineRef", () => {
    const root = mkdtempSync(join(tmpdir(), "obs-declared-base-"));
    temps.push(root);
    const xbrief = storyBrief(root, {
      baselineRef: "HEAD",
      allowedChanges: [{ kind: "control", op: "add", name: "email" }],
    });
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    expect(run([xbrief, "--project-root", root], agentSeams)).toBe(2);
  });
});
