import type {
  ActiveSessionDto,
  ConfigEntryDto,
  ConfigScope,
  DirectoryEntryDto,
  SessionSnapshotDto,
  SessionSummaryDto,
  StatusDto,
} from "../../web/contracts";

export type {
  ActiveSessionDto,
  ConfigEntryDto,
  ConfigScope,
  DirectoryEntryDto,
  SessionSnapshotDto,
  SessionSummaryDto,
  StatusDto,
};

export interface ConfigFileDto {
  path: string;
  content: string;
}
