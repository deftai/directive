import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseArgs, resolveApprovalXbriefRelPath, run } from "./scope-record-approved-scope.js";

describe("scope-record-approved-scope CLI (#3205)", () => {
  let root: string | undefined;

  afterEach(() => {
    if (root !== undefined) {
      rmSync(root, { recursive: true, force: true });
      root = undefined;
    }
  });

  it("parses required actor and path", () => {
    const a = parseArgs(["xbrief/active/s.xbrief.json", "--actor", "scott", "--kind", "human"]);
    expect(a.error).toBeUndefined();
    expect(a.actor).toBe("scott");
    expect(a.kind).toBe("human");
    expect(a.xbriefPath).toBe("xbrief/active/s.xbrief.json");
  });

  it("requires --actor", () => {
    expect(parseArgs(["xbrief/active/s.xbrief.json"]).error).toMatch(/--actor/);
  });

  it("maps pending path to active binding", () => {
    expect(resolveApprovalXbriefRelPath("xbrief/pending/story.xbrief.json", ".")).toBe(
      "xbrief/active/story.xbrief.json",
    );
  });

  it("writes human approval digest and refuses agent stamps", () => {
    root = mkdtempSync(join(tmpdir(), "scope-record-"));
    mkdirSync(join(root, "xbrief", "pending"), { recursive: true });
    const payload = {
      xBRIEFInfo: { version: "0.8" },
      plan: {
        id: "story-1",
        status: "pending",
        metadata: { swarm: { file_scope: ["src/a.ts"] } },
      },
    };
    const xb = join(root, "xbrief/pending/story.xbrief.json");
    writeFileSync(xb, `${JSON.stringify(payload, null, 2)}\n`, "utf8");

    const code = run([
      "xbrief/pending/story.xbrief.json",
      "--project-root",
      root,
      "--actor",
      "scott",
    ]);
    expect(code).toBe(0);
    const out = join(root, ".deft/approved-scope/story-1.json");
    const rec = JSON.parse(readFileSync(out, "utf8")) as {
      xbriefRelPath: string;
      humanApproval: { actor: string; kind: string };
      fileScope: string[];
    };
    expect(rec.xbriefRelPath).toBe("xbrief/active/story.xbrief.json");
    expect(rec.humanApproval.actor).toBe("scott");
    expect(rec.fileScope).toEqual(["src/a.ts"]);

    const agentCode = run([
      "xbrief/pending/story.xbrief.json",
      "--project-root",
      root,
      "--actor",
      "agent:worker",
      "--kind",
      "agent",
    ]);
    expect(agentCode).toBe(1);
  });
});
