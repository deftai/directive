#!/usr/bin/env node
/**
 * approvers:remove (#6945).
 *
 * Prints a ceremony link, or accepts the page's combined blob that drops one
 * credential. A transition that leaves no attested credential is refused.
 * There is no terminal step.
 */
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { approvers, containedWrite } from "@deftai/directive-core";
import {
  buildCeremonyLink,
  formatCeremonyOutput,
  loadCliTrustState,
  signedLevelUsage,
} from "./approvers-link.js";
import { isDirectEntrypoint } from "./entrypoint.js";

export interface RemoveArgs {
  projectRoot: string;
  credentialId: string;
  assertion: string | null;
  help?: boolean;
  error?: string;
}

export interface RemoveSeams {
  readonly repo?: string;
  readonly verifyRegistration?: approvers.RegistrationVerifier;
}

function usage(): string {
  return (
    "usage: approvers:remove --credential <id> [--assertion <blob>] [--project-root <dir>]\n" +
    "  Drops one enrolled credential. With no --assertion, prints the ceremony link and writes nothing.\n" +
    "  --assertion accepts only the page's combined trust-file blob. Removing the last attested\n" +
    "  credential is refused. No terminal step.\n" +
    signedLevelUsage()
  );
}

export function parseArgs(argv: string[]): RemoveArgs {
  const parsed: RemoveArgs = { projectRoot: ".", credentialId: "", assertion: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--") continue;
    if (arg === "--help" || arg === "-h") return { ...parsed, help: true };
    if (arg === "--credential") {
      const value = argv[i + 1];
      if (value === undefined)
        return { ...parsed, error: "argument --credential: expected one argument" };
      parsed.credentialId = value;
      i += 1;
    } else if (arg?.startsWith("--credential="))
      parsed.credentialId = arg.slice("--credential=".length);
    else if (arg === "--assertion") {
      const value = argv[i + 1];
      if (value === undefined)
        return { ...parsed, error: "argument --assertion: expected one argument" };
      parsed.assertion = value;
      i += 1;
    } else if (arg?.startsWith("--assertion=")) parsed.assertion = arg.slice("--assertion=".length);
    else if (arg === "--project-root") {
      const value = argv[i + 1];
      if (value === undefined)
        return { ...parsed, error: "argument --project-root: expected one argument" };
      parsed.projectRoot = value;
      i += 1;
    } else if (arg?.startsWith("--project-root="))
      parsed.projectRoot = arg.slice("--project-root=".length);
    else return { ...parsed, error: `unrecognized argument: ${String(arg)}` };
  }
  if (parsed.help) return parsed;
  if (parsed.credentialId.trim().length === 0) {
    return { ...parsed, error: `missing --credential\n${usage()}` };
  }
  parsed.credentialId = parsed.credentialId.trim();
  return parsed;
}

export function run(argv: string[], seams: RemoveSeams = {}): number {
  const args = parseArgs(argv);
  if (args.help) {
    process.stdout.write(`${usage()}\n`);
    return 0;
  }
  if (args.error !== undefined) {
    process.stderr.write(`approvers_remove: ${args.error}\n`);
    return 2;
  }
  const projectRoot = resolve(args.projectRoot);
  const loaded = loadCliTrustState(projectRoot, { verifyRegistration: seams.verifyRegistration });
  if ("error" in loaded) {
    process.stderr.write(`approvers_remove: ${loaded.error}\n`);
    return 2;
  }
  if (loaded.state === null) {
    process.stderr.write(
      "approvers_remove: no .deft/approvers.json to remove a credential from.\n",
    );
    return 2;
  }
  const state = loaded.state;
  if (!state.file.body.approvers.some((a) => a.credentialId === args.credentialId)) {
    process.stderr.write(`approvers_remove: credential ${args.credentialId} is not enrolled.\n`);
    return 2;
  }
  const repo = seams.repo ?? approvers.resolveApprovalRepo(projectRoot);
  if (repo === null) {
    process.stderr.write(
      "approvers_remove: cannot resolve this repository: set GITHUB_REPOSITORY or an origin remote.\n",
    );
    return 2;
  }
  const origin = state.file.body.rp.origins[0];
  if (origin === undefined) {
    process.stderr.write("approvers_remove: trust file has no ceremony origin.\n");
    return 2;
  }
  if (args.assertion === null) {
    const link = buildCeremonyLink(origin, {
      schema: "deft.ceremony-request.v1",
      mode: "remove",
      repo,
      rp: state.file.body.rp,
      credentialId: args.credentialId,
      predecessorDigest: approvers.computeVersionDigest(state.file),
      predecessor: state.file.body,
    });
    if ("error" in link) {
      process.stderr.write(`approvers_remove: ${link.error}\n`);
      return 2;
    }
    process.stdout.write(`${formatCeremonyOutput(link)}\n`);
    return 0;
  }
  const file = approvers.parseApproversFile(args.assertion);
  if ("error" in file) {
    process.stderr.write(`approvers_remove: ${file.error}. ${approvers.SIGNED_APPROVAL_CLAIM}\n`);
    return 1;
  }
  if (file.proof.kind !== "transition") {
    process.stderr.write(
      "approvers_remove: removal must be a transition signed by an enrolled key.\n",
    );
    return 1;
  }
  const nextIds = file.body.approvers.map((a) => a.credentialId);
  const prevIds = state.file.body.approvers.map((a) => a.credentialId);
  if (nextIds.includes(args.credentialId) || nextIds.length !== prevIds.length - 1) {
    process.stderr.write(`approvers_remove: the blob must drop only ${args.credentialId}.\n`);
    return 1;
  }
  const next = approvers.applyTrustVersion(state, file, {
    at: "assertion",
    verifyRegistration: seams.verifyRegistration,
  });
  if (!next.ok) {
    process.stderr.write(`approvers_remove: ${next.reason}. ${approvers.SIGNED_APPROVAL_CLAIM}\n`);
    return 1;
  }
  const target = join(projectRoot, approvers.APPROVERS_FILE_REL);
  try {
    mkdirSync(dirname(target), { recursive: true });
    containedWrite({
      root: projectRoot,
      target,
      data: `${JSON.stringify(file, null, 2)}\n`,
      mode: existsSync(target) ? "replace" : "create",
      mutation: false,
    });
  } catch (err: unknown) {
    process.stderr.write(`approvers_remove: write failed: ${String(err)}\n`);
    return 1;
  }
  process.stdout.write(`Wrote ${target}. ${approvers.SIGNED_APPROVAL_CLAIM}\n`);
  return 0;
}

if (isDirectEntrypoint(import.meta.url)) {
  process.exit(run(process.argv.slice(2)));
}
