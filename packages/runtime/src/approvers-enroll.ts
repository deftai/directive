#!/usr/bin/env node
/**
 * approvers:enroll (#6945).
 *
 * Root when no trust file exists, otherwise an add. `--re-root` is the
 * lost-all-keys path. With no `--assertion` it prints the ceremony link and
 * writes nothing. The assertion is the page's combined trust-file blob.
 * There is no terminal step.
 */
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { approvers, containedWrite } from "@deftai/directive-core";
import {
  buildCeremonyLink,
  formatCeremonyOutput,
  loadCliTrustState,
  rpFromOrigin,
  signedLevelUsage,
} from "./approvers-link.js";
import { isDirectEntrypoint } from "./entrypoint.js";

export interface EnrollArgs {
  projectRoot: string;
  name: string;
  origin: string | null;
  reRoot: boolean;
  assertion: string | null;
  help?: boolean;
  error?: string;
}

export interface EnrollSeams {
  readonly repo?: string;
  readonly verifyRegistration?: approvers.RegistrationVerifier;
}

function usage(): string {
  return (
    "usage: approvers:enroll --name <n> [--origin <https-origin>] [--re-root] [--assertion <blob>] [--project-root <dir>]\n" +
    "  Root when .deft/approvers.json does not exist (requires --origin). Otherwise an add signed by an\n" +
    "  enrolled key. --re-root replaces the set with one newly attested key that no earlier version enrolled.\n" +
    "  With no --assertion, prints the ceremony link and writes nothing. --assertion accepts only the page's\n" +
    "  combined trust-file blob. No terminal step.\n" +
    signedLevelUsage()
  );
}

