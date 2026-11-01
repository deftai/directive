import { describe, expect, it } from "vitest";
import { plainGhEnv } from "./plain-gh-env.js";

describe("plainGhEnv (#6023)", () => {
  it("drops color-forcing keys and sets NO_COLOR=1", () => {
    const env = plainGhEnv({
      PATH: "/usr/bin",
      CLICOLOR_FORCE: "1",
      FORCE_COLOR: "3",
      NO_COLOR: "",
      GH_HOST: "github.com",
    });
    expect(env).toEqual({ PATH: "/usr/bin", GH_HOST: "github.com", NO_COLOR: "1" });
  });

  it("matches keys case-insensitively (Windows env names)", () => {
    const env = plainGhEnv({ clicolor_force: "1", Force_Color: "1", no_color: "0", Path: "C:\\x" });
    expect(Object.keys(env).sort()).toEqual(["NO_COLOR", "Path"]);
    expect(env.NO_COLOR).toBe("1");
  });

  it("never mutates the base env", () => {
    const base: NodeJS.ProcessEnv = { CLICOLOR_FORCE: "1", PATH: "/bin" };
    const env = plainGhEnv(base);
    expect(base).toEqual({ CLICOLOR_FORCE: "1", PATH: "/bin" });
    expect(env).not.toBe(base);
  });

  it("defaults to process.env without mutating it", () => {
    const before = process.env.CLICOLOR_FORCE;
    const env = plainGhEnv();
    expect(env.CLICOLOR_FORCE).toBeUndefined();
    expect(env.FORCE_COLOR).toBeUndefined();
    expect(env.NO_COLOR).toBe("1");
    expect(process.env.CLICOLOR_FORCE).toBe(before);
  });
});
