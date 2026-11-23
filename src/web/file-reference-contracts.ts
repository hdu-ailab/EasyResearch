/** A 1-based inclusive line range. Columns in authored references select their line. */
export interface FileLineRange {
  start: number;
  end: number;
}

/** Literal reference paths are resolved for one known exact-cwd root session. */
export interface FileReferenceResolutionDto {
  reference: string;
  paths: string[];
  /** The bounded workspace search could not prove a complete match set. */
  truncated: boolean;
}

export interface FileReferencesResolvedDto {
  references: FileReferenceResolutionDto[];
}
