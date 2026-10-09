import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_BRANCHES, ENV_BYPASS } from "./classifier.js";
import { evaluatePrePush, parsePrePushStdin } from "./pre-push.js";

const ZERO = "0000000000000000000000000000000000000000";
const LIVE = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

function writePd(root: string, policy: Record<string, unknown>): void {
  mkdirSync(join(root, "xbrief"), { recursive: true });
  writeFileSync(
    join(root, "xbrief", "PROJECT-DEFINITION.xbrief.json"),
    JSON.stringify({
      xBRIEFInfo: { version: "0.8" },
      plan: { title: "t", status: "running", "x-directive/policy": policy },
    }),
    "utf8",
  );
}

function tempRoot(): string {
  return mkdtempSync(join(tmpdir(), "deft-prepush-"));
}

function createMasterLine(remote = "master"): string {
  return `refs/heads/${remote} ${LIVE} refs/heads/${remote} ${ZERO}`;
}

describe("parsePrePushStdin", () => {
  it("parses four-field ref lines and skips junk", () => {
    const refs = parsePrePushStdin(`${createMasterLine()}\nnot-a-ref\n`);
    expect(refs).toHaveLength(1);
    expect(refs[0]?.remoteRef).toBe("refs/heads/master");
    expect(refs[0]?.remoteOid).toBe(ZERO);
  });

  it("treats empty stdin as no refs", () => {
    expect(parsePrePushStdin("")).toEqual([]);
  });
});

