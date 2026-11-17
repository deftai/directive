import { describe, expect, it } from "vitest";
import { readText } from "./_helpers.js";

describe("merge-queue --wait docs (#6423 items 8, AC 11)", () => {
  const github = readText("content/scm/github.md");
  const section = github.slice(
    github.indexOf("### Merge queue mode (#6295)"),
    github.indexOf("## Closeout route table (#3875)"),
  );
  const swarm = readText("content/skills/deft-directive-swarm/references/core-phase-5-6.md");

  it("scm/github.md Merge queue mode states the --wait form, stop reasons and early end", () => {
    expect(section).toContain("add `--wait` (#6423) to the first call or to the resume command");
    for (const reason of ["`result`", "`cap`", "`read-unavailable`"]) {
      expect(section).toContain(reason);
    }
    expect(section).toContain("`merge_queue.wait_stop_reason`");
    expect(section).toMatch(/ends early when queue reads are unavailable/);
    expect(section).toMatch(/does not wait through a GraphQL rate limit/);
    expect(section).toMatch(/printed resume command stays the one-read form/);
  });

  it("the swarm cascade text names --wait, the stop reasons and the rate-limit limit", () => {
    expect(swarm).toContain("add `--wait` (#6423)");
    expect(swarm).toMatch(/`result`, `cap` or `read-unavailable`/);
    expect(swarm).toMatch(/does not wait through a rate limit/);
  });
});
