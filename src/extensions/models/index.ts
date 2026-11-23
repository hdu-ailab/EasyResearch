import type { AnyModel, ModelThinkingLevel } from "@earendil-works/pi-ai";
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { Buffer } from "node:buffer";
import { Type, type Static } from "typebox";
import { importPi } from "../../runtime/pi-import";

const MAX_OUTPUT_BYTES = 32_768;
const MAX_NAME_LENGTH = 200;
const parameters = Type.Object({
  query: Type.Optional(Type.String({ maxLength: 200, description: "Case-insensitive text in model names or exact references." })),
  provider: Type.Optional(Type.String({ maxLength: 200, description: "Filter by exact provider ID, ignoring case. Omit to prefer the current root provider while including others." })),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100, description: "Maximum results per page; default 20, maximum 100." })),
  offset: Type.Optional(Type.Integer({ minimum: 0, description: "Number of matching models to skip; use next from the previous result." })),
}, { additionalProperties: false });

export type ModelsInput = Static<typeof parameters>;

/** Only accepted, synchronous catalog access: no refresh, auth lookup or network. */
export interface ModelsCatalog {
  getAvailableSnapshot(): readonly { provider: string; id: string }[];
  getModel(provider: string, modelId: string): AnyModel | undefined;
}

export interface ModelsExtensionOptions {
  /** Read the invoking runtime's accepted catalog at tool execution time. */
  modelRuntime(): ModelsCatalog | undefined;
  /** Prefer the current root model's provider; an explicit provider filter wins. */
  model(): { provider: string } | undefined;
}

export interface DiscoveredModel {
  /** Exact dispatch reference; append #<variant> only for an explicit request. */
  id: string;
  provider: string;
  modelID: string;
  name: string;
  /** Supported Pi thinking levels, not provider-specific reasoning values. */
  variants: ModelThinkingLevel[];
}

export interface ModelsResult {
  models: DiscoveredModel[];
  total: number;
  next: number | null;
}

function searchText(value: string | undefined, field: string): string {
  if (value === undefined) return "";
  if (typeof value !== "string" || value.length > 200) {
    throw new Error(`${field} must be a string of at most 200 characters.`);
  }
  return value.trim().toLowerCase();
}

/** Safe to import early; Pi values are loaded only through the identity bootstrap. */
export async function createModelsTool(options: ModelsExtensionOptions) {
  const { defineTool } = await importPi();
  const { getSupportedThinkingLevels, isModelType } = await import("@earendil-works/pi-ai");
  return defineTool({
    name: "models",
    label: "Models",
    description: "Search available chat models in the accepted runtime catalog. Returns exact provider/model IDs and supported thinking variants; append #variant for subagent.model. Prefer your current root provider unless the user requests another. Only select a subagent model or variant when the user explicitly requests it; never guess an ID. This discovery does not change models or settings.",
    parameters,
    async execute(_toolCallId, input, signal) {
      signal?.throwIfAborted();
      const query = searchText(input.query, "query");
      const provider = searchText(input.provider, "provider");
      const limit = input.limit ?? 20;
      const offset = input.offset ?? 0;
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
        throw new Error("limit must be an integer from 1 to 100.");
      }
      if (!Number.isSafeInteger(offset) || offset < 0) {
        throw new Error("offset must be a nonnegative safe integer.");
      }

      let preferredProvider: string | undefined;
      const matching: DiscoveredModel[] = [];
      try {
        const runtime = options.modelRuntime();
        if (!runtime) throw new Error("Unavailable catalog");
        preferredProvider = provider ? undefined : options.model()?.provider;
        const seen = new Set<string>();
        for (const reference of runtime.getAvailableSnapshot()) {
          if (provider && reference.provider.toLowerCase() !== provider) continue;
          const model = runtime.getModel(reference.provider, reference.id);
          if (!model || !isModelType(model, "chat")
            || model.provider !== reference.provider || model.id !== reference.id) continue;
          const id = `${model.provider}/${model.id}`;
          if (seen.has(id)) continue;
          seen.add(id);
          if (query && !id.toLowerCase().includes(query) && !model.name.toLowerCase().includes(query)) continue;
          matching.push({
            id, provider: model.provider, modelID: model.id,
            name: model.name.slice(0, MAX_NAME_LENGTH),
            variants: getSupportedThinkingLevels(model),
          });
        }
      } catch {
        // Catalog/provider exceptions may contain private endpoints or credentials.
        throw new Error("Model catalog is unavailable.");
      }
      matching.sort((left, right) => {
        const preference = Number(right.provider === preferredProvider) - Number(left.provider === preferredProvider);
        return preference || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
      });

      const result: ModelsResult = { models: [], total: matching.length, next: null };
      for (const model of matching.slice(offset, offset + limit)) {
        const count = offset + result.models.length + 1;
        const candidate: ModelsResult = {
          models: [...result.models, model], total: result.total,
          next: count < result.total ? count : null,
        };
        if (Buffer.byteLength(JSON.stringify(candidate)) > MAX_OUTPUT_BYTES) {
          if (result.models.length === 0) {
            throw new Error("A matching model reference exceeds the discovery output limit.");
          }
          break;
        }
        result.models.push(model);
        result.next = candidate.next;
      }
      return { content: [{ type: "text", text: JSON.stringify(result) }], details: result };
    },
  });
}

export function createModelsExtension(options: ModelsExtensionOptions): ExtensionFactory {
  return async (pi) => {
    pi.registerTool(await createModelsTool(options));
  };
}
