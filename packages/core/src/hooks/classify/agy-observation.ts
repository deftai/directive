/**
 * Antigravity (`agy`) host observation record and admission verdict
 * (#7345, slice `observe` of #7332).
 *
 * Pure data, no process I/O. Everything below was observed on the real host
 * (`agy` CLI) with a recording `PreToolUse` / `SessionStart` hook in a scratch
 * workspace, not read from documentation. Each behaviour names the scenario that
 * produced it; anything not observed carries a written reason instead of a
 * guessed answer (#3987).
 *
 * The verdict is the committed, machine-readable input that slice
 * `deposit-doctor` reads before it may add `agy` to the deposit definitions, flip
 * `DEFAULT_HOST_HOOKS_POLICY.agy`, or enable a fail-closed wrapper. It is not
 * cleared by an observation record, an `unobservedReason`, or a green shim probe.
 */

/** Host build the observations were taken on (`agy --version`). */
export const AGY_OBSERVED_HOST_VERSION = "1.5.16";

/** Date of the observation run (UTC calendar day). */
export const AGY_OBSERVED_ON = "2026-11-25";

/** Platform of the observation run. Unix `sh -c` hook execution was not observed. */
export const AGY_OBSERVED_PLATFORM = "win32";

/**
 * Real hook stdin captured from the host, with the workspace and home paths
 * rewritten to neutral placeholders. Top-level keys are camelCase; tool
 * arguments use capitalized keys (`CommandLine`, `Path`, `Content`).
 */
