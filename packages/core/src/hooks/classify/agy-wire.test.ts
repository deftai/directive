import { describe, expect, it } from "vitest";
import { AGY_TOOL_DISPOSITIONS, agyWriteIntent, normalizeAgyHookPayload } from "./agy-wire.js";

describe("normalizeAgyHookPayload structured args (#7442)", () => {
  const questions = [
    { question: "Pick?", options: ["A", "Discuss", "Back"], is_multi_select: false },
  ];

  it("forwards structured toolCall.args keys onto tool_input", () => {
    const out = normalizeAgyHookPayload({
      toolCall: { name: "ask_question", args: { questions } },
    });
    expect(out).toMatchObject({ tool_name: "ask_question", tool_input: { questions } });
  });

  it("keeps mapped keys and does not let a structured key override them", () => {
    const out = normalizeAgyHookPayload({
      toolCall: { name: "run_command", args: { CommandLine: "ls", command: { x: 1 } } },
    }) as { tool_input: Record<string, unknown> };
    expect(out.tool_input.command).toBe("ls");
  });

  it("catalogues ask_question as a non-mutating tool", () => {
    expect(AGY_TOOL_DISPOSITIONS.ask_question?.mutates).toBe(false);
    expect(agyWriteIntent("ask_question")).toBe("other");
  });
});
