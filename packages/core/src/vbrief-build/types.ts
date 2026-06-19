export type JsonObject = Record<string, unknown>;

export class ProjectDefinitionIOError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProjectDefinitionIOError";
  }
}

export interface RoadmapItem {
  readonly number: string;
  readonly title: string;
  readonly phase: string;
  readonly tier: string;
  readonly task_id?: string;
  readonly synthetic_id?: string;
}

export interface CompletedRoadmapItem {
  readonly number: string;
  readonly title: string;
  readonly phase: string;
}
