import { existsSync, readFileSync } from "node:fs";
import { VBRIEF_VERSION } from "@deftai/directive-types";
import { resolveProjectDefinitionPath } from "../layout/resolve.js";
import { readDeclaredArtifactVersion } from "../xbrief-migrate/transforms.js";
import type { XbriefDrift, XbriefSchemaDistance } from "./types.js";

export interface ProbeXbriefOptions {
  readonly targetVersion?: string;
  readonly readText?: (path: string) => string | null;
  readonly isFile?: (path: string) => boolean;
  readonly resolveDefinitionPath?: (projectRoot: string) => string;
}

function defaultReadText(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

function parseSchemaParts(version: string): { major: number; minor: number } | null {
  const trimmed = version.trim();
  const parts = trimmed.split(".");
  if (parts.length < 2) {
    return null;
  }
  const major = Number(parts[0]);
  const minor = Number(parts[1]);
  if (!Number.isFinite(major) || !Number.isFinite(minor)) {
    return null;
  }
  return { major, minor };
}

/** Classify declared xBRIEF schema distance vs the installed framework schema. */
export function classifyXbriefSchemaDistance(
  declaredVersion: string | null,
  targetVersion: string,
): XbriefSchemaDistance {
  if (declaredVersion === null) {
    return "behind-major";
  }
  const declared = parseSchemaParts(declaredVersion);
  const target = parseSchemaParts(targetVersion);
  if (declared === null || target === null) {
    return "behind-major";
  }
  if (declared.major < target.major) {
    return "behind-major";
  }
  if (declared.major === target.major) {
    const minorGap = target.minor - declared.minor;
    if (minorGap >= 2) {
      return "behind-major";
    }
    if (minorGap >= 1) {
      return "behind-minor";
    }
  }
  return "current";
}

/** Probe xBRIEF schema staleness from PROJECT-DEFINITION declared version. */
export function probeXbriefStaleness(
  projectRoot: string,
  options: ProbeXbriefOptions = {},
): XbriefDrift {
  const targetVersion = options.targetVersion ?? VBRIEF_VERSION;
  const readText = options.readText ?? defaultReadText;
  const isFile = options.isFile ?? existsSync;
  let definitionPath: string;
  try {
    definitionPath =
      options.resolveDefinitionPath?.(projectRoot) ?? resolveProjectDefinitionPath(projectRoot);
  } catch {
    return {
      declaredVersion: null,
      targetVersion,
      distance: "behind-major",
      stale: true,
    };
  }
  if (!isFile(definitionPath)) {
    return {
      declaredVersion: null,
      targetVersion,
      distance: "behind-major",
      stale: true,
    };
  }
  const text = readText(definitionPath);
  if (text === null) {
    return {
      declaredVersion: null,
      targetVersion,
      distance: "behind-major",
      stale: true,
    };
  }
  let declared: string | null = null;
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      declared = readDeclaredArtifactVersion(parsed as Record<string, unknown>);
    }
  } catch {
    declared = null;
  }
  const distance = classifyXbriefSchemaDistance(declared, targetVersion);
  return {
    declaredVersion: declared,
    targetVersion,
    distance,
    stale: distance !== "current",
  };
}
