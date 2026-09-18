/** Canonical AGENTS.md classifier lives in platform/agents-md.ts (#4090). */
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import {
  CONTENT_PACKAGE_NAME,
  contentPackageRootFromResolvedEntry,
} from "../deposit/resolve-content.js";
import {
  type AgentsMdSeams,
  agentsRefreshPlan,
  hasManagedSectionMarker,
  hasV3ManagedMarker,
} from "../platform/agents-md.js";

export type { AgentsMdSeams };
export { agentsRefreshPlan, hasManagedSectionMarker, hasV3ManagedMarker };

let doctorAgentsTemplateRoot: string | undefined;

/** Bind the engine content tree `runRefreshDeposit` already reconciled (#4706). */
export function setDoctorAgentsTemplateRoot(root: string | undefined): void {
  doctorAgentsTemplateRoot = root;
}

export function peekDoctorAgentsTemplateRoot(): string | undefined {
  return doctorAgentsTemplateRoot;
}

/** CLI peek first; otherwise resolve the installed content package so cmdDoctor matches deft doctor. */
export function resolveDoctorAgentsTemplateRootSync(): string | undefined {
  if (doctorAgentsTemplateRoot !== undefined) return doctorAgentsTemplateRoot;
  try {
    const require = createRequire(import.meta.url);
    const entry = require.resolve(`${CONTENT_PACKAGE_NAME}/package.json`);
    return contentPackageRootFromResolvedEntry(entry);
  } catch {
    return undefined;
  }
}

/**
 * Read `templates/agents-entry.md` from an explicit content tree without
 * walking `contentRoot()` prefer-package (#4706).
 */
export function readAgentsTemplateFromContentTree(contentTreeRoot: string): string | null {
  const candidate = join(contentTreeRoot, "templates", "agents-entry.md");
  try {
    if (!existsSync(candidate)) return null;
    return readFileSync(candidate, "utf8");
  } catch {
    return null;
  }
}

/** Freshness plan against the engine content tree when that template exists. */
export function agentsRefreshPlanWithInstalledTemplate(
  projectRoot: string,
  installedContentRoot: string,
  seams: AgentsMdSeams = {},
): Record<string, unknown> {
  const templateText =
    seams.readTemplate?.() ?? readAgentsTemplateFromContentTree(installedContentRoot);
  if (templateText === null) {
    return agentsRefreshPlan(projectRoot, seams);
  }
  return agentsRefreshPlan(projectRoot, {
    ...seams,
    frameworkRoot: installedContentRoot,
    readTemplate: () => templateText,
  });
}
