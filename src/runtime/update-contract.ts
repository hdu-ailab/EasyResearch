/** Shared, path-free host control projection. Never contains command inputs or credentials. */
export const LATEST_RELEASE_PAGE = "https://github.com/hdu-ailab/EasyResearch/releases/latest";

export type UpdatePhase =
  | "idle" | "checking" | "current" | "available" | "downloading" | "downloaded"
  | "installing" | "verifying" | "ready" | "activating" | "failed" | "cancelled";

export interface UpdateSnapshot {
  revision: number;
  operationId: string | null;
  owner: "cli" | "desktop";
  phase: UpdatePhase;
  currentVersion: string;
  latestVersion: string | null;
  canDownload: boolean;
  canInstall: boolean;
  canActivate: boolean;
  canCancel: boolean;
  canReveal?: boolean;
  bytesReceived?: number;
  bytesTotal?: number;
  message?: string;
  manualCommand?: string;
  releaseUrl: typeof LATEST_RELEASE_PAGE;
}

export interface UpdateAction {
  action: "check" | "download" | "install" | "activate" | "cancel" | "reveal";
  operationId?: string;
  force?: boolean;
}

export type UpdateActionResult = UpdateSnapshot | {
  code: "RUNTIME_BUSY";
  activeSessions: number;
  authFlowActive: boolean;
};

export interface UpdateController {
  snapshot(): UpdateSnapshot;
  action(request: UpdateAction): Promise<UpdateActionResult>;
  subscribe(listener: (snapshot: UpdateSnapshot) => void): () => void;
  close(): Promise<void>;
}
