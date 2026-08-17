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
  /** Successful promote messages, including refused-stamp remediation (#3398). */
  promotedNotices?: Array<{ story_id: string; message: string }>;
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
  /** Linked forge issue number when known (#1649). */
  readonly issue_number?: number | null;
}

export type ForgeIssueState = "open" | "closed";

export interface UmbrellaChange {
  readonly story_id: string;
  readonly repo: string;
  readonly issue_number: number;
  readonly action: "created" | "edited" | "unchanged";
  readonly pass_n: number;
  readonly body: string;
  /**
   * Issue-body checkbox reconcile (#1649): `edited` when checkboxes flipped,
   * `unchanged` when already correct, `skipped` when body APIs unavailable.
   */
  readonly checklist_action?: "edited" | "unchanged" | "skipped";
  /**
   * slices.jsonl expected_close_signal close (#3428): `closed` when the
   * umbrella was closed this run, `unchanged` when already closed under
   * all-children-merged, `skipped` when the signal is not a close.
   */
  readonly close_action?: "closed" | "unchanged" | "skipped";
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
  /** Optional: forge open/closed for child issues (#1649). Folder fallback when absent. */
  fetchIssueStates?(
    repo: string,
    issueNumbers: readonly number[],
  ): ReadonlyMap<number, ForgeIssueState>;
  /** Optional: umbrella issue body for checklist reconcile (#1649). */
  fetchIssueBody?(repo: string, issueNumber: number): string;
  /** Optional: write reconciled checklist body (#1649). */
  editIssueBody?(repo: string, issueNumber: number, body: string): void;
  /** Optional: close an umbrella via REST (#3428). */
  closeIssue?(repo: string, issueNumber: number): void;
}
