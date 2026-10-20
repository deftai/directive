/**
 * Launcher–runtime Contract 1 types (UNIFIED §A5.5 / R4 / AC4.*, #5490).
 */

export type EntryPointName = "setup" | "migrate" | "uninstall" | "doctor";

export type SetupOperation = "install" | "repair" | "upgrade";

/** `--from` for setup: exact prior version, legacy marker, or none. */
export type SetupFrom = string;

export interface SetupArgv {
  readonly entry: "setup";
  readonly operation: SetupOperation;
  readonly from: SetupFrom;
  readonly root: string;
}

export interface MigrateArgv {
  readonly entry: "migrate";
  readonly from: string;
  readonly root: string;
}

export interface UninstallArgv {
  readonly entry: "uninstall";
  readonly root: string;
}

export interface DoctorArgv {
  readonly entry: "doctor";
  readonly root: string;
}

export type ContractArgv = SetupArgv | MigrateArgv | UninstallArgv | DoctorArgv;

/** Equal-version data-status discriminants (AC4.10). */
export type DataStatusValue = "current" | "migration_needed" | "diagnosis_failed";

export interface DataStatusJson {
  readonly contract: number;
  readonly dataStatus: DataStatusValue;
}

export interface RuntimePackageContractMeta {
  readonly version: string;
  readonly contract: number;
}

export interface EntryPointSpec {
  readonly name: EntryPointName;
  /** Canonical argv prefix: first token is the entry name. */
  readonly argv: readonly string[];
}