export const AGY_PRETOOLUSE_FIXTURES = {
  run_command: {
    artifactDirectoryPath:
      "C:\\Users\\user\\.gemini\\antigravity-cli\\brain\\4432514a-f897-4dbf-9276-b9d8aca01eb7",
    conversationId: "4432514a-f897-4dbf-9276-b9d8aca01eb7",
    cwd: "C:\\work\\agy-observe\\ws",
    hookEventName: "PreToolUse",
    lastUserInput:
      "Run the shell command: echo hello-obs . Then reply with one short sentence stating exactly what the tool result or error said.",
    modelName: "gemini-4-neon-high",
    stepIdx: 2,
    toolCall: {
      args: {
        CommandLine: "echo hello-obs",
        WaitMsBeforeAsync: 5000,
        toolSummary: "Echo hello-obs",
      },
      id: "call_2862431158386308451",
      name: "run_command",
    },
    transcriptPath:
      "C:\\Users\\user\\.gemini\\antigravity-cli\\brain\\4432514a-f897-4dbf-9276-b9d8aca01eb7\\.system_generated\\logs\\transcript_full.jsonl",
    workspacePaths: ["C:\\work\\agy-observe\\ws"],
  },
  write_file: {
    artifactDirectoryPath:
      "C:\\Users\\user\\.gemini\\antigravity-cli\\brain\\7167dbce-f080-4c18-ae4a-b74b36d2138d",
    conversationId: "7167dbce-f080-4c18-ae4a-b74b36d2138d",
    cwd: "C:\\work\\agy-observe\\ws",
    hookEventName: "PreToolUse",
    lastUserInput:
      "Do these in order: (1) create a file named obs-note.txt containing the single word hi using your file writing tool; (2) edit obs-note.txt to replace hi with hello using your file edit tool; (3) view obs-note.txt; (4) run the shell command echo done. Reply with one short sentence.",
    modelName: "gemini-4-neon-high",
    stepIdx: 2,
    toolCall: {
      args: {
        Content: "hi",
        Overwrite: true,
        Path: "C:\\work\\agy-observe\\ws\\obs-note.txt",
      },
      id: "call_9212740026150763301",
      name: "write_file",
    },
    transcriptPath:
      "C:\\Users\\user\\.gemini\\antigravity-cli\\brain\\7167dbce-f080-4c18-ae4a-b74b36d2138d\\.system_generated\\logs\\transcript_full.jsonl",
    workspacePaths: ["C:\\work\\agy-observe\\ws"],
  },
  edit_file: {
    artifactDirectoryPath:
      "C:\\Users\\user\\.gemini\\antigravity-cli\\brain\\7167dbce-f080-4c18-ae4a-b74b36d2138d",
    conversationId: "7167dbce-f080-4c18-ae4a-b74b36d2138d",
    cwd: "C:\\work\\agy-observe\\ws",
    hookEventName: "PreToolUse",
    lastUserInput:
      "Do these in order: (1) create a file named obs-note.txt containing the single word hi using your file writing tool; (2) edit obs-note.txt to replace hi with hello using your file edit tool; (3) view obs-note.txt; (4) run the shell command echo done. Reply with one short sentence.",
    modelName: "gemini-4-neon-high",
    stepIdx: 4,
    toolCall: {
      args: {
        Path: "C:\\work\\agy-observe\\ws\\obs-note.txt",
        Replacement: "hello",
        Target: "hi",
      },
      id: "call_7596087045967347921",
      name: "edit_file",
    },
    transcriptPath:
      "C:\\Users\\user\\.gemini\\antigravity-cli\\brain\\7167dbce-f080-4c18-ae4a-b74b36d2138d\\.system_generated\\logs\\transcript_full.jsonl",
    workspacePaths: ["C:\\work\\agy-observe\\ws"],
  },
  read_file: {
    artifactDirectoryPath:
      "C:\\Users\\user\\.gemini\\antigravity-cli\\brain\\7167dbce-f080-4c18-ae4a-b74b36d2138d",
    conversationId: "7167dbce-f080-4c18-ae4a-b74b36d2138d",
    cwd: "C:\\work\\agy-observe\\ws",
    hookEventName: "PreToolUse",
    lastUserInput:
      "Do these in order: (1) create a file named obs-note.txt containing the single word hi using your file writing tool; (2) edit obs-note.txt to replace hi with hello using your file edit tool; (3) view obs-note.txt; (4) run the shell command echo done. Reply with one short sentence.",
    modelName: "gemini-4-neon-high",
    stepIdx: 7,
    toolCall: {
      args: {
        Path: "C:\\work\\agy-observe\\ws\\obs-note.txt",
      },
      id: "call_8342801002953463108",
      name: "read_file",
    },
    transcriptPath:
      "C:\\Users\\user\\.gemini\\antigravity-cli\\brain\\7167dbce-f080-4c18-ae4a-b74b36d2138d\\.system_generated\\logs\\transcript_full.jsonl",
    workspacePaths: ["C:\\work\\agy-observe\\ws"],
  },
  invoke_subagent: {
    artifactDirectoryPath:
      "C:\\Users\\user\\.gemini\\antigravity-cli\\brain\\c0b0ea0b-094f-4a32-9bf0-581f9d0be1d9",
    conversationId: "c0b0ea0b-094f-4a32-9bf0-581f9d0be1d9",
    cwd: "C:\\work\\agy-observe\\ws",
    hookEventName: "PreToolUse",
    lastUserInput:
      "Use your invoke_subagent tool (spawn a subagent) and have the subagent run the shell command: echo child-obs . Then reply with one short sentence.",
    modelName: "gemini-4-neon-high",
    stepIdx: 2,
    toolCall: {
      args: {
        Prompt:
          "Run the shell command `echo child-obs` using your run_command tool and report the exact output back to me.",
        Role: "Shell Command Runner",
        TypeName: "self",
      },
      id: "call_12241872179590235618",
      name: "invoke_subagent",
    },
    transcriptPath:
      "C:\\Users\\user\\.gemini\\antigravity-cli\\brain\\c0b0ea0b-094f-4a32-9bf0-581f9d0be1d9\\.system_generated\\logs\\transcript_full.jsonl",
    workspacePaths: ["C:\\work\\agy-observe\\ws"],
  },
  child_run_command: {
    artifactDirectoryPath:
      "C:\\Users\\user\\.gemini\\antigravity-cli\\brain\\5ec214bb-2abe-4cbd-a8da-f6fda30e17da",
    conversationId: "5ec214bb-2abe-4cbd-a8da-f6fda30e17da",
    cwd: "C:\\work\\agy-observe\\ws",
    hookEventName: "PreToolUse",
    lastUserInput: "",
    modelName: "gemini-4-neon-high",
    stepIdx: 2,
    toolCall: {
      args: {
        CommandLine: "echo child-obs",
        WaitMsBeforeAsync: 5000,
        toolSummary: "Echo child-obs",
      },
      id: "call_150912588887163814",
      name: "run_command",
    },
    transcriptPath:
      "C:\\Users\\user\\.gemini\\antigravity-cli\\brain\\5ec214bb-2abe-4cbd-a8da-f6fda30e17da\\.system_generated\\logs\\transcript_full.jsonl",
    workspacePaths: ["C:\\work\\agy-observe\\ws"],
  },
  child_send_message: {
    artifactDirectoryPath:
      "C:\\Users\\user\\.gemini\\antigravity-cli\\brain\\5ec214bb-2abe-4cbd-a8da-f6fda30e17da",
    conversationId: "5ec214bb-2abe-4cbd-a8da-f6fda30e17da",
    cwd: "C:\\work\\agy-observe\\ws",
    hookEventName: "PreToolUse",
    lastUserInput: "",
    modelName: "gemini-4-neon-high",
    stepIdx: 6,
    toolCall: {
      args: {
        Message:
          "Ran `echo child-obs` (exit code 0). Exact command output:\n```\nAttempting to perform the InitializeDefaultDrives operation on the 'FileSystem' provider failed.\nchild-obs\n```\n(The stdout line from `echo child-obs` itself is `child-obs`.)",
        Recipient: "c0b0ea0b-094f-4a32-9bf0-581f9d0be1d9",
      },
      id: "call_5209238358625796825",
      name: "send_message",
    },
    transcriptPath:
      "C:\\Users\\user\\.gemini\\antigravity-cli\\brain\\5ec214bb-2abe-4cbd-a8da-f6fda30e17da\\.system_generated\\logs\\transcript_full.jsonl",
    workspacePaths: ["C:\\work\\agy-observe\\ws"],
  },
} as const;