describe("evaluatePrePush stdin policy fixtures", () => {
  it("allows empty stdin", () => {
    const [code, msg] = evaluatePrePush([]);
    expect(code).toBe(0);
    expect(msg).toContain("no refs");
  });

  it("refuses create of master and names the policy verb", () => {
    const refs = parsePrePushStdin(createMasterLine("master"));
    const [code, msg] = evaluatePrePush(refs);
    expect(code).toBe(1);
    expect(msg).toContain("create master");
    expect(msg).toContain("deft policy:allow-destructive-gh-verbs -- --confirm");
    expect(msg).toContain(`${ENV_BYPASS}=1`);
  });

  it("refuses create of main", () => {
    const refs = parsePrePushStdin(createMasterLine("main"));
    const [code, msg] = evaluatePrePush(refs);
    expect(code).toBe(1);
    expect(msg).toContain("create main");
  });

  it("does not treat zero-OID create of master as empty-remote relief", () => {
    const r = tempRoot();
    writePd(r, {});
    const refs = parsePrePushStdin(createMasterLine("master"));
    const [code] = evaluatePrePush(refs, { projectRoot: r });
    expect(code).toBe(1);
  });

  it("refuses update and delete of default branches", () => {
    const update = parsePrePushStdin(`refs/heads/master ${LIVE} refs/heads/master ${LIVE}`);
    const del = parsePrePushStdin(`refs/heads/master ${ZERO} refs/heads/master ${LIVE}`);
    expect(evaluatePrePush(update)[0]).toBe(1);
    expect(evaluatePrePush(update)[1]).toContain("update master");
    expect(evaluatePrePush(del)[0]).toBe(1);
    expect(evaluatePrePush(del)[1]).toContain("delete master");
  });

  it("allows create of a feature branch", () => {
    const refs = parsePrePushStdin(
      `refs/heads/feat/core-engine ${LIVE} refs/heads/feat/core-engine ${ZERO}`,
    );
    const [code] = evaluatePrePush(refs);
    expect(code).toBe(0);
  });

  it("consults allowDestructiveGhVerbs through projectRoot", () => {
    const r = tempRoot();
    writePd(r, { allowDestructiveGhVerbs: true });
    const refs = parsePrePushStdin(createMasterLine("master"));
    const [code, msg] = evaluatePrePush(refs, { projectRoot: r });
    expect(code).toBe(0);
    expect(msg).toContain("allowDestructiveGhVerbs=true");
  });

  it("still refuses when projectRoot policy is false", () => {
    const r = tempRoot();
    writePd(r, { allowDestructiveGhVerbs: false });
    const refs = parsePrePushStdin(createMasterLine("master"));
    expect(evaluatePrePush(refs, { projectRoot: r })[0]).toBe(1);
  });

  it("env-var override allows create without the typed flag", () => {
    const refs = parsePrePushStdin(createMasterLine("master"));
    const [code, msg] = evaluatePrePush(refs, { env: { [ENV_BYPASS]: "1" } });
    expect(code).toBe(0);
    expect(msg).toContain("policy bypassed for this invocation");
  });

  it("fail-closes a missing PROJECT-DEFINITION with exit 2", () => {
    const r = tempRoot();
    const refs = parsePrePushStdin(createMasterLine("master"));
    const [code, msg] = evaluatePrePush(refs, { projectRoot: r });
    expect(code).toBe(2);
    expect(msg).toContain("cannot be resolved");
    expect(msg).toContain("not found");
  });

  it("fail-closes a non-object plan with exit 2", () => {
    const r = tempRoot();
    mkdirSync(join(r, "xbrief"), { recursive: true });
    writeFileSync(
      join(r, "xbrief", "PROJECT-DEFINITION.xbrief.json"),
      JSON.stringify({ xBRIEFInfo: { version: "0.8" }, plan: [] }),
      "utf8",
    );
    const refs = parsePrePushStdin(createMasterLine("master"));
    const [code, msg] = evaluatePrePush(refs, { projectRoot: r });
    expect(code).toBe(2);
    expect(msg).toContain("'plan' is not an object");
  });

  it("fail-closes malformed typed policy with exit 2", () => {
    const r = tempRoot();
    writePd(r, { allowDestructiveGhVerbs: "yes" });
    const refs = parsePrePushStdin(createMasterLine("master"));
    const [code, msg] = evaluatePrePush(refs, { projectRoot: r });
    expect(code).toBe(2);
    expect(msg).toContain("must be a boolean");
  });

  it("mixed default-branch refs stay refused", () => {
    const text = [
      createMasterLine("master"),
      `refs/heads/main ${LIVE} refs/heads/main ${LIVE}`,
    ].join("\n");
    const [code, msg] = evaluatePrePush(parsePrePushStdin(text));
    expect(code).toBe(1);
    expect(msg).toContain("create master");
    expect(msg).toContain("update main");
  });

  it("refuses stdin push to develop when typed deliveryBranch=develop (#5520)", () => {
    const r = tempRoot();
    writePd(r, { deliveryBranch: "develop", allowDestructiveGhVerbs: false });
    const refs = parsePrePushStdin(`refs/heads/feat/x ${LIVE} refs/heads/develop ${LIVE}`);
    const [code, msg] = evaluatePrePush(refs, {
      projectRoot: r,
      branches: new Set(DEFAULT_BRANCHES),
    });
    expect(code).toBe(1);
    expect(msg).toContain("update develop");
  });

  it("allows develop push when policy omits deliveryBranch (#5520)", () => {
    const r = tempRoot();
    writePd(r, { allowDestructiveGhVerbs: false });
    const refs = parsePrePushStdin(`refs/heads/feat/x ${LIVE} refs/heads/develop ${LIVE}`);
    expect(evaluatePrePush(refs, { projectRoot: r })[0]).toBe(0);
  });

  it("skips hostile typed deliveryBranch for pre-push (#5520)", () => {
    const r = tempRoot();
    writePd(r, { deliveryBranch: "--upload-pack=evil", allowDestructiveGhVerbs: false });
    const refs = parsePrePushStdin(
      `refs/heads/feat/x ${LIVE} refs/heads/--upload-pack=evil ${LIVE}`,
    );
    expect(evaluatePrePush(refs, { projectRoot: r })[0]).toBe(0);
  });

  it("preserves --default-branch additions with typed delivery (#5520)", () => {
    const r = tempRoot();
    writePd(r, { deliveryBranch: "develop", allowDestructiveGhVerbs: false });
    const trunk = parsePrePushStdin(`refs/heads/feat/x ${LIVE} refs/heads/trunk ${LIVE}`);
    expect(
      evaluatePrePush(trunk, {
        projectRoot: r,
        branches: new Set([...DEFAULT_BRANCHES, "trunk"]),
      })[0],
    ).toBe(1);
  });
});
