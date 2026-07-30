#!/usr/bin/env node
/**
 * Escalation CLI (#518 slim / #2948 Wave 5): typed queue under .deft/escalations/.
 *
 *   deft escalation:file -- --type cmd_approval --title "…"
 *   deft escalation:list [--open] [--type <type>] [--format json]
 *   deft escalation:resolve -- <id> --decision approved|denied|answered|dismissed
 *   deft escalation:batch-approve [--ids a,b] [--include-dangerous]
 */
import {
  batchApproveEscalations,
  ESCALATION_TYPES,
  type EscalationType,
  fileEscalation,
  isEscalationType,
  listEscalationsFiltered,
  resolveEscalation,
} from "@deftai/directive-core/escalation";

interface Parsed {
  cmd: "file" | "list" | "resolve" | "batch-approve";
  projectRoot: string;
  type: string | null;
  title: string | null;
  body: string | null;
  agentId: string;
  contextRefs: string[];
  slaHours: number | null;
  dangerous: boolean;
  id: string | null;
  ids: string[];
  decision: string | null;
  actor: string;
  note: string | null;
  answer: string | null;
  openOnly: boolean;
  includeDangerous: boolean;
  format: "text" | "json";
  error?: string;
}

function parseArgv(argv: string[]): Parsed {
  const base: Parsed = {
    cmd: "list",
    projectRoot: process.cwd(),
    type: null,
    title: null,
    body: null,
    agentId: "agent",
    contextRefs: [],
    slaHours: null,
    dangerous: false,
    id: null,
    ids: [],
    decision: null,
    actor: "operator",
    note: null,
    answer: null,
    openOnly: false,
    includeDangerous: false,
    format: "text",
  };

  const args = [...argv];
  while (args[0] === "--") args.shift();

  if (args.length > 0 && !args[0]?.startsWith("-")) {
    const cmd = args.shift() as string;
    if (cmd === "file" || cmd === "list" || cmd === "resolve" || cmd === "batch-approve") {
      base.cmd = cmd;
    } else if (cmd.startsWith("esc-")) {
      base.cmd = "resolve";
      base.id = cmd;
    } else {
      return { ...base, error: `unknown escalation subcommand: ${cmd}` };
    }
  }

  while (args[0] === "--") args.shift();

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === undefined) break;
    if (a === "--project-root" || a === "--projectRoot") {
      base.projectRoot = args[++i] ?? base.projectRoot;
      continue;
    }
    if (a === "--type") {
      base.type = args[++i] ?? null;
      continue;
    }
    if (a === "--title") {
      base.title = args[++i] ?? null;
      continue;
    }
    if (a === "--body") {
      base.body = args[++i] ?? null;
      continue;
    }
    if (a === "--agent" || a === "--agent-id" || a === "--agentId") {
      base.agentId = args[++i] ?? base.agentId;
      continue;
    }
    if (a === "--context" || a === "--context-refs" || a === "--contextRefs") {
      const raw = args[++i] ?? "";
      base.contextRefs = raw
        .split(/[,\s]+/)
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
      continue;
    }
    if (a === "--sla-hours" || a === "--slaHours") {
      const n = Number(args[++i] ?? "");
      base.slaHours = Number.isFinite(n) ? n : null;
      continue;
    }
    if (a === "--dangerous") {
      base.dangerous = true;
      continue;
    }
    if (a === "--id") {
      base.id = args[++i] ?? null;
      continue;
    }
    if (a === "--ids") {
      const raw = args[++i] ?? "";
      base.ids = raw
        .split(/[,\s]+/)
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
      continue;
    }
    if (a === "--decision") {
      base.decision = args[++i] ?? null;
      continue;
    }
    if (a === "--actor") {
      base.actor = args[++i] ?? base.actor;
      continue;
    }
    if (a === "--note") {
      base.note = args[++i] ?? null;
      continue;
    }
    if (a === "--answer") {
      base.answer = args[++i] ?? null;
      continue;
    }
    if (a === "--open") {
      base.openOnly = true;
      continue;
    }
    if (a === "--include-dangerous") {
      base.includeDangerous = true;
      continue;
    }
    if (a === "--format") {
      const fmt = (args[++i] ?? "text").toLowerCase();
      base.format = fmt === "json" ? "json" : "text";
      continue;
    }
    if (!a.startsWith("-") && base.cmd === "resolve" && base.id === null) {
      base.id = a;
      continue;
    }
    if (a === "--help" || a === "-h") {
      return { ...base, error: "help" };
    }
  }
  return base;
}

function helpText(): string {
  return [
    "Usage:",
    "  deft escalation:file -- --type <type> --title <text> [--body <text>] [--agent <id>]",
    "      [--context refs…] [--sla-hours N] [--dangerous] [--format json]",
    "  deft escalation:list [--open] [--type <type>] [--format json]",
    "  deft escalation:resolve -- <id> --decision approved|denied|answered|dismissed",
    "      [--note <text>] [--answer <text>] [--actor <name>]",
    "  deft escalation:batch-approve [--ids a,b] [--include-dangerous] [--note <text>]",
    "",
    `Types: ${ESCALATION_TYPES.join(", ")}`,
    "Bulk batch-approve is limited to cmd_approval + question (non-dangerous by default).",
    "design_decision / approval / resource / external require individual resolve.",
    "Store: .deft/escalations/<id>.json  Contract: content/contracts/escalation.md",
    "Compose gated actions with deft authz:grant after approval (Wave 1 grants).",
  ].join("\n");
}

