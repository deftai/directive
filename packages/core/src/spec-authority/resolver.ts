import { existsSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
  resolveLifecycleLayout,
  resolveLifecycleRoot,
  resolveProjectDefinitionPath,
  resolveSpecArtifactPath,
} from "../layout/resolve.js";
import {
  buildExportSpecPdBanner,
  buildGeneratedArtifactBanner,
  contentHasGeneratedPdSource,
  contentHasGeneratedSpecSource,
  GENERATED_SPEC_PURPOSE,
  generatedSpecSourcePaths,
  LEGACY_GENERATED_SPEC_SOURCE_MARKERS,
} from "./constants.js";

export type SpecAuthorityKind = "full-spec" | "greenfield";

export interface ResolvedSpecAuthority {
  readonly kind: SpecAuthorityKind;
  readonly projectRoot: string;
  readonly vbriefDir: string;
  readonly projectDefPath: string;
  readonly specPath: string | null;
  readonly sourcePath: string;
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
  const sourcePath = hasSpec ? specPath : projectDefPath;
  const banner = hasSpec
    ? buildGeneratedArtifactBanner("task spec:render", "rendered specification", sourcePath)
    : buildExportSpecPdBanner(sourcePath);

  return {
    kind,
    projectRoot: root,
    vbriefDir,
    projectDefPath,
    specPath: hasSpec ? specPath : null,
    sourcePath,
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

function sourcePathFromMarker(projectRoot: string, source: string): string {
  return isAbsolute(source) ? source : resolve(projectRoot, source);
}

function relativePathFromSourceMarker(marker: string): string {
  const prefix = "<!-- Source of truth: ";
  const suffix = " -->";
  return marker.slice(prefix.length, marker.length - suffix.length);
}

function contentHasAbsentLegacyGeneratedSource(projectRoot: string, content: string): boolean {
  for (const marker of LEGACY_GENERATED_SPEC_SOURCE_MARKERS) {
    if (!content.includes(marker)) continue;
    const relative = relativePathFromSourceMarker(marker);
    try {
      if (statSync(sourcePathFromMarker(projectRoot, relative)).isFile()) continue;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      // Permission or IO errors are not absence; keep fail-closed (#4117).
      if (code !== "ENOENT" && code !== "ENOTDIR") continue;
    }
    return true;
  }
  return false;
}

function contentMatchesResolvedSpecSource(
  projectRoot: string,
  content: string,
  resolvedSourcePath: string,
): boolean {
  if (contentHasGeneratedSpecSource(content, resolvedSourcePath)) return true;
  if (contentHasAbsentLegacyGeneratedSource(projectRoot, content)) return true;

  let resolvedSource: unknown;
  try {
    resolvedSource = JSON.parse(readFileSync(resolvedSourcePath, "utf8"));
  } catch {
    return false;
  }

  for (const source of generatedSpecSourcePaths(content)) {
    try {
      const candidate = sourcePathFromMarker(projectRoot, source);
      if (!statSync(candidate).isFile()) continue;
      // Explicit --spec paths remain valid aliases only when they identify the
      // same JSON authority as the layout-resolved specification artifact.
      if (isDeepStrictEqual(JSON.parse(readFileSync(candidate, "utf8")), resolvedSource)) {
        return true;
      }
    } catch {
      // Missing or unreadable explicit source markers are not resolved authority.
    }
  }
  return false;
}

/** True when the markdown source marker resolves to the project's specification authority. */
export function contentHasResolvedSpecSource(projectRoot: string, content: string): boolean {
  let resolvedSourcePath: string;
  try {
    resolvedSourcePath = resolveSpecArtifactPath(projectRoot);
  } catch {
    return false;
  }
  if (!existsSync(resolvedSourcePath)) return false;
  return contentMatchesResolvedSpecSource(projectRoot, content, resolvedSourcePath);
}

export function isFullSpecState(projectRoot: string): boolean {
  const authority = resolveSpecAuthority(projectRoot);
  if (authority?.kind !== "full-spec") return false;
  const specMd = readSpecMarkdown(projectRoot);
  return (
    specMd.includes(GENERATED_SPEC_PURPOSE) &&
    contentMatchesResolvedSpecSource(projectRoot, specMd, authority.sourcePath)
  );
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
