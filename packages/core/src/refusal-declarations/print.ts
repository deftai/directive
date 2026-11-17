/**
 * One print helper for declared refusals (#6281 item 2).
 *
 * The line names the gate id and the remedy. In `warn` mode the work proceeds
 * and the line says the gate can refuse from a later release. In `enforce` mode
 * the same line is the refusal. The line does not depend on any local warn
 * state: an install that skipped the warn release gets the same gate id and
 * remedy (#6281 item 9).
 */
import {
  findRefusalDeclaration,
  loadRefusalDeclarations,
  type RefusalDeclaration,
  type RefusalMode,
} from "./table.js";

export interface DeclaredRefusalLine {
  /** False only for an id that is not in the table. */
  readonly declared: boolean;
  readonly id: string;
  readonly mode: RefusalMode;
  /** True in `warn` mode: the caller lets the work proceed. */
  readonly proceed: boolean;
  /** The remedy commands exactly as printed, in order. */
  readonly remedy: readonly string[];
  readonly line: string;
}

/** Fill `{name}` placeholders from `values`; unknown names stay as written. */
export function fillRemedyCommand(
  command: string,
  values: Readonly<Record<string, string>> = {},
): string {
  return command.replace(/\{([A-Za-z][A-Za-z0-9_]*)\}/g, (whole, name: string) =>
    Object.hasOwn(values, name) ? (values[name] ?? whole) : whole,
  );
}

/** "`a`, then `b`" */
export function formatRemedyCommands(commands: readonly string[]): string {
  return commands.map((c) => `\`${c}\``).join(", then ");
}

/**
 * Format one declared refusal. `detail` says what the gate found. An id that
 * is not in the table still prints one line (as a refusal) so a caller never
 * prints nothing; the remedy test fails on such an id.
 */
export function formatDeclaredRefusal(input: {
  readonly id: string;
  readonly detail: string;
  readonly values?: Readonly<Record<string, string>>;
  readonly rows?: readonly RefusalDeclaration[];
}): DeclaredRefusalLine {
  const rows = input.rows ?? loadRefusalDeclarations();
  const row = findRefusalDeclaration(input.id, rows);
  const detail = input.detail.trim().replace(/\s*\.?$/, ".");
  if (row === null) {
    return {
      declared: false,
      id: input.id,
      mode: "enforce",
      proceed: false,
      remedy: [],
      line: `❌ deft gate ${input.id} (undeclared refusal): ${detail}`,
    };
  }
  const remedy = row.remedy.map((c) => fillRemedyCommand(c, input.values));
  const commands = formatRemedyCommands(remedy);
  const line =
    row.mode === "warn"
      ? `⚠ deft gate ${row.id} (${row.gate}) warns only in this release; it can refuse from a later release: ${detail} Remedy: ${commands}.`
      : `❌ deft gate ${row.id} (${row.gate}) refused: ${detail} Remedy: ${commands}.`;
  return {
    declared: true,
    id: row.id,
    mode: row.mode,
    proceed: row.mode === "warn",
    remedy,
    line,
  };
}

/** Extract the backtick-quoted remedy commands from a printed line, in order. */
export function parsePrintedRemedy(line: string): readonly string[] {
  const at = line.lastIndexOf(" Remedy: ");
  if (at < 0) {
    return [];
  }
  const out: string[] = [];
  const re = /`([^`]+)`/g;
  const tail = line.slice(at);
  let match: RegExpExecArray | null = re.exec(tail);
  while (match !== null) {
    out.push(match[1] ?? "");
    match = re.exec(tail);
  }
  return out;
}
