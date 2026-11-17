import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_OPERATOR_NOTIFY_CHANNEL,
  isUrlShapedChannelValue,
  parseOperatorNotifyFromUserMd,
  resolveOperatorNotifyChannel,
  validateOperatorNotifyChannel,
} from "./operator-notify.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function projectWithPolicy(policy: Record<string, unknown> | null): string {
  const root = mkdtempSync(join(tmpdir(), "opnotify-policy-"));
  roots.push(root);
  mkdirSync(join(root, "xbrief"), { recursive: true });
  const plan: Record<string, unknown> = { title: "t", status: "running", items: [] };
  if (policy !== null) plan.policy = policy;
  writeFileSync(
    join(root, "xbrief", "PROJECT-DEFINITION.xbrief.json"),
    `${JSON.stringify({ xBRIEFInfo: { version: "0.8" }, plan }, null, 2)}\n`,
  );
  return root;
}

describe("plan.policy.operatorNotify (#6275)", () => {
  it("defaults to off with no USER.md and no project policy", () => {
    const root = projectWithPolicy(null);
    expect(resolveOperatorNotifyChannel({ projectRoot: root, userMdText: null })).toEqual({
      channel: "off",
      source: "default",
      error: null,
    });
    expect(DEFAULT_OPERATOR_NOTIFY_CHANNEL).toBe("off");
  });

  it("reads plan.policy.operatorNotify", () => {
    const root = projectWithPolicy({ operatorNotify: "os" });
    expect(resolveOperatorNotifyChannel({ projectRoot: root, userMdText: null })).toEqual({
      channel: "os",
      source: "typed",
      error: null,
    });
  });

  it("USER.md Personal wins over plan.policy", () => {
    const root = projectWithPolicy({ operatorNotify: "os" });
    const userMd = "# USER\n\n## Personal (always wins)\n\n- **operatorNotify**: off\n\n## Other\n";
    expect(resolveOperatorNotifyChannel({ projectRoot: root, userMdText: userMd })).toEqual({
      channel: "off",
      source: "user-md",
      error: null,
    });
    const labeled = "## Personal\nOperator notify: OS\n";
    expect(
      resolveOperatorNotifyChannel({ projectRoot: projectWithPolicy(null), userMdText: labeled })
        .channel,
    ).toBe("os");
  });

  it("ignores operatorNotify outside the Personal section", () => {
    expect(parseOperatorNotifyFromUserMd("## Team\noperatorNotify: os\n")).toBeNull();
    expect(
      parseOperatorNotifyFromUserMd("## Personal\nname: x\n## Team\noperatorNotify: os\n"),
    ).toBeNull();
  });

  it("refuses a URL-shaped value in plan.policy and stays off", () => {
    const root = projectWithPolicy({ operatorNotify: "https://hooks.slack.com/services/T/B/X" });
    const resolved = resolveOperatorNotifyChannel({ projectRoot: root, userMdText: null });
    expect(resolved.channel).toBe("off");
    expect(resolved.source).toBe("default-on-error");
    expect(resolved.error).toMatch(/never a URL/);
  });

  it("refuses a URL-shaped value in USER.md Personal and stays off", () => {
    const root = projectWithPolicy({ operatorNotify: "os" });
    const resolved = resolveOperatorNotifyChannel({
      projectRoot: root,
      userMdText: "## Personal\noperatorNotify: hooks.slack.com/services/abc\n",
    });
    expect(resolved).toMatchObject({ channel: "off", source: "default-on-error" });
    expect(resolved.error).toMatch(/never a URL/);
  });

  it("refuses unknown names and non-strings", () => {
    expect(validateOperatorNotifyChannel("webhook")).toMatch(/must be one of off\|os/);
    expect(validateOperatorNotifyChannel(1)).toMatch(/got number/);
    expect(validateOperatorNotifyChannel(" OS ")).toBeNull();
    const root = projectWithPolicy({ operatorNotify: 3 });
    expect(resolveOperatorNotifyChannel({ projectRoot: root, userMdText: null })).toMatchObject({
      channel: "off",
      source: "default-on-error",
    });
  });

  it("treats a null policy value as absent", () => {
    const root = projectWithPolicy({ operatorNotify: null });
    expect(resolveOperatorNotifyChannel({ projectRoot: root, userMdText: null }).source).toBe(
      "default",
    );
  });

  it("with no project root, reads USER.md from the env path and skips project policy", () => {
    const home = mkdtempSync(join(tmpdir(), "opnotify-noroot-"));
    roots.push(home);
    const userMd = join(home, "USER.md");
    writeFileSync(userMd, "## Personal\noperatorNotify: os\n");
    expect(
      resolveOperatorNotifyChannel({ env: { DEFT_USER_PATH: userMd, APPDATA: home, HOME: home } }),
    ).toEqual({ channel: "os", source: "user-md", error: null });
    expect(resolveOperatorNotifyChannel({ projectRoot: "", userMdText: null })).toEqual({
      channel: "off",
      source: "default",
      error: null,
    });
  });

  it("detects URL-shaped values", () => {
    expect(isUrlShapedChannelValue("http://x")).toBe(true);
    expect(isUrlShapedChannelValue("www.example.com")).toBe(true);
    expect(isUrlShapedChannelValue("example.com/hook")).toBe(true);
    expect(isUrlShapedChannelValue("os")).toBe(false);
    expect(isUrlShapedChannelValue("off")).toBe(false);
  });

  it("reads USER.md from the resolved path when no text seam is given", () => {
    const root = projectWithPolicy({ operatorNotify: "os" });
    const home = mkdtempSync(join(tmpdir(), "opnotify-home-"));
    roots.push(home);
    const userMd = join(home, "USER.md");
    writeFileSync(userMd, "## Personal\noperatorNotify: off\n");
    expect(
      resolveOperatorNotifyChannel({
        projectRoot: root,
        env: { DEFT_USER_PATH: userMd, APPDATA: home, HOME: home },
      }),
    ).toEqual({ channel: "off", source: "user-md", error: null });
    expect(
      resolveOperatorNotifyChannel({
        projectRoot: root,
        env: { DEFT_USER_PATH: join(home, "missing-USER.md"), APPDATA: home, HOME: home },
      }),
    ).toEqual({ channel: "os", source: "typed", error: null });
  });
});