export function parseArgs(argv: string[]): EnrollArgs {
  const parsed: EnrollArgs = {
    projectRoot: ".",
    name: "",
    origin: null,
    reRoot: false,
    assertion: null,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--") continue;
    if (arg === "--help" || arg === "-h") return { ...parsed, help: true };
    if (arg === "--re-root") parsed.reRoot = true;
    else if (arg === "--name") {
      const value = argv[i + 1];
      if (value === undefined)
        return { ...parsed, error: "argument --name: expected one argument" };
      parsed.name = value;
      i += 1;
    } else if (arg?.startsWith("--name=")) parsed.name = arg.slice("--name=".length);
    else if (arg === "--origin") {
      const value = argv[i + 1];
      if (value === undefined)
        return { ...parsed, error: "argument --origin: expected one argument" };
      parsed.origin = value;
      i += 1;
    } else if (arg?.startsWith("--origin=")) parsed.origin = arg.slice("--origin=".length);
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
  if (parsed.name.trim().length === 0) return { ...parsed, error: `missing --name\n${usage()}` };
  parsed.name = parsed.name.trim();
  return parsed;
}

function sameIdSet(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const left = [...a].sort();
  const right = [...b].sort();
  return left.every((id, i) => id === right[i]);
}

export function run(argv: string[], seams: EnrollSeams = {}): number {
  const args = parseArgs(argv);
  if (args.help) {
    process.stdout.write(`${usage()}\n`);
    return 0;
  }
  if (args.error !== undefined) {
    process.stderr.write(`approvers_enroll: ${args.error}\n`);
    return 2;
  }
  const projectRoot = resolve(args.projectRoot);
  const loaded = loadCliTrustState(projectRoot, { verifyRegistration: seams.verifyRegistration });
  if ("error" in loaded) {
    process.stderr.write(`approvers_enroll: ${loaded.error}\n`);
    return 2;
  }
  const repo = seams.repo ?? approvers.resolveApprovalRepo(projectRoot);
  if (repo === null) {
    process.stderr.write(
      "approvers_enroll: cannot resolve this repository: set GITHUB_REPOSITORY or an origin remote.\n",
    );
    return 2;
  }
  const state = loaded.state;
  if (state === null && args.reRoot) {
    process.stderr.write(
      "approvers_enroll: --re-root needs an existing trust file. Omit it to root.\n",
    );
    return 2;
  }
  let origin = args.origin;
  let rp: approvers.ApproversRp;
  let predecessorDigest: string | null = null;
  const mode = state === null ? "enroll" : args.reRoot ? "re-root" : "enroll";
  if (state === null) {
    if (origin === null) {
      process.stderr.write("approvers_enroll: a root needs --origin <https-origin>.\n");
      return 2;
    }
    const parsed = rpFromOrigin(origin);
    if ("error" in parsed) {
      process.stderr.write(`approvers_enroll: ${parsed.error}\n`);
      return 2;
    }
    rp = parsed;
  } else {
    rp = state.file.body.rp;
    origin = rp.origins[0] ?? null;
    if (args.origin !== null && args.origin !== origin) {
      process.stderr.write(
        "approvers_enroll: --origin changes the page; that is a signed change the page makes, not a flag.\n",
      );
      return 2;
    }
    if (origin === null) {
      process.stderr.write("approvers_enroll: trust file has no ceremony origin.\n");
      return 2;
    }
    predecessorDigest = approvers.computeVersionDigest(state.file);
  }
  if (args.assertion === null) {
    const link = buildCeremonyLink(origin, {
      schema: "deft.ceremony-request.v1",
      mode: args.reRoot ? "re-root" : "enroll",
      repo,
      rp,
      name: args.name,
      predecessorDigest,
      predecessor: state === null ? null : state.file.body,
    });
    if ("error" in link) {
      process.stderr.write(`approvers_enroll: ${link.error}\n`);
      return 2;
    }
    process.stdout.write(`${formatCeremonyOutput(link)}\n`);
    return 0;
  }
  const file = approvers.parseApproversFile(args.assertion);
  if ("error" in file) {
    process.stderr.write(`approvers_enroll: ${file.error}. ${approvers.SIGNED_APPROVAL_CLAIM}\n`);
    return 1;
  }
  if (file.body.repo !== repo) {
    process.stderr.write(
      `approvers_enroll: blob names repository ${file.body.repo}, this repository is ${repo}.\n`,
    );
    return 1;
  }
  const next = approvers.applyTrustVersion(state, file, {
    at: "assertion",
    verifyRegistration: seams.verifyRegistration,
  });
  if (!next.ok) {
    process.stderr.write(`approvers_enroll: ${next.reason}. ${approvers.SIGNED_APPROVAL_CLAIM}\n`);
    return 1;
  }
  const ids = file.body.approvers.map((a) => a.credentialId);
  const previous = state === null ? [] : state.file.body.approvers.map((a) => a.credentialId);
  if (state === null || args.reRoot) {
    if (file.proof.kind !== (state === null ? "root" : "re-root")) {
      process.stderr.write(
        `approvers_enroll: expected a ${state === null ? "root" : "re-root"} proof.\n`,
      );
      return 1;
    }
    if (file.body.approvers.length !== 1 || file.body.approvers[0]?.name !== args.name) {
      process.stderr.write("approvers_enroll: the blob must enroll exactly the named key.\n");
      return 1;
    }
  } else if (mode === "enroll") {
    if (file.proof.kind !== "transition") {
      process.stderr.write(
        "approvers_enroll: an add must be a transition signed by an enrolled key.\n",
      );
      return 1;
    }
    const added = ids.filter((id) => !previous.includes(id));
    const removed = previous.filter((id) => !ids.includes(id));
    const addedId = added[0];
    if (
      added.length !== 1 ||
      removed.length !== 0 ||
      addedId === undefined ||
      !sameIdSet([...previous, addedId], ids)
    ) {
      process.stderr.write(
        "approvers_enroll: an add enrolls exactly one new key and removes none.\n",
      );
      return 1;
    }
    const created = file.body.approvers.find((a) => a.credentialId === addedId);
    if (created?.name !== args.name) {
      process.stderr.write(`approvers_enroll: the new key must be named ${args.name}.\n`);
      return 1;
    }
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
    process.stderr.write(`approvers_enroll: write failed: ${String(err)}\n`);
    return 1;
  }
  process.stdout.write(`Wrote ${target}. ${approvers.SIGNED_APPROVAL_CLAIM}\n`);
  return 0;
}

if (isDirectEntrypoint(import.meta.url)) {
  process.exit(run(process.argv.slice(2)));
}
