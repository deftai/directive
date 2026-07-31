/**
 * Tool-event taxonomy: deterministic explore/commit/verify classifier (#2967).
 *
 * Public surface for swarm/review consumers. Pure — no I/O, no LLM.
 * Taxonomy docs: content/patterns/tool-call-taxonomy.md
 */

export {
  classifyShellCommandForTest,
  classifyToolEvent,
  classifyToolEvents,
} from "./classify.js";
export {
  countToolEventBuckets,
  detectToolEventAnomalies,
  emptyBucketCounts,
  formatToolEventAnomalyLine,
  formatToolEventStatusLine,
  summarizeToolEvents,
} from "./summarize.js";
export {
  type ClassifyToolEventResult,
  TOOL_EVENT_BUCKETS,
  type ToolEventAnomaly,
  type ToolEventAnomalyCode,
  type ToolEventBucket,
  type ToolEventBucketCounts,
  type ToolEventInput,
  type ToolEventSummary,
} from "./types.js";
