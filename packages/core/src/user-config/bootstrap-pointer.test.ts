import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const REPO_ROOT = join(import.meta.dirname, "..", "..", "..", "..");
const agentsEntry = readFileSync(
  join(REPO_ROOT, "content", "templates", "agents-entry.md"),
  "utf8",
);
const commands = readFileSync(join(REPO_ROOT, "content", "commands.md"), "utf8");

/** Always-on bootstrap must name the Windows USER.md path (#2544). */
describe("always-on USER.md bootstrap pointer (#2544)", () => {
  it("names Windows AppData path in session routing", () => {
    expect(agentsEntry).toContain("%APPDATA%\\deft\\USER.md");
    expect(commands).toContain("%APPDATA%\\deft\\USER.md");
  });

  it("mandates session:start resolve output instead of filesystem guessing", () => {
    expect(agentsEntry).toContain("deft session:start");
    expect(agentsEntry).toContain("USER.md resolved");
    expect(commands).toContain("USER.md resolved");
  });

  it("rejects inventing ~/.config/deft on Windows", () => {
    expect(agentsEntry).toMatch(/⊗.*\.config\/deft.*Windows/i);
    expect(commands).toMatch(/⊗.*\.config\/deft.*Windows/i);
  });
});