/** Real `SessionStart` hook stdin (no `toolCall`, no `stepIdx`). */
export const AGY_SESSION_START_FIXTURE = {
  artifactDirectoryPath:
    "C:\\Users\\user\\.gemini\\antigravity-cli\\brain\\4432514a-f897-4dbf-9276-b9d8aca01eb7",
  conversationId: "4432514a-f897-4dbf-9276-b9d8aca01eb7",
  cwd: "C:\\work\\agy-observe\\ws",
  hookEventName: "SessionStart",
  lastUserInput:
    "Run the shell command: echo hello-obs . Then reply with one short sentence stating exactly what the tool result or error said.",
  modelName: "gemini-4-neon-high",
  transcriptPath:
    "C:\\Users\\user\\.gemini\\antigravity-cli\\brain\\4432514a-f897-4dbf-9276-b9d8aca01eb7\\.system_generated\\logs\\transcript_full.jsonl",
  workspacePaths: ["C:\\work\\agy-observe\\ws"],
} as const;

export type AgyAdmissionProperty =
  | "nonWeakenableDenial"
  | "finalExecutedArgumentIntegrity"
  | "runtimeFailureBoundary";

export type AgyAdmissionStatus = "pass" | "fail";

export interface AgyObservedBehavior {
  /** Scenario ids from the observation run, so a reader can re-run them. */
  readonly scenarios: readonly string[];
  readonly observed: string;
}

export interface AgyPropertyVerdict {
  readonly status: AgyAdmissionStatus;
  readonly summary: string;
  readonly evidence: readonly string[];
  /** Hazards the observation exposed even where the status is `pass`. */
  readonly hazards: readonly string[];
}

