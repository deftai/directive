/* v8 ignore file -- type-only surface */
import type { ReleaseSeams } from "../release/types.js";

export interface PublishConfig {
  readonly version: string;
  readonly repo: string;
  readonly projectRoot: string;
  readonly dryRun: boolean;
}

export interface PublishFlags {
  readonly help: boolean;
  readonly version: string | null;
  readonly repo: string | null;
  readonly projectRoot: string | null;
  readonly dryRun: boolean;
  readonly unknown: readonly string[];
}

export interface NormalisedRelease {
  readonly isDraft: boolean;
  readonly name: string | null | undefined;
  readonly tagName: string | null | undefined;
  readonly url: string | null | undefined;
  readonly id: number | null | undefined;
}

export type ViewReleaseState = "draft" | "published" | "not-found" | "gh-error";

export type ReleasePublishSeams = ReleaseSeams;
