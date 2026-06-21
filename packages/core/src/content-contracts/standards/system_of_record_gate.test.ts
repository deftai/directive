import { describe, expect, it } from "vitest";
import { readText } from "./_helpers.js";

describe("test_system_of_record_gate.py", () => {
  it("test_system_of_record_docs_define_classifications", () => {
    const text = readText("docs/system-of-record-gate.md");
    // for token in ...
    expect(text).toContain("durable_product_state");
    // for token in ...
    expect(text).toContain("auth_session_state");
    // for token in ...
    expect(text).toContain("authorization_state");
    // for token in ...
    expect(text).toContain("audit_event_state");
    // for token in ...
    expect(text).toContain("external_integration_state");
    // for token in ...
    expect(text).toContain("canonical_artifact");
    // for token in ...
    expect(text).toContain("cache");
    // for token in ...
    expect(text).toContain("projection");
    // for token in ...
    expect(text).toContain("import_export_artifact");
    // for token in ...
    expect(text).toContain("dev_only_fixture");
    // for token in ...
    expect(text).toContain("ephemeral_ui_state");
    expect(text).toContain("task architecture:sor-preflight");
    expect(text).toContain("task verify:architecture-sor");
  });
  it("test_taskfile_surfaces_system_of_record_gate", () => {
    const taskfile = readText("Taskfile.yml");
    const architecture_tasks = readText("tasks/architecture.yml");
    const verify_tasks = readText("tasks/verify.yml");
    expect(taskfile).toContain("tasks/architecture.yml");
    expect(architecture_tasks).toContain("sor-preflight");
    // architecture.yml flipped to TS dispatcher (Wave 8.6 s4 / #1854)
    expect(architecture_tasks).toContain("architecture-preflight-sor");
    expect(verify_tasks).toContain("architecture-sor");
    // verify.yml's architecture-sor gate also flipped to TS (Wave 8.6 s5 / #1854)
    expect(verify_tasks).toContain("architecture-preflight-sor");
  });
});
