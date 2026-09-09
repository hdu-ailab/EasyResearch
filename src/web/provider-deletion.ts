import type { ConfigFileService } from "./config-files";
import type { AuthGateway } from "./auth-gateway";
import { parsePiJsonObject } from "./auth-runtime";

export class ProviderDeletionError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = "ProviderDeletionError";
  }
}

export interface ProviderDeletionResult {
  providerId: string;
  configuration: unknown;
  credentialsRemoved: boolean;
  cacheRemoved: boolean;
  warnings: string[];
}

export interface ProviderDeletionService {
  delete(providerId: string): Promise<ProviderDeletionResult>;
}

export function createProviderDeletionService(
  config: ConfigFileService,
  auth: Pick<AuthGateway, "withProviderDeletion">,
): ProviderDeletionService {
  return {
    async delete(providerId) {
      if (!providerId.trim() || providerId.includes("/") || providerId.includes("\\")) {
        throw new ProviderDeletionError(400, "Invalid provider id");
      }
      return auth.withProviderDeletion(providerId, async () => {
        const { configuration } = await config.mutateGlobalProviderFile("models.json", (content) => {
          if (content === undefined) {
            throw new ProviderDeletionError(404, `unknown custom provider: ${providerId}`);
          }
          let root: Record<string, unknown>;
          try {
            root = parsePiJsonObject(content);
          } catch {
            throw new ProviderDeletionError(409, "models.json must be repaired before deleting a provider");
          }
          const providers = isRecord(root.providers) ? { ...root.providers } : undefined;
          if (!providers || !Object.hasOwn(providers, providerId)) {
            throw new ProviderDeletionError(404, `unknown custom provider: ${providerId}`);
          }
          delete providers[providerId];
          return `${JSON.stringify({ ...root, providers }, null, 2)}\n`;
        });

        const warnings: string[] = [];
        const credentialsRemoved = await removeStoredEntry(config, "auth.json", providerId, warnings);
        const cacheRemoved = await removeStoredEntry(config, "models-store.json", providerId, warnings);
        return { providerId, configuration, credentialsRemoved, cacheRemoved, warnings };
      });
    },
  };
}

async function removeStoredEntry(
  config: ConfigFileService,
  path: "auth.json" | "models-store.json",
  providerId: string,
  warnings: string[],
): Promise<boolean> {
  try {
    const { changed } = await config.mutateGlobalProviderFile(path, (content) => {
      if (content === undefined) return undefined;
      const root = parsePiJsonObject(content);
      if (!Object.hasOwn(root, providerId)) return undefined;
      delete root[providerId];
      return `${JSON.stringify(root, null, 2)}\n`;
    });
    return changed;
  } catch {
    warnings.push(`${path} could not be cleaned.`);
    return false;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
