import type { Model } from "@earendil-works/pi-ai";

export type ModelRequestErrorCode =
  | "MODEL_REQUIRED"
  | "MODEL_UNAVAILABLE"
  | "PROVIDER_AUTH_REQUIRED";

const MESSAGES: Record<ModelRequestErrorCode, string> = {
  MODEL_REQUIRED: "Select an available model before sending a message.",
  MODEL_UNAVAILABLE: "The selected model is currently unavailable.",
  PROVIDER_AUTH_REQUIRED: "Connect the selected model provider before sending a message.",
};

export class ModelRequestError extends Error {
  constructor(readonly code: ModelRequestErrorCode) {
    super(MESSAGES[code]);
    this.name = "ModelRequestError";
  }
}

export interface ModelRequestRuntime {
  getAvailableSnapshot(): readonly { provider: string; id: string }[];
  getProvider(providerId: string): unknown;
  getProviderAuthStatus(providerId: string): { configured: boolean };
}

export function assertModelRequestReady(
  runtime: ModelRequestRuntime,
  model: Model<any> | undefined,
): void {
  if (!model) throw new ModelRequestError("MODEL_REQUIRED");
  if (runtime.getAvailableSnapshot().some(
    (candidate) => candidate.provider === model.provider && candidate.id === model.id,
  )) return;
  if (!runtime.getProvider(model.provider)) throw new ModelRequestError("MODEL_UNAVAILABLE");
  if (!runtime.getProviderAuthStatus(model.provider).configured) {
    throw new ModelRequestError("PROVIDER_AUTH_REQUIRED");
  }
  throw new ModelRequestError("MODEL_UNAVAILABLE");
}