export function main(argv: string[] = process.argv.slice(2)): number {
  const args = parseArgv(argv);
  if (args.error === "help") {
    process.stdout.write(`${helpText()}\n`);
    return 0;
  }
  if (args.error !== undefined) {
    process.stderr.write(`escalation: ${args.error}\n`);
    process.stderr.write(`${helpText()}\n`);
    return 2;
  }

  try {
    switch (args.cmd) {
      case "file": {
        if (args.type === null || args.type.trim().length === 0) {
          process.stderr.write("escalation:file requires --type <type>\n");
          return 2;
        }
        if (args.title === null || args.title.trim().length === 0) {
          process.stderr.write("escalation:file requires --title <text>\n");
          return 2;
        }
        const event = fileEscalation({
          projectRoot: args.projectRoot,
          type: args.type,
          title: args.title,
          body: args.body ?? undefined,
          agentId: args.agentId,
          contextRefs: args.contextRefs,
          slaHours: args.slaHours ?? undefined,
          dangerous: args.dangerous,
          id: args.id ?? undefined,
        });
        if (args.format === "json") {
          process.stdout.write(`${JSON.stringify(event, null, 2)}\n`);
        } else {
          process.stdout.write(
            `✓ escalation filed id=${event.id} type=${event.type} status=${event.status}` +
              `${event.dangerous ? " dangerous=true" : ""}\n`,
          );
          process.stdout.write(`  title=${event.title}\n`);
          process.stdout.write(`  store=.deft/escalations/${event.id}.json\n`);
        }
        return 0;
      }
      case "list": {
        let typeFilter: EscalationType | undefined;
        if (args.type !== null && args.type.trim().length > 0) {
          if (!isEscalationType(args.type.trim().toLowerCase())) {
            process.stderr.write(
              `escalation:list unknown --type '${args.type}'; expected: ${ESCALATION_TYPES.join(", ")}\n`,
            );
            return 2;
          }
          typeFilter = args.type.trim().toLowerCase() as EscalationType;
        }
        const items = listEscalationsFiltered(args.projectRoot, {
          openOnly: args.openOnly,
          type: typeFilter,
        });
        if (args.format === "json") {
          process.stdout.write(`${JSON.stringify(items, null, 2)}\n`);
          return 0;
        }
        if (items.length === 0) {
          process.stdout.write(
            args.openOnly ? "No open escalations.\n" : "No escalations on disk.\n",
          );
          return 0;
        }
        process.stdout.write(`Escalations (${items.length}):\n`);
        for (const e of items) {
          const dang = e.dangerous ? " !dangerous" : "";
          process.stdout.write(
            `  - ${e.id} [${e.status}] type=${e.type}${dang} agent=${e.agentId} sla=${e.slaHours}h\n`,
          );
          process.stdout.write(`      ${e.title}\n`);
          if (e.resolution) {
            process.stdout.write(
              `      → ${e.resolution.decision} by ${e.resolution.resolvedBy} @ ${e.resolution.resolvedAt}\n`,
            );
          }
        }
        return 0;
      }
      case "resolve": {
        if (args.id === null || args.id.trim().length === 0) {
          process.stderr.write("escalation:resolve requires <id>\n");
          return 2;
        }
        if (args.decision === null || args.decision.trim().length === 0) {
          process.stderr.write(
            "escalation:resolve requires --decision approved|denied|answered|dismissed\n",
          );
          return 2;
        }
        const result = resolveEscalation({
          projectRoot: args.projectRoot,
          id: args.id,
          decision: args.decision,
          actor: args.actor,
          note: args.note,
          answer: args.answer,
        });
        if (!result.ok) {
          process.stderr.write(`escalation: ${result.message}\n`);
          return result.code === "not-found" ? 1 : 2;
        }
        if (args.format === "json") {
          process.stdout.write(`${JSON.stringify(result.event, null, 2)}\n`);
        } else {
          process.stdout.write(
            `✓ resolved id=${result.event.id} decision=${result.event.resolution?.decision}\n`,
          );
          process.stdout.write(
            "  For gated product actions, mint a Wave 1 grant: deft authz:grant …\n",
          );
        }
        return 0;
      }
      case "batch-approve": {
        const batch = batchApproveEscalations({
          projectRoot: args.projectRoot,
          ids: args.ids.length > 0 ? args.ids : undefined,
          actor: args.actor,
          note: args.note,
          includeDangerous: args.includeDangerous,
        });
        if (args.format === "json") {
          process.stdout.write(`${JSON.stringify(batch, null, 2)}\n`);
        } else {
          process.stdout.write(
            `✓ batch-approve approved=${batch.approved.length} skipped=${batch.skipped.length}\n`,
          );
          for (const e of batch.approved) {
            process.stdout.write(`  + ${e.id} type=${e.type}\n`);
          }
          for (const s of batch.skipped) {
            process.stdout.write(`  - skip ${s.id}: ${s.reason}\n`);
          }
        }
        return 0;
      }
      default:
        process.stderr.write(`${helpText()}\n`);
        return 2;
    }
  } catch (err) {
    process.stderr.write(`escalation: ${String(err)}\n`);
    return 1;
  }
}

export default main;

if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, "/")}`) {
  process.exitCode = main();
}
