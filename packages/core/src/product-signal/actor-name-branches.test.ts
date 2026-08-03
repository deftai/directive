import { describe, expect, it } from "vitest";
import {
  normalizeActorKey,
  parseAddressingNameFromUserMd,
  resolveActorName,
} from "./actor-name.js";

describe("actor-name branch edges", () => {
  it("normalizes multi-space keys", () => {
    expect(normalizeActorKey("  Ada   Lovelace  ")).toBe("ada lovelace");
  });

  it("parses addressing-name and skips empty Name values", () => {
    const text = [
      "## Personal",
      "- Name: ",
      "- addressing-name: Agent Zero",
      "## Defaults",
      "- Name: ignored",
    ].join("\n");
    expect(parseAddressingNameFromUserMd(text)).toBe("Agent Zero");
  });

  it("parses top-level Name when no Personal section", () => {
    expect(parseAddressingNameFromUserMd("**Name**: Top Level\n")).toBe("Top Level");
  });

  it("returns null when Personal Name is empty and no other match", () => {
    const text = ["## Personal", "- Name:   ", "## Defaults", "- other: x"].join("\n");
    expect(parseAddressingNameFromUserMd(text)).toBeNull();
  });

  it("falls back to gh-login when USER.md missing", () => {
    const previous = process.env.DEFT_USER_PATH;
    process.env.DEFT_USER_PATH = "C:\\nonexistent-deft-user-md-xyz\\USER.md";
    try {
      const resolved = resolveActorName({
        projectRoot: "C:\\nonexistent-actor-name-root-xyz",
        runGhApiFn: () => ({ returncode: 0, stdout: '{"login":"gh-user"}\n', stderr: "" }),
      });
      expect(resolved).toEqual({
        actorName: "gh-user",
        actorNameSource: "gh-login",
        displayName: "gh-user",
      });
    } finally {
      if (previous === undefined) delete process.env.DEFT_USER_PATH;
      else process.env.DEFT_USER_PATH = previous;
    }
  });

  it("falls back to unnamed when gh-login fails", () => {
    const previous = process.env.DEFT_USER_PATH;
    process.env.DEFT_USER_PATH = "C:\\nonexistent-deft-user-md-xyz\\USER.md";
    try {
      const resolved = resolveActorName({
        projectRoot: "C:\\nonexistent-actor-name-root-xyz",
        runGhApiFn: () => ({ returncode: 1, stdout: "", stderr: "nope" }),
      });
      expect(resolved.actorNameSource).toBe("unnamed");
    } finally {
      if (previous === undefined) delete process.env.DEFT_USER_PATH;
      else process.env.DEFT_USER_PATH = previous;
    }
  });

  it("ignores non-object gh payloads and empty login", () => {
    const previous = process.env.DEFT_USER_PATH;
    process.env.DEFT_USER_PATH = "C:\\nonexistent-deft-user-md-xyz\\USER.md";
    try {
      const a = resolveActorName({
        projectRoot: "C:\\nonexistent-actor-name-root-xyz",
        runGhApiFn: () => ({ returncode: 0, stdout: "[]", stderr: "" }),
      });
      expect(a.actorNameSource).toBe("unnamed");
      const b = resolveActorName({
        projectRoot: "C:\\nonexistent-actor-name-root-xyz",
        runGhApiFn: () => ({ returncode: 0, stdout: '{"login":"  "}', stderr: "" }),
      });
      expect(b.actorNameSource).toBe("unnamed");
    } finally {
      if (previous === undefined) delete process.env.DEFT_USER_PATH;
      else process.env.DEFT_USER_PATH = previous;
    }
  });

  it("ignores invalid JSON from gh", () => {
    const previous = process.env.DEFT_USER_PATH;
    process.env.DEFT_USER_PATH = "C:\\nonexistent-deft-user-md-xyz\\USER.md";
    try {
      const resolved = resolveActorName({
        projectRoot: "C:\\nonexistent-actor-name-root-xyz",
        runGhApiFn: () => ({ returncode: 0, stdout: "not-json", stderr: "" }),
      });
      expect(resolved.actorNameSource).toBe("unnamed");
    } finally {
      if (previous === undefined) delete process.env.DEFT_USER_PATH;
      else process.env.DEFT_USER_PATH = previous;
    }
  });
});
