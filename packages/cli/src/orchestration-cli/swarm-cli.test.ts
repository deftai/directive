import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { dispatch } from "../dispatch.js";
import { silentIo } from "./helpers.js";

const temps: string[] = [];
afterEach(() => {
  for (const t of temps) {
    rmSync(t, { recursive: true, force: true });
  }
});

function emptyProject(): string {
  const root = mkdtempSync(join(tmpdir(), "deft-swarm-cli-"));
  temps.push(root);
  mkdirSync(join(root, "vbrief", "active"), { recursive: true });
  return root;
}

describe("deft-ts swarm:* dispatcher (#1838 s4)", () => {
  it("swarm-launch rejects missing stories with exit 2", async () => {
    const root = emptyProject();
    expect(await dispatch(["swarm-launch", "--project-root", root], silentIo())).toBe(2);
  });

  it("swarm-launch rejects missing active dir with exit 2", async () => {
    const root = mkdtempSync(join(tmpdir(), "deft-swarm-no-active-"));
    temps.push(root);
    expect(
      await dispatch(["swarm-launch", "--stories", "9999", "--project-root", root], silentIo()),
    ).toBe(2);
  });

  it("swarm-readiness exits 1 when active has no vBRIEF files", async () => {
    const root = emptyProject();
    expect(await dispatch(["swarm-readiness", "--project-root", root], silentIo())).toBe(1);
  });

  it("swarm-worktrees rejects missing subcommand with exit 2", async () => {
    expect(await dispatch(["swarm-worktrees"], silentIo())).toBe(2);
  });

  it("swarm-complete-cohort rejects missing cohort with exit 2", async () => {
    const root = emptyProject();
    expect(await dispatch(["swarm-complete-cohort", "--project-root", root], silentIo())).toBe(2);
  });

  it("swarm-verify-review-clean requires --pr with exit 2", async () => {
    expect(await dispatch(["swarm-verify-review-clean"], silentIo())).toBe(2);
  });
});
