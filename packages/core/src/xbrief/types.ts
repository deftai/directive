/**
 * Shared types for on-demand xBRIEF create/verify (#3057).
 *
 * create/verify write or check shaped SoT artifacts at an explicit path.
 * They are NOT scope lifecycle verbs (scope:promote / activate / complete).
 */

export const XBRIEF_FORMATS = ["json", "md", "both"] as const;
export type XbriefFormat = (typeof XBRIEF_FORMATS)[number];

export const XBRIEF_STYLES = ["scope", "playbook", "mission", "project"] as const;
export type XbriefStyle = (typeof XBRIEF_STYLES)[number];

/** Default size cap for create/verify payloads (bytes). */
export const DEFAULT_XBRIEF_SIZE_CAP_BYTES = 512 * 1024;

export interface XbriefCliResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface XbriefPaths {
  /** Absolute project root used for containment. */
  readonly projectRoot: string;
  /** Absolute stem path (no .xbrief.json / .xbrief.md suffix). */
  readonly stemAbs: string;
  /** Absolute JSON path when format includes json. */
  readonly jsonAbs: string | null;
  /** Absolute MD path when format includes md. */
  readonly mdAbs: string | null;
}

export interface XbriefDocument {
  readonly xBRIEFInfo: {
    readonly version: "0.8";
    readonly description?: string;
    readonly created?: string;
    readonly updated?: string;
    readonly author?: string;
    readonly [key: string]: unknown;
  };
  readonly plan: {
    readonly title: string;
    readonly status: string;
    readonly id?: string;
    readonly narratives?: Record<string, string>;
    readonly items: unknown[];
    readonly metadata?: Record<string, unknown>;
    readonly [key: string]: unknown;
  };
  readonly [key: string]: unknown;
}

export function isXbriefFormat(value: string): value is XbriefFormat {
  return (XBRIEF_FORMATS as readonly string[]).includes(value);
}

export function isXbriefStyle(value: string): value is XbriefStyle {
  return (XBRIEF_STYLES as readonly string[]).includes(value);
}
