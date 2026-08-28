import type { Model } from "@earendil-works/pi-ai";

interface DefaultModelProbeSession {
  readonly model: Model<any> | undefined;
  dispose(): void;
}

export interface PiDefaultModelApi {
  DefaultResourceLoader: new (options: Record<string, unknown>) => {
    reload(options?: { resolveProjectTrust?: () => Promise<boolean> }): Promise<void>;
  };
  SessionManager: {
    inMemory(cwd: string): unknown;
  };
  createAgentSession(options: Record<string, unknown>): Promise<{ session: DefaultModelProbeSession }>;
}

interface DefaultModelRuntime {
  getAvailableSnapshot?(): readonly { provider: string; id: string }[];
}

export async function resolvePiDefaultModel(options: {
  pi: PiDefaultModelApi;
  cwd: string;
  agentDir: string;
  modelRuntime: DefaultModelRuntime;
  settingsManager: object;
}): Promise<Model<any> | undefined> {
  const resourceLoader = new options.pi.DefaultResourceLoader({
    cwd: options.cwd,
    agentDir: options.agentDir,
    settingsManager: options.settingsManager,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
  });
  await resourceLoader.reload({ resolveProjectTrust: async () => true });
  const { session } = await options.pi.createAgentSession({
    cwd: options.cwd,
    agentDir: options.agentDir,
    sessionManager: options.pi.SessionManager.inMemory(options.cwd),
    settingsManager: options.settingsManager,
    modelRuntime: options.modelRuntime,
    resourceLoader,
    noTools: "all",
  });
  try {
    const model = session.model;
    if (!model || (model.provider === "unknown" && model.id === "unknown")) return undefined;
    const available = options.modelRuntime.getAvailableSnapshot?.();
    if (available && !available.some((candidate) =>
      candidate.provider === model.provider && candidate.id === model.id
    )) return undefined;
    return model;
  } finally {
    session.dispose();
  }
}