export interface AgyAdmissionVerdict {
  readonly schema: "deft.agy.admission-verdict.v1";
  readonly host: "agy";
  readonly hostVersion: string;
  readonly observedOn: string;
  readonly properties: Readonly<Record<AgyAdmissionProperty, AgyPropertyVerdict>>;
  /** `pass` only when every property passes. */
  readonly overall: AgyAdmissionStatus;
  /** What the observation did not establish. Never clears a `fail`. */
  readonly unobserved: readonly string[];
}

/**
 * Observed host behaviour. The scenario ids name the recorder runs: a recording
 * hook (`node rec.mjs <mode> <tag>`) registered under `.agents/hooks.json` in a
 * scratch workspace, one `agy -p` turn per scenario.
 */
export const AGY_OBSERVED_BEHAVIORS = {
  hookRegistration: {
    scenarios: ["s01"],
    observed:
      "`.agents/hooks.json` named-object hooks run on SessionStart and PreToolUse. The hook " +
      "command runs through `cmd /c` with the working directory set to `.agents/`, so a " +
      "relative script path resolves against `.agents/`, not the workspace.",
  },
  denyDecision: {
    scenarios: ["s02"],
    observed:
      "`{decision:'deny', reason}` blocks the tool call; the model sees " +
      "`tool call denied by pre-tool hook: <reason>`. The tool does not run.",
  },
  nonZeroExit: {
    scenarios: ["s03", "s04"],
    observed:
      "A hook that exits 1 or 2 blocks the tool call (`JSON hook ... failed: command failed: " +
      "exit status N`), including its stderr text. Fail-closed.",
  },
  emptyStdout: {
    scenarios: ["s05"],
    observed:
      "A hook that exits 0 with empty stdout does NOT block: the tool call runs. Fail-open.",
  },
  malformedJson: {
    scenarios: ["s06"],
    observed:
      "Exit 0 with malformed JSON stdout blocks the tool call (`failed to unmarshal result ... " +
      "via protojson`). Fail-closed.",
  },
  timeout: {
    scenarios: ["s07"],
    observed:
      "A hook that outlives its configured `timeout` (3 s) is killed and the tool call is " +
      "blocked (`command failed: exit status 1`). Fail-closed.",
  },
  wrapperNeverStarts: {
    scenarios: ["s08"],
    observed:
      "A hook command that cannot start (`nodex-missing`, 'not recognized as an internal or " +
      "external command'; or a `node` script path that does not exist) exits non-zero under " +
      "`cmd /c` and the tool call is blocked. Fail-closed on win32.",
  },
  denyPrecedence: {
    scenarios: ["s09", "s10", "s14", "s15"],
    observed:
      "A deny from any hook blocks the call in every position: deny then allow, allow then " +
      "deny, rewrite then deny, deny then rewrite. After a deny the later hooks do not run.",
  },
  overwriteVisibility: {
    scenarios: ["s11", "s23"],
    observed:
      "Hooks run sequentially and a later hook's stdin carries the earlier hook's " +
      "`overwrite` already applied (`CommandLine` was `echo REWRITTEN-a`). The model's tool " +
      "result names the changed key.",
  },
  overwriteLastWins: {
    scenarios: ["s12", "s13", "s22"],
    observed:
      "The last `overwrite` to the same key is what executes, even after an earlier hook " +
      "allowed or rewrote the original: allow then rewrite ran `REWRITTEN-b`; rewrite then " +
      "rewrite ran `REWRITTEN-b`.",
  },
  hookOrder: {
    scenarios: ["s22", "s23"],
    observed:
      "Named hooks run in hook-name order, not file order: `obs-z` listed before `obs-a` in the " +
      "file still ran after it.",
  },
  matcherSemantics: {
    scenarios: ["s16", "s17", "s18", "s19"],
    observed:
      "Matcher is a case-sensitive regex over the tool name: `*` and the empty string match " +
      "every tool, `run_command|write_file` matches `run_command`, `write_file` does not match " +
      "`run_command`, `RUN_COMMAND` does not match `run_command`.",
  },
  conversationId: {
    scenarios: ["s20", "s21"],
    observed:
      "`conversationId` is stable across one session's hooks. A subagent started with " +
      "`invoke_subagent` runs its own hooks under a DIFFERENT `conversationId`; the child's " +
      "`send_message` names the parent id only in `args.Recipient`. The child payload carries " +
      "no parent field.",
  },
  toolNames: {
    scenarios: ["s01", "s20", "s21"],
    observed:
      "Tool names emitted: `run_command` (`CommandLine`), `write_file` (`Path`, `Content`), " +
      "`edit_file` (`Path`, `Target`, `Replacement`), `read_file` (`Path`), `invoke_subagent` " +
      "(`Prompt`, `Role`, `TypeName`), `send_message` (`Message`, `Recipient`). `Path` was an " +
      "absolute path.",
  },
} as const satisfies Readonly<Record<string, AgyObservedBehavior>>;

