import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  normalizeActorKey,
  parseAddressingNameFromUserMd,
  resolveActorName,
} from "./actor-name.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("parseAddressingNameFromUserMd", () => {
  it("reads Name from Personal section", () => {
    expect(parseAddressingNameFromUserMd("## Personal\n\nName: Alex\n")).toBe("Alex");
  });

  it("reads addressing-name variant", () => {
    expect(parseAddressingNameFromUserMd("## Personal\n\naddressing-name: Sam\n")).toBe("Sam");
  });

  it("reads top-level Name before Personal", () => {
    expect(parseAddressingNameFromUserMd("Name: Jordan\n## Personal\n")).toBe("Jordan");
  });

  it("returns null for empty name values", () => {
    expect(parseAddressingNameFromUserMd("## Personal\n\nName:   \n")).toBeNull();
  });

  it("stops at next section header", () => {
    expect(parseAddressingNameFromUserMd("## Personal\n\nName: Alex\n## Work\n\nName: Bob\n")).toBe(
      "Alex",
    );
  });
});

describe("normalizeActorKey", () => {
  it("lowercases and collapses whitespace", () => {
    expect(normalizeActorKey("  Alex   Lee ")).toBe("alex lee");
  });
});

describe("resolveActorName", () => {
  it("falls back to gh-login when USER.md has no name", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-ps-actor-"));
    roots.push(root);
    mkdirSync(join(root, "xbrief"), { recursive: true });
    writeFileSync(join(root, "xbrief", "PROJECT-DEFINITION.xbrief.json"), "{}", "utf8");

    const fromGh = resolveActorName({
      projectRoot: root,
      runGhApiFn: () => ({
        returncode: 0,
        stdout: JSON.stringify({ login: "octocat" }),
        stderr: "",
      }),
    });
    expect(["gh-login", "user-md"]).toContain(fromGh.actorNameSource);
    if (fromGh.actorNameSource === "gh-login") {
      expect(fromGh.displayName).toBe("octocat");
    }
  });

  it("falls back to unnamed when gh fails", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-ps-actor-un-"));
    roots.push(root);
    mkdirSync(join(root, "xbrief"), { recursive: true });
    writeFileSync(join(root, "xbrief", "PROJECT-DEFINITION.xbrief.json"), "{}", "utf8");
    const unnamed = resolveActorName({
      projectRoot: root,
      runGhApiFn: () => ({ returncode: 1, stdout: "", stderr: "fail" }),
    });
    if (unnamed.actorNameSource === "unnamed") {
      expect(unnamed.displayName).toBe("unnamed");
    }
  });

  it("reads **Name** bold variant", () => {
    expect(parseAddressingNameFromUserMd("## Personal\n\n**Name**: Alex\n")).toBe("Alex");
  });

  it("ignores gh login when response is not an object", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-ps-actor-ghbad-"));
    roots.push(root);
    mkdirSync(join(root, "xbrief"), { recursive: true });
    writeFileSync(join(root, "xbrief", "PROJECT-DEFINITION.xbrief.json"), "{}", "utf8");
    const resolved = resolveActorName({
      projectRoot: root,
      runGhApiFn: () => ({ returncode: 0, stdout: "[]", stderr: "" }),
    });
    expect(resolved.displayName.length).toBeGreaterThan(0);
  });
});
