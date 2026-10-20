/**
 * Contract 1 repository uninstaller (R11 / AC11.5).
 * Removes owned hook registrations first, then owned files/sections.
 * Returns removals and what remains so launcher cleanup can continue.
 * Does not remove the PM dependency or mutate core.hooksPath (launcher bookend).
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { containedRemove } from "@deftai/directive-core/dist/fs/contained-write.js";
import {
  inspectOwnershipRecord,
  MANAGED_SECTION_CLOSE,
  MANAGED_SECTION_OPEN_PREFIX,
  type OwnedArtifact,
} from "@deftai/directive-core/dist/install-health/index.js";
import { pruneEmptyAncestors, removeSoleAuthorHusks } from "./removal-steps/steps.js";
import { HOOK_BIN_COMMAND, RUNTIME_PREFIX, SKILL_POINTER_INVENTORY } from "./setup-wiring.js";

export interface UninstallResult {
  readonly contract: 1;
  readonly entry: "uninstall";
  readonly stub: false;
  readonly root: string;
  readonly removed: string[];
  readonly modified: string[];
  readonly remaining: string[];
  readonly preserved: string[];
  readonly message: string;
}

const SKILL_HOST_ROOTS = [
  ".agents/skills",
  ".claude/skills",
  ".cursor/skills",
  ".codex/skills",
  ".github/skills",
] as const;

const GITHOOK_RELS = [
  ".githooks/pre-commit",
  ".githooks/pre-push",
  ".githooks/_directive-run.sh",
] as const;

const HOST_HOOK_RELS = [
  ".claude/settings.json",
  ".cursor/hooks.json",
  ".codex/hooks.json",
  ".grok/hooks/deft.json",
] as const;

function readText(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

function readJsonObject(path: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function isManagedHookCommand(command: string): boolean {
  return (
    command.includes(HOOK_BIN_COMMAND) ||
    command.includes("directive-runtime/dist/hook-bin.js") ||
    command.includes(".deft/core/") ||
    /(^|[\s"`'])deft-hook([\s"`']|$)/.test(command) ||
    command.includes("deft hook:dispatch")
  );
}

function stripHostHooks(cfg: Record<string, unknown>): Record<string, unknown> {
  const hooks = object(cfg.hooks);
  if (hooks === null) return cfg;
  const nextHooks: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(hooks)) {
    if (!Array.isArray(value)) {
      nextHooks[key] = value;
      continue;
    }
    const filtered = value.filter((entry) => {
      const e = object(entry);
      if (e === null) return true;
      if (typeof e.command === "string" && isManagedHookCommand(e.command)) return false;
      if (Array.isArray(e.hooks)) {
        const nestedManaged = e.hooks.some((h) => {
          const hook = object(h);
          return typeof hook?.command === "string" && isManagedHookCommand(hook.command);
        });
        if (nestedManaged) return false;
      }
      return true;
    });
    if (filtered.length > 0) nextHooks[key] = filtered;
  }
  if (Object.keys(nextHooks).length === 0) {
    const { hooks: _h, ...rest } = cfg;
    if ("version" in rest && Object.keys(rest).length === 1) {
      const { version: _v, ...rest2 } = rest;
      return rest2;
    }
    return rest;
  }
  return { ...cfg, hooks: nextHooks };
}

function removeManagedSection(body: string): { next: string; removed: boolean } {
  const start = body.indexOf(MANAGED_SECTION_OPEN_PREFIX);
  if (start < 0) return { next: body, removed: false };
  const openEnd = body.indexOf("-->", start);
  if (openEnd < 0) return { next: body, removed: false };
  const end = body.indexOf(MANAGED_SECTION_CLOSE, openEnd);
  if (end < 0) return { next: body, removed: false };
  const closeEnd = end + MANAGED_SECTION_CLOSE.length;
  let next = body.slice(0, start) + body.slice(closeEnd);
  next = next.replace(/\n{3,}/g, "\n\n");
  if (next.trim().length === 0) next = "";
  return { next, removed: true };
}

function stripTaskfileDeftInclude(body: string): { next: string; removed: boolean } {
  const blockRe = /(^|\n)([ \t]*)deft:\s*(?:#.*)?\n(?:\2[ \t]+[^\n]*\n)*/;
  if (blockRe.test(body)) {
    const next = body.replace(blockRe, "$1");
    return { next: next.replace(/\n{3,}/g, "\n\n"), removed: next !== body };
  }
  return { next: body, removed: false };
}

