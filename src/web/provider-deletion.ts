import type { ConfigFileService } from "./config-files";
import { ConfigServiceError } from "./config-files";
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

export function createProviderDeletionService(config: ConfigFileService): ProviderDeletionService {
  return {
    async delete(providerId) {
      if (!providerId.trim() || providerId.includes("/") || providerId.includes("\\")) {
        throw new ProviderDeletionError(400, "Invalid provider id");
      }
      let root: Record<string, unknown>;
      try {
        root = parsePiJsonObject(await config.read({ scope: "global", path: "models.json" }));
      } catch (error) {
        if (error instanceof ConfigServiceError && error.status === 404) {
          throw new ProviderDeletionError(404, `unknown custom provider: ${providerId}`);
        }
        throw new ProviderDeletionError(409, "models.json must be repaired before deleting a provider");
      }
      const providers = isRecord(root.providers) ? { ...root.providers } : undefined;
      if (!providers || !Object.hasOwn(providers, providerId)) {
        throw new ProviderDeletionError(404, `unknown custom provider: ${providerId}`);
      }
      delete providers[providerId];
      const next = { ...root, providers };
      const configuration = await config.write({
        scope: "global",
        path: "models.json",
        content: `${JSON.stringify(next, null, 2)}\n`,
      });

      const warnings: string[] = [];
      const credentialsRemoved = await removeStoredEntry(config, "auth.json", providerId, warnings);
      const cacheRemoved = await removeStoredEntry(config, "models-store.json", providerId, warnings);
      return { providerId, configuration, credentialsRemoved, cacheRemoved, warnings };
    },
  };
}

async function removeStoredEntry(
  config: ConfigFileService,
  path: string,
  providerId: string,
  warnings: string[],
): Promise<boolean> {
  let content: string;
  try {
    content = await config.read({ scope: "global", path });
  } catch (error) {
    if (error instanceof ConfigServiceError && error.status === 404) return false;
    warnings.push(`${path} could not be cleaned.`);
    return false;
  }
  let root: Record<string, unknown>;
  try {
    root = parsePiJsonObject(content);
  } catch {
    warnings.push(`${path} could not be cleaned.`);
    return false;
  }
  if (!Object.hasOwn(root, providerId)) return false;
  const next = { ...root };
  delete next[providerId];
  try {
    await config.write({ scope: "global", path, content: `${JSON.stringify(next, null, 2)}\n` });
    return true;
  } catch {
    warnings.push(`${path} could not be cleaned.`);
    return false;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
