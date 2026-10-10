/**
 * Launcher–runtime Contract 1 spine (#5490 / UNIFIED R4 / AC4.1).
 * Doc: ./CONTRACT-v1.md — status YOLO-DRAFT pending operator sign-off.
 */

export {
  CONTRACT_NUMBER,
  CONTRACT_PACKAGE_JSON_KEY,
  DATA_STATUS_VALUES,
  DataStatus,
  ENTRY_POINTS,
  EXIT_CODES,
  LAUNCHER_MAX_SUPPORTED_CONTRACT,
  SETUP_FROM_VALUES,
  SETUP_OPERATIONS,
  type ExitCode,
} from "./constants.js";

export {
  parseDataStatusJson,
  serializeDataStatusJson,
} from "./data-status.js";

export {
  isContractSupportedByLauncher,
  readRuntimeContractFromPackageJson,
} from "./package-meta.js";

export type {
  ContractArgv,
  DataStatusJson,
  DataStatusValue,
  DoctorArgv,
  EntryPointName,
  EntryPointSpec,
  MigrateArgv,
  RuntimePackageContractMeta,
  SetupArgv,
  SetupFrom,
  SetupOperation,
  UninstallArgv,
} from "./types.js";