/**
 * Admission verdict (#7345). `fail` on any property halts slice `deposit-doctor`
 * activation and routes the unmet deposit scope to a follow-up issue.
 */
export const AGY_ADMISSION_VERDICT: AgyAdmissionVerdict = {
  schema: "deft.agy.admission-verdict.v1",
  host: "agy",
  hostVersion: AGY_OBSERVED_HOST_VERSION,
  observedOn: AGY_OBSERVED_ON,
  properties: {
    nonWeakenableDenial: {
      status: "pass",
      summary:
        "A deny from any hook, in any position, blocks the call and stops later hooks, so a " +
        "foreign hook cannot weaken a Directive deny.",
      evidence: ["s02", "s09", "s10", "s14", "s15"],
      hazards: [],
    },
    finalExecutedArgumentIntegrity: {
      status: "fail",
      summary:
        "The last `overwrite` wins and hooks run in name order. A foreign hook whose name sorts " +
        "after Directive's can rewrite `CommandLine` after Directive admitted it, and the host " +
        "offers no way to pin Directive last or lock the arguments. Only the arrangement " +
        "'Directive entry sorts last by name' preserves integrity (a later hook sees earlier " +
        "rewrites: s11, s23), and it is not enforceable.",
      evidence: ["s11", "s12", "s13", "s22", "s23"],
      hazards: [
        "A foreign hook named to sort after the Directive entry can replace the executed command.",
        "Hook scopes other than the project `.agents/hooks.json` (user config, plugins) were not observed.",
      ],
    },
    runtimeFailureBoundary: {
      status: "pass",
      summary:
        "The host fails closed when a hook exits non-zero, emits malformed JSON, exceeds its " +
        "timeout, or cannot start, so a wrapper that exits non-zero on any internal error " +
        "blocks the call. The one fail-open path is exit 0 with empty stdout.",
      evidence: ["s03", "s04", "s05", "s06", "s07", "s08"],
      hazards: [
        "Exit 0 with empty stdout lets the call run (s05): a wrapper must emit an explicit " +
          "decision or exit non-zero, never exit 0 silently.",
        "Observed under win32 `cmd /c` only; the POSIX `sh -c` failure boundary was not observed.",
      ],
    },
  },
  overall: "fail",
  unobserved: [
    "Unix `sh -c` hook execution and the missing-`node` exit code under `sh`.",
    "Hook scopes beyond project `.agents/hooks.json`: `~/.gemini/config/` and plugin `hooks.json`.",
    "Tool names `run_workflow`, `swarm`, `define_subagent`, and any delete, rename or move file tool: none was emitted by the observed prompts.",
    "`PostToolUse`, `PreInvocation`, `PostInvocation` and `Stop` payloads (v1 non-goals).",
    "Behaviour after an Antigravity upgrade past 1.5.16.",
  ],
};

/** True only when the committed verdict passes every property. */
export function agyAdmissionPasses(verdict: AgyAdmissionVerdict = AGY_ADMISSION_VERDICT): boolean {
  return (
    verdict.overall === "pass" &&
    Object.values(verdict.properties).every((property) => property.status === "pass")
  );
}
