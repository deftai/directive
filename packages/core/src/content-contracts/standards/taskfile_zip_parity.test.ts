import { describe, expect, it } from "vitest";
import { readText } from "./_helpers.js";

describe("test_taskfile_zip_parity.py", () => {
  it("test_core_yml_exists", () => {
    expect(readText("tasks/core.yml").trim().length).toBeGreaterThan(0);
  });
  it("test_no_platform_split_tar_on_linux", () => {
    expect(readText("tasks/core.yml")).not.toContain("tar -czf dist/deft-");
  });
  it("test_no_platform_split_compress_archive_on_windows", () => {
    expect(readText("tasks/core.yml")).not.toMatch(/Compress-Archive\s+-Path/i);
  });
  it("test_build_dist_helper_dispatch_present", () => {
    expect(readText("tasks/core.yml")).toContain("scripts/build_dist.py");
  });
  it("test_build_dist_invoked_from_deft_root", () => {
    expect(readText("tasks/core.yml")).toContain("{{.DEFT_ROOT}}/scripts/build_dist.py");
  });
});
