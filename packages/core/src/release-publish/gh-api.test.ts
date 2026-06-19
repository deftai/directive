import { describe, expect, it } from "vitest";
import {
  editReleasePublish,
  ghApiFindReleaseByTag,
  normaliseReleasePayload,
  viewRelease,
} from "./gh-api.js";
import type { ReleasePublishSeams } from "./types.js";

const REST_DRAFT = {
  id: 1234567,
  draft: true,
  name: "v0.21.0",
  tag_name: "v0.21.0",
  html_url: "https://github.com/deftai/directive/releases/tag/v0.21.0",
};

const REST_PUBLISHED = { ...REST_DRAFT, draft: false };

function makeRestRelease(
  tag = "v0.21.0",
  draft = true,
  releaseId = 1234567,
): Record<string, unknown> {
  return {
    id: releaseId,
    draft,
    name: tag,
    tag_name: tag,
    html_url: `https://github.com/deftai/directive/releases/tag/${tag}`,
  };
}

function seamsWithGh(
  handler: (args: readonly string[]) => { status: number; stdout: string; stderr: string },
): ReleasePublishSeams {
  return {
    whichGh: () => "/usr/bin/gh",
    spawnText: (_cmd, args) => handler(args),
  };
}

describe("normaliseReleasePayload", () => {
  it("maps REST keys to legacy shape", () => {
    const payload = normaliseReleasePayload(REST_DRAFT);
    expect(payload.isDraft).toBe(true);
    expect(payload.tagName).toBe("v0.21.0");
    expect(payload.url).toMatch(/^https:\/\/github.com\//);
    expect(payload.id).toBe(1234567);
  });
});

describe("ghApiFindReleaseByTag", () => {
  it("returns draft state", () => {
    const seams = seamsWithGh(() => ({
      status: 0,
      stdout: JSON.stringify([REST_DRAFT]),
      stderr: "",
    }));
    const [state, body, reason] = ghApiFindReleaseByTag(
      "/usr/bin/gh",
      "deftai/directive",
      "v0.21.0",
      seams,
    );
    expect(state).toBe("draft");
    expect(body?.isDraft).toBe(true);
    expect(reason).toBe("");
  });

  it("returns published state", () => {
    const seams = seamsWithGh(() => ({
      status: 0,
      stdout: JSON.stringify([REST_PUBLISHED]),
      stderr: "",
    }));
    const [state, body] = ghApiFindReleaseByTag(
      "/usr/bin/gh",
      "deftai/directive",
      "v0.21.0",
      seams,
    );
    expect(state).toBe("published");
    expect(body?.isDraft).toBe(false);
  });

  it("returns not-found when tag absent", () => {
    const seams = seamsWithGh(() => ({
      status: 0,
      stdout: JSON.stringify([makeRestRelease("v0.20.0", false, 1)]),
      stderr: "",
    }));
    const [state, body, reason] = ghApiFindReleaseByTag(
      "/usr/bin/gh",
      "deftai/directive",
      "v9.9.9",
      seams,
    );
    expect(state).toBe("not-found");
    expect(body).toBeNull();
    expect(reason).toContain("v9.9.9");
  });

  it("returns gh-error on non-zero exit", () => {
    const seams = seamsWithGh(() => ({ status: 4, stdout: "", stderr: "auth required" }));
    const [state, , reason] = ghApiFindReleaseByTag(
      "/usr/bin/gh",
      "deftai/directive",
      "v0.21.0",
      seams,
    );
    expect(state).toBe("gh-error");
    expect(reason).toContain("auth required");
  });

  it("returns gh-error on non-json", () => {
    const seams = seamsWithGh(() => ({ status: 0, stdout: "not json", stderr: "" }));
    const [state, , reason] = ghApiFindReleaseByTag(
      "/usr/bin/gh",
      "deftai/directive",
      "v0.21.0",
      seams,
    );
    expect(state).toBe("gh-error");
    expect(reason).toContain("non-JSON");
  });

  it("returns gh-error on non-list payload", () => {
    const seams = seamsWithGh(() => ({
      status: 0,
      stdout: JSON.stringify({ message: "Internal Server Error" }),
      stderr: "",
    }));
    const [state, , reason] = ghApiFindReleaseByTag(
      "/usr/bin/gh",
      "deftai/directive",
      "v0.21.0",
      seams,
    );
    expect(state).toBe("gh-error");
    expect(reason).toContain("non-list");
  });

  it("uses paginate flag not graphql", () => {
    let captured: readonly string[] = [];
    const seams = seamsWithGh((args) => {
      captured = args;
      return { status: 0, stdout: JSON.stringify([REST_DRAFT]), stderr: "" };
    });
    ghApiFindReleaseByTag("/usr/bin/gh", "deftai/directive", "v0.21.0", seams);
    expect(captured).toContain("--paginate");
    expect(captured).toContain("repos/deftai/directive/releases?per_page=100");
    expect(captured).not.toContain("--json");
    expect(captured.some((a) => a.includes("/releases/tags/"))).toBe(false);
  });

  it("finds draft deep in concatenated list", () => {
    const pageOne = Array.from({ length: 100 }, (_, i) =>
      makeRestRelease(`v2.${i}.0`, false, 10000 + i),
    );
    const pageTwo = Array.from({ length: 49 }, (_, i) =>
      makeRestRelease(`v3.${i}.0`, false, 20000 + i),
    );
    const target = makeRestRelease("v0.21.0", true, 999999);
    const seams = seamsWithGh(() => ({
      status: 0,
      stdout: JSON.stringify([...pageOne, ...pageTwo, target]),
      stderr: "",
    }));
    const [state, body] = ghApiFindReleaseByTag(
      "/usr/bin/gh",
      "deftai/directive",
      "v0.21.0",
      seams,
    );
    expect(state).toBe("draft");
    expect(body?.id).toBe(999999);
  });

  it("skips non-object entries", () => {
    const seams = seamsWithGh(() => ({
      status: 0,
      stdout: JSON.stringify(["bad", null, REST_DRAFT]),
      stderr: "",
    }));
    const [state] = ghApiFindReleaseByTag("/usr/bin/gh", "deftai/directive", "v0.21.0", seams);
    expect(state).toBe("draft");
  });
});

describe("viewRelease", () => {
  it("returns gh-error when gh missing", () => {
    const [state, , reason] = viewRelease("0.21.0", "deftai/directive", {
      whichGh: () => null,
    });
    expect(state).toBe("gh-error");
    expect(reason).toContain("gh CLI not found");
  });
});

describe("editReleasePublish", () => {
  it("happy path issues list then patch", () => {
    const cmds: string[][] = [];
    const seams = seamsWithGh((args) => {
      cmds.push([...args]);
      if (args.includes("--paginate")) {
        return { status: 0, stdout: JSON.stringify([REST_DRAFT]), stderr: "" };
      }
      return { status: 0, stdout: "{}", stderr: "" };
    });
    const [ok, reason] = editReleasePublish("0.21.0", "deftai/directive", undefined, seams);
    expect(ok).toBe(true);
    expect(reason).toContain("flipped v0.21.0");
    expect(cmds.length).toBe(2);
    const patch = cmds[1] ?? [];
    expect(patch).toContain("--method");
    expect(patch).toContain("PATCH");
    expect(patch).toContain("draft=false");
    expect(patch.some((a) => a === "repos/deftai/directive/releases/1234567")).toBe(true);
  });

  it("release_id provided skips get", () => {
    const cmds: string[][] = [];
    const seams = seamsWithGh((args) => {
      cmds.push([...args]);
      return { status: 0, stdout: "{}", stderr: "" };
    });
    const [ok] = editReleasePublish("0.21.0", "deftai/directive", 1234567, seams);
    expect(ok).toBe(true);
    expect(cmds.length).toBe(1);
    expect(cmds[0]?.includes("--paginate")).toBe(false);
  });

  it("fails when list lookup fails", () => {
    const seams = seamsWithGh(() => ({ status: 1, stdout: "", stderr: "server error" }));
    const [ok, reason] = editReleasePublish("0.21.0", "deftai/directive", undefined, seams);
    expect(ok).toBe(false);
    expect(reason).toContain("could not resolve release id");
  });

  it("fails when release not found", () => {
    const seams = seamsWithGh(() => ({ status: 0, stdout: "[]", stderr: "" }));
    const [ok, reason] = editReleasePublish("0.21.0", "deftai/directive", undefined, seams);
    expect(ok).toBe(false);
    expect(reason).toContain("not found");
  });

  it("fails when payload missing id", () => {
    const bad = { ...REST_DRAFT, id: undefined };
    delete (bad as { id?: number }).id;
    const seams = seamsWithGh(() => ({
      status: 0,
      stdout: JSON.stringify([bad]),
      stderr: "",
    }));
    const [ok, reason] = editReleasePublish("0.21.0", "deftai/directive", undefined, seams);
    expect(ok).toBe(false);
    expect(reason).toContain("missing 'id'");
  });

  it("fails on patch error", () => {
    let n = 0;
    const seams = seamsWithGh(() => {
      n += 1;
      if (n === 1) {
        return { status: 0, stdout: JSON.stringify([REST_DRAFT]), stderr: "" };
      }
      return { status: 1, stdout: "", stderr: "permission denied" };
    });
    const [ok, reason] = editReleasePublish("0.21.0", "deftai/directive", undefined, seams);
    expect(ok).toBe(false);
    expect(reason).toContain("permission denied");
    expect(reason).toContain("PATCH");
  });

  it("returns false when gh missing", () => {
    const [ok, reason] = editReleasePublish("0.21.0", "deftai/directive", 1, {
      whichGh: () => null,
    });
    expect(ok).toBe(false);
    expect(reason).toContain("gh CLI not found");
  });
});
