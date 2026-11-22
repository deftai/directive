import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseArgs, run } from "./scope-record-intent-constraint.js";

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
  environ: { CLAUDECODE: "1" },
};

function storyBrief(root: string, extra: Record<string, unknown> = {}): string {
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
        "x-directive/intentConstraint": {
          constraints: [{ value: "1024", unit: "bytes", rejectionScope: "invocation" }],
          ...extra,
        },
      },
    }),
    "utf8",
  );
  return xbrief;
}

function readRecord(root: string): {
  humanApproval: { kind: string; actor: string; mintedVia?: string };
  constraints: unknown[];
} {
  return JSON.parse(
    readFileSync(join(root, ".deft", "intent-constraint", "story-1.json"), "utf8"),
  ) as {
    humanApproval: { kind: string; actor: string; mintedVia?: string };
    constraints: unknown[];
  };
}

describe("scope-record-intent-constraint CLI (#4541 / #7031)", () => {
  it("prints usage naming the declared record", () => {
    expect(parseArgs(["--help"]).help).toBe(true);
    let out = "";
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      out += String(chunk);
      return true;
    });
    expect(run(["--help"])).toBe(0);
    expect(out).toContain("Declared record (#7031)");
    expect(out).not.toContain("--minted-via in-harness-ask");
  });

  it("writes a declared record from an agent shell with no TTY (#7031)", () => {
    const root = mkdtempSync(join(tmpdir(), "ic-declared-"));
    temps.push(root);
    const xbrief = storyBrief(root);
    const out: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      out.push(String(chunk));
      return true;
    });
    expect(run([xbrief, "--actor", "agent:leaf", "--project-root", root], agentSeams)).toBe(0);
    // #6335: the message names the part line for the authority-record PR.
    expect(out.join("")).toContain("authority-record PR with `deft-story-part: N`");
    expect(out.join("")).toContain("not consent");
    const rec = readRecord(root);
    expect(rec.humanApproval.kind).toBe("declared");
    expect(rec.humanApproval.actor).toBe("agent:leaf");
    expect(rec.humanApproval.mintedVia).toBe("scope:record-intent-constraint");
    expect(rec.constraints).toEqual([
      { value: "1024", unit: "bytes", rejectionScope: "invocation" },
    ]);
  });

  it("defaults the declared-by name and accepts a legacy --confirm", () => {
    const root = mkdtempSync(join(tmpdir(), "ic-declared-default-"));
    temps.push(root);
    const xbrief = storyBrief(root);
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    expect(run([xbrief, "--confirm", "--project-root", root], agentSeams)).toBe(0);
    expect(readRecord(root).humanApproval.actor).toBe("unspecified");
  });

  it("refuses --kind and --minted-via (#7031)", () => {
    for (const argv of [
      ["story.xbrief.json", "--kind", "operator"],
      ["story.xbrief.json", "--kind=operator"],
      ["story.xbrief.json", "--minted-via", "in-harness-ask"],
      ["story.xbrief.json", "--minted-via=in-harness-ask"],
    ]) {
      expect(parseArgs(argv).error).toMatch(/is not accepted: this command always writes kind/);
    }
  });

  it("refuses worker-declared baselineRef", () => {
    const root = mkdtempSync(join(tmpdir(), "ic-declared-base-"));
    temps.push(root);
    const xbrief = storyBrief(root, { baselineRef: "HEAD" });
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    expect(run([xbrief, "--project-root", root], agentSeams)).toBe(2);
  });
});
