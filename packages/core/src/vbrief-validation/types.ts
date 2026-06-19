export type JsonObject = Record<string, unknown>;

export type SectionTuple = readonly [title: string, body: string, start: number, end: number];

export interface SpecTask {
  task_id: string;
  title: string;
  status: string;
  body: string;
  depends_on: string[];
  traces: string[];
  acceptance: string[];
  start_line: number;
  end_line: number;
}

export interface MigrationLogEntry {
  source: string;
  section_title: string;
  line_range: string;
  target_key: string;
  target_file: string;
}

export interface BackupRecord {
  source: string;
  backup: string;
  source_sha256: string;
  size_bytes: number;
}

export interface FileModification {
  path: string;
  operation: string;
  pre_hash: string;
  post_hash: string;
  appended_content: string;
}

export interface RenameRecord {
  original: string;
  current: string;
  renamed_by: string;
  renamed_at: string;
}

export interface SafetyManifestData {
  version: string;
  migration_timestamp: string;
  backups: BackupRecord[];
  created_files: string[];
  created_dirs: string[];
  post_migration_stub_hashes: Record<string, string>;
  renames: RenameRecord[];
  file_modifications: FileModification[];
}

export type ValidateAllResult = readonly [errors: string[], warnings: string[]];

export type ValidateAllFn = (vbriefDir: string) => ValidateAllResult;

export interface FinalizeMigrationOptions {
  readonly stderrWriter?: (chunk: string) => void;
  readonly validateAll?: ValidateAllFn;
  readonly isolateInvalid?: typeof import("./validation.js").isolateInvalidOutput;
}

export interface RollbackOptions {
  readonly force?: boolean;
  readonly confirmFn?: (prompt: string) => boolean;
}
