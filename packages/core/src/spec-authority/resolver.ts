import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  resolveLifecycleLayout,
  resolveLifecycleRoot,
  resolveProjectDefinitionPath,
} from "../layout/resolve.js";
import { SPEC_RENDER_BANNER } from "../render/constants.js";
import {
  contentHasGeneratedPdSource,
  contentHasGeneratedSpecSource,
  EXPORT_SPEC_PD_BANNER,
  GENERATED_SPEC_PURPOSE,
} from "./constants.js";

export type SpecAuthorityKind = "full-spec" | "greenfield";

export interface ResolvedSpecAuthority {
  readonly kind: SpecAuthorityKind;
  readonly projectRoot: string;
  readonly vbriefDir: string;
  readonly projectDefPath: string;
  readonly specPath: string | null;
  readonly banner: string;
}

export function resolveSpecAuthority(projectRoot: string): ResolvedSpecAuthority | null {
  const root = projectRoot;
  let layout: ReturnType<typeof resolveLifecycleLayout>;
  let vbriefDir: string;
  try {
    layout = resolveLifecycleLayout(root);
    vbriefDir = resolveLifecycleRoot(root);
  } catch {
    return null; // No xbrief/ layout; spec authority unavailable.
  }
  const projectDefPath = resolveProjectDefinitionPath(root);
  if (!existsSync(projectDefPath)) return null;

  const specPath = join(vbriefDir, `specification${layout.artifactSuffix}`);
  const hasSpec = existsSync(specPath);
  const kind: SpecAuthorityKind = hasSpec ? "full-spec" : "greenfield";
  const banner = kind === "full-spec" ? SPEC_RENDER_BANNER : EXPORT_SPEC_PD_BANNER;

  return {
    kind,
    projectRoot: root,
    vbriefDir,
    projectDefPath,
    specPath: hasSpec ? specPath : null,
    banner,
  };
}

export function readSpecMarkdown(projectRoot: string): string {
  const path = join(projectRoot, "SPECIFICATION.md");
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

export function isFullSpecState(projectRoot: string): boolean {
  const authority = resolveSpecAuthority(projectRoot);
  if (authority?.kind !== "full-spec") return false;
  const specMd = readSpecMarkdown(projectRoot);
  return specMd.includes(GENERATED_SPEC_PURPOSE) && contentHasGeneratedSpecSource(specMd);
}

export function isGreenfieldSpecExport(projectRoot: string): boolean {
  const authority = resolveSpecAuthority(projectRoot);
  if (authority?.kind !== "greenfield") return false;
  const specMd = readSpecMarkdown(projectRoot);
  return specMd.includes(GENERATED_SPEC_PURPOSE) && contentHasGeneratedPdSource(specMd);
}

export function isCurrentGeneratedSpecification(projectRoot: string): boolean {
  return isFullSpecState(projectRoot) || isGreenfieldSpecExport(projectRoot);
}
