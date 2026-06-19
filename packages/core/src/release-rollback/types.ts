/* v8 ignore file -- type-only surface */
import type { ReleaseSeams } from "../release/types.js";

export interface RollbackConfig {
  readonly version: string;
  readonly repo: string;
  readonly baseBranch: string;
  readonly projectRoot: string;
  readonly dryRun: boolean;
  readonly allowLowDownloads: number;
  readonly allowDataLoss: boolean;
  readonly forceStrict0: boolean;
  readonly skipSleep?: boolean;
}

export interface RollbackFlags {
  readonly help: boolean;
  readonly version: string | null;
  readonly repo: string | null;
  readonly baseBranch: string;
  readonly projectRoot: string | null;
  readonly dryRun: boolean;
  readonly allowLowDownloads: number;
  readonly allowDataLoss: boolean;
  readonly forceStrict0: boolean;
  readonly unknown: readonly string[];
  readonly parseError: string | null;
}

export interface GhReleasePayload {
  readonly isDraft?: boolean;
  readonly name?: string;
  readonly tagName?: string;
  readonly createdAt?: string;
  readonly publishedAt?: string;
  readonly assets?: ReadonlyArray<{ readonly downloadCount?: unknown }>;
  readonly url?: string;
}

export type RollbackSeams = ReleaseSeams & {
  readonly emit?: (label: string, status: string) => void;
  readonly ghReleaseViewJson?: (
    version: string,
    repo: string,
  ) => [boolean, GhReleasePayload | null, string];
};
