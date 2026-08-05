import type {
  ActiveSessionDto,
  ConfigEntryDto,
  ConfigScope,
  DirectoryEntryDto,
  SessionSnapshotDto,
  SessionSummaryDto,
  StatusDto,
} from "../../web/contracts";
import type { TrustInspection, AppliedTrustDecision } from "../../web/trust";

export type {
  ActiveSessionDto,
  ConfigEntryDto,
  ConfigScope,
  DirectoryEntryDto,
  SessionSnapshotDto,
  SessionSummaryDto,
  StatusDto,
};

export type { AppliedTrustDecision, TrustInspection };

export interface ConfigFileDto {
  path: string;
  content: string;
}

export interface TrustApplyInput {
  cwd: string;
  optionIndex: number;
}