function safeRemove(root: string, rel: string, removed: string[]): void {
  try {
    const result = containedRemove({
      root,
      target: rel,
      recursive: true,
    });
    if (result.removed) {
      const posix = rel.replace(/\\/g, "/");
      removed.push(posix);
      // F-012 / C4: prune empty ancestors under host skill/command/hook trees.
      removed.push(...pruneEmptyAncestors(root, posix));
    }
  } catch {
    /* best-effort; launcher fallback continues */
  }
}

function ownershipFromDisk(root: string): OwnedArtifact[] {
  const inspection = inspectOwnershipRecord(root);
  return inspection.kind === "valid" ? [...inspection.record.ownership] : [];
}

/**
 * Repository uninstaller entry. Prefer calling this when the runtime can run
 * under a compatible contract; launcher always follows with fallback cleanup.
 */
export function runUninstall(options: { readonly root: string }): UninstallResult {
  const root = options.root;
  const removed: string[] = [];
  const modified: string[] = [];
  const remaining: string[] = [];
  const preserved: string[] = [];

  const ownership = ownershipFromDisk(root);

  // AC11.4: structured hook entries before whole-file targets.
  const ordered = [...ownership].sort((a, b) => {
    const rank = (k: OwnedArtifact["kind"]) =>
      k === "structured-entry" ? 0 : k === "marked-section" ? 1 : k === "whole-file" ? 2 : 3;
    return rank(a.kind) - rank(b.kind);
  });

  for (const art of ordered) {
    if (art.kind === "retained") {
      if (existsSync(join(root, art.path))) preserved.push(art.path);
      continue;
    }

    if (art.kind === "marked-section") {
      const abs = join(root, art.path);
      const body = readText(abs);
      if (body === null) continue;
      const { next, removed: did } = removeManagedSection(body);
      if (!did) {
        remaining.push(`${art.path}#marked-section`);
        continue;
      }
      if (next.trim().length === 0) {
        safeRemove(root, art.path, removed);
      } else {
        writeFileSync(abs, next.endsWith("\n") ? next : `${next}\n`);
        modified.push(`${art.path}#marked-section`);
      }
      continue;
    }

    if (art.kind === "structured-entry") {
      if (art.path === "Taskfile.yml" || art.entryKey === "includes.deft") {
        const abs = join(root, art.path);
        const body = readText(abs);
        if (body === null) continue;
        const { next, removed: did } = stripTaskfileDeftInclude(body);
        if (did) {
          writeFileSync(abs, next.endsWith("\n") ? next : `${next}\n`);
          modified.push(`${art.path}#${art.entryKey ?? "includes.deft"}`);
        }
        continue;
      }
      const abs = join(root, art.path);
      const cfg = readJsonObject(abs);
      if (cfg === null) {
        remaining.push(art.path);
        continue;
      }
      const stripped = stripHostHooks(cfg);
      const prior = readText(abs) ?? "";
      const next = `${JSON.stringify(stripped, null, 2)}\n`;
      if (next !== prior) {
        writeFileSync(abs, next);
        modified.push(`${art.path}#${art.entryKey ?? "hooks"}`);
      }
      continue;
    }

    // whole-file — but never delete shared host/Taskfile wholesale if present as such.
    if (
      art.path === "Taskfile.yml" ||
      HOST_HOOK_RELS.includes(art.path as (typeof HOST_HOOK_RELS)[number])
    ) {
      if (art.path === "Taskfile.yml") {
        const body = readText(join(root, art.path));
        if (body !== null) {
          const { next, removed: did } = stripTaskfileDeftInclude(body);
          if (did) {
            writeFileSync(join(root, art.path), next.endsWith("\n") ? next : `${next}\n`);
            modified.push(`${art.path}#includes.deft`);
          }
        }
        continue;
      }
      const abs = join(root, art.path);
      const cfg = readJsonObject(abs);
      if (cfg !== null) {
        const stripped = stripHostHooks(cfg);
        const prior = readText(abs) ?? "";
        const next = `${JSON.stringify(stripped, null, 2)}\n`;
        if (next !== prior) {
          writeFileSync(abs, next);
          modified.push(`${art.path}#hooks`);
        }
      }
      continue;
    }

    safeRemove(root, art.path, removed);
  }

  // Known wholly-owned generated artifacts (may be absent from ownership record).
  for (const host of SKILL_HOST_ROOTS) {
    for (const entry of SKILL_POINTER_INVENTORY) {
      const rel = `${host}/${entry.dir}/SKILL.md`;
      const body = readText(join(root, rel));
      if (body === null) continue;
      if (
        body.includes(RUNTIME_PREFIX) ||
        body.includes("npm i -g @deftai/directive") ||
        body.includes(".deft/core/")
      ) {
        safeRemove(root, rel, removed);
      }
    }
  }
  for (const rel of GITHOOK_RELS) {
    const body = readText(join(root, rel));
    if (body === null) continue;
    if (
      body.includes("_directive-run.sh") ||
      body.includes(RUNTIME_PREFIX) ||
      body.includes("run_directive") ||
      body.includes(".deft/core/")
    ) {
      safeRemove(root, rel, removed);
    }
  }

  // Readiness / generation / legacy core / data-schema.
  const directiveDir = join(root, ".deft", "directive");
  if (existsSync(directiveDir)) {
    try {
      for (const name of readdirSync(directiveDir)) {
        if (
          (name.startsWith("wiring-ready.") && name.endsWith(".json")) ||
          name === "data-schema.json"
        ) {
          safeRemove(root, `.deft/directive/${name}`, removed);
        }
      }
      const left = readdirSync(directiveDir);
      if (left.length === 0) {
        safeRemove(root, ".deft/directive", removed);
      } else {
        remaining.push(...left.map((n) => `.deft/directive/${n}`));
      }
    } catch {
      /* ignore */
    }
  }
  if (existsSync(join(root, ".deft", "core"))) {
    safeRemove(root, ".deft/core", removed);
  }
  if (existsSync(join(root, ".deft", "GENERATION.json"))) {
    safeRemove(root, ".deft/GENERATION.json", removed);
  }

  if (existsSync(join(root, "xbrief")) && !preserved.includes("xbrief")) {
    preserved.push("xbrief");
  }
  if (
    existsSync(join(root, ".deft", "settings.json")) &&
    !preserved.includes(".deft/settings.json")
  ) {
    preserved.push(".deft/settings.json");
  }

  // AGENTS managed section via known map if ownership missed it.
  const agentsBody = readText(join(root, "AGENTS.md"));
  if (agentsBody !== null && agentsBody.includes(MANAGED_SECTION_OPEN_PREFIX)) {
    const { next, removed: did } = removeManagedSection(agentsBody);
    if (did) {
      if (next.trim().length === 0) safeRemove(root, "AGENTS.md", removed);
      else {
        writeFileSync(join(root, "AGENTS.md"), next.endsWith("\n") ? next : `${next}\n`);
        modified.push("AGENTS.md#marked-section");
      }
    } else {
      remaining.push("AGENTS.md#marked-section");
    }
  }

  // Host hooks / Taskfile via known map.
  for (const rel of HOST_HOOK_RELS) {
    const abs = join(root, rel);
    if (!existsSync(abs)) continue;
    if (modified.some((m) => m.startsWith(`${rel}#`))) continue;
    const cfg = readJsonObject(abs);
    if (cfg === null) continue;
    const stripped = stripHostHooks(cfg);
    const prior = readText(abs) ?? "";
    const next = `${JSON.stringify(stripped, null, 2)}\n`;
    if (next !== prior) {
      writeFileSync(abs, next);
      modified.push(`${rel}#hooks`);
    }
  }
  const taskBody = readText(join(root, "Taskfile.yml"));
  if (taskBody !== null && !modified.some((m) => m.startsWith("Taskfile.yml#"))) {
    const { next, removed: did } = stripTaskfileDeftInclude(taskBody);
    if (did) {
      writeFileSync(join(root, "Taskfile.yml"), next.endsWith("\n") ? next : `${next}\n`);
      modified.push("Taskfile.yml#includes.deft");
    }
  }

  // F-013 / C5: drop sole-author husks ({} hooks, seed AGENTS, private-only package.json).
  // F-012 prune runs inside husk removals for emptied parents.
  const husks = removeSoleAuthorHusks(root);
  removed.push(...husks);
  // Drop modified markers for files husks deleted entirely.
  const huskSet = new Set(husks);
  const modifiedAfterHusks = modified.filter((m) => {
    const path = m.split("#")[0] ?? m;
    return !huskSet.has(path);
  });

  return {
    contract: 1,
    entry: "uninstall",
    stub: false,
    root,
    removed: [...new Set(removed)],
    modified: [...new Set(modifiedAfterHusks)],
    remaining: [...new Set(remaining)],
    preserved: [...new Set(preserved)],
    message:
      remaining.length > 0
        ? "repository uninstall partial; launcher cleanup should continue"
        : "repository uninstall removed owned integrations",
  };
}
