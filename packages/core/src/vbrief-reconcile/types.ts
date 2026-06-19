export const VBRIEF_RECONCILE_MODULE = "vbrief-reconcile" as const;

export interface ConflictEntry {
  readonly taskId: string;
  readonly title: string;
  readonly dimensions: ReadonlyArray<{
    readonly dimension: string;
    readonly spec?: string;
    readonly roadmap?: string;
    readonly resolution: string;
  }>;
  readonly overridesApplied: readonly string[];
}

export interface ReconciliationReport {
  readonly conflicts: ConflictEntry[];
  readonly orphans: ReadonlyArray<{ readonly task_id: string; readonly title: string }>;
  readonly overridesTriggered: ReadonlyArray<Record<string, string>>;
  readonly overridesUnused: readonly string[];
}

export interface SpecTaskEntry {
  readonly item: Record<string, unknown>;
  readonly specPhase: string;
}

export interface ReconciledItem {
  readonly task_id: string;
  readonly number: string;
  readonly title: string;
  readonly title_source: string;
  readonly description: string;
  readonly description_source: string;
  readonly status: string;
  readonly status_source: string;
  readonly folder: string;
  readonly phase: string;
  readonly phase_description: string;
  readonly tier: string;
  readonly spec_phase: string;
  readonly roadmap_summary: string;
  readonly source_conflict: string;
  readonly source_section: string;
  readonly is_completed: boolean;
  readonly override_applied: boolean;
  readonly synthetic_id: string;
  readonly original_task_id: string;
}

export interface Candidate {
  readonly path: string;
  readonly storyId: string;
  readonly status: string;
  readonly swarm: Record<string, unknown>;
  blocked: string[];
}

export interface ReconcileGraphOutcome {
  promoted: string[];
  deferredWip: string[];
  waiting: Array<{ story_id: string; unresolved: string[] }>;
  cycles: string[];
  errors: Array<{ story_id: string; message: string }>;
  cap: number;
  count: number;
  dryRun: boolean;
  forced: boolean;
}

export interface LabelChange {
  readonly story_id: string;
  readonly repo: string;
  readonly issue_number: number;
  readonly current: string[];
  readonly desired: string[];
  readonly add: string[];
  readonly remove: string[];
}

export interface ReconcileLabelsOutcome {
  changed: LabelChange[];
  unchanged: LabelChange[];
  skipped_no_ref: string[];
  errors: Array<{ story_id: string; message: string }>;
  dry_run: boolean;
}

export interface Child {
  readonly story_id: string;
  readonly title: string;
  readonly kind: string;
  readonly folder: string;
  readonly depends_on: string[];
}

export interface UmbrellaChange {
  readonly story_id: string;
  readonly repo: string;
  readonly issue_number: number;
  readonly action: "created" | "edited" | "unchanged";
  readonly pass_n: number;
  readonly body: string;
}

export interface ReconcileUmbrellasOutcome {
  changed: UmbrellaChange[];
  unchanged: UmbrellaChange[];
  skipped_no_ref: string[];
  errors: Array<{ story_id: string; message: string }>;
  dry_run: boolean;
}

export interface LabelClient {
  fetchLabels(repo: string, issueNumber: number): string[];
  apply(repo: string, issueNumber: number, add: readonly string[], remove: readonly string[]): void;
}

export interface UmbrellaClient {
  fetchComments(
    repo: string,
    issueNumber: number,
  ): ReadonlyArray<{ readonly id: number; readonly body: string }>;
  editComment(repo: string, commentId: number, body: string): void;
  createComment(repo: string, issueNumber: number, body: string): number | null;
}
