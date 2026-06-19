import { describe, expect, it } from "vitest";
import * as packRender from "./index.js";

describe("packs index barrel", () => {
  it("re-exports namespace modules", () => {
    expect(packRender.packRender.render).toBeTypeOf("function");
    expect(packRender.packsSlice.slicePack).toBeTypeOf("function");
    expect(packRender.quarantineExt.quarantineBody).toBeTypeOf("function");
  });
});
