import { describe, expect, it } from "vitest";
import * as userConfig from "./index.js";

describe("user-config barrel exports", () => {
  it("re-exports the public resolver API", () => {
    expect(typeof userConfig.resolveUserMdPath).toBe("function");
    expect(typeof userConfig.platformUserConfigDir).toBe("function");
  });

  it("re-exports the resolver constants", () => {
    expect(userConfig.NO_USER_MD_DIAGNOSTIC).toBe("no USER.md found; using defaults");
    expect(userConfig.USER_MD_FILENAME).toBe("USER.md");
    expect(userConfig.WORKSPACE_LOCAL_CONFIG_DIR).toBe(".deft");
  });
});
