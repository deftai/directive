import { describe, expect, it } from "vitest";
import {
  buildScopeVbriefFromReconciled,
  defaultStatusForFolder,
  folderForStatus,
  planStatusMatchesFolder,
} from "./routing.js";

describe("routing map", () => {
  it("maps running to active", () => {
    expect(folderForStatus("running")).toBe("active");
    expect(defaultStatusForFolder("active")).toBe("running");
    expect(planStatusMatchesFolder("running", "active")).toBe(true);
  });

  it("rejects unknown status and folder", () => {
    expect(() => folderForStatus("in_progress")).toThrow(/No lifecycle folder/);
    expect(() => defaultStatusForFolder("archive")).toThrow(/Unknown lifecycle folder/);
  });

  it("coerces numeric narrative metadata and dedupes extra refs", () => {
    const ref = { uri: "https://github.com/a/b/issues/1", type: "x-vbrief/github-issue" };
    const scope = buildScopeVbriefFromReconciled(
      {
        title: "T",
        folder: "pending",
        description: 42,
        references: [ref, ref],
      },
      "https://github.com/a/b",
    );
    expect((scope.plan as Record<string, unknown>).references).toHaveLength(1);
  });

  it("preserves existing updated stamp on completed items", () => {
    const scope = buildScopeVbriefFromReconciled(
      { title: "Done", status: "completed", folder: "completed" },
      "",
      "2026-04-23T00:00:00Z",
    );
    expect((scope.vBRIEFInfo as Record<string, unknown>).updated).toBe("2026-04-23T00:00:00Z");
    const preset = buildScopeVbriefFromReconciled(
      {
        title: "Done",
        status: "completed",
        folder: "completed",
        vBRIEFInfo: { updated: "2026-01-01T00:00:00Z" },
      },
      "",
      "2026-04-23T00:00:00Z",
    );
    expect((preset.vBRIEFInfo as Record<string, unknown>).updated).toBe("2026-04-23T00:00:00Z");
  });
});

describe("buildScopeVbriefFromReconciled", () => {
  it("places SourceSection in narratives and stamps completed updated", () => {
    const scope = buildScopeVbriefFromReconciled(
      {
        number: "99",
        title: "Widget feature",
        description: "Add a widget.",
        description_source: "SPECIFICATION.md",
        status: "completed",
        folder: "completed",
        phase: "Phase 1",
        source_section: "ROADMAP Completed section",
      },
      "https://github.com/acme/widget",
      "2026-04-23T00:00:00Z",
    );
    expect((scope.plan as Record<string, unknown>).narratives).toEqual({
      SourceSection: "ROADMAP Completed section",
    });
    expect((scope.vBRIEFInfo as Record<string, unknown>).updated).toBe("2026-04-23T00:00:00Z");
  });

  it("defaults missing folder and seed fields", () => {
    const scope = buildScopeVbriefFromReconciled({});
    expect((scope.plan as Record<string, unknown>).title).toBe("Untitled");
  });
});
