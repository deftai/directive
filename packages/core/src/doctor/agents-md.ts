/** Canonical AGENTS.md classifier lives in platform/agents-md.ts (#4090). */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
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
