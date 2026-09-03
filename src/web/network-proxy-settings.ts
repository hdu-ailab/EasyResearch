import {
  type ConfiguredNetworkProxies,
  type NetworkPolicy,
  type NetworkProxySources,
  type ParsedNetworkProxySettings,
  parseNetworkProxySettings,
} from "../runtime/network-policy";
import { parsePiSettingsJson } from "../runtime/pi-settings-json";
import { ConfigServiceError, type ConfigFileService } from "./config-files";
import type {
  NetworkProxyScopeDto,
  NetworkProxySettingsDto,
  NetworkProxySourcesDto,
  NetworkProxyValuesDto,
} from "./contracts";

type ProxyField = NetworkProxyScopeDto;

interface ValidatedPatch {
  fields: ProxyField[];
  values: Partial<Record<ProxyField, string>>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isProxyField(value: string): value is ProxyField {
  return value === "all" || value === "llm" || value === "search";
}

function validatePatch(value: unknown): ValidatedPatch {
  if (!isRecord(value)) {
    throw new ConfigServiceError(400, "Network proxy settings patch must be an object");
  }
  const rawFields = Object.keys(value);
  if (rawFields.some((field) => !isProxyField(field))) {
    throw new ConfigServiceError(400, "Network proxy settings patch contains an unknown field");
  }
  const fields = rawFields as ProxyField[];
  for (const field of fields) {
    const candidate = value[field];
    if (candidate !== null && typeof candidate !== "string") {
      throw new ConfigServiceError(400, "Network proxy settings values must be strings or null");
    }
  }

  const candidateSettings: Record<string, unknown> = {};
  const candidateNetwork: Record<string, unknown> = {};
  if (fields.includes("all")) candidateSettings.httpProxy = value.all ?? undefined;
  if (fields.includes("llm")) candidateNetwork.llmProxy = value.llm ?? undefined;
  if (fields.includes("search")) candidateNetwork.searchProxy = value.search ?? undefined;
  if (fields.includes("llm") || fields.includes("search")) {
    candidateSettings.easyresearch = { network: candidateNetwork };
  }

  const parsed = parseNetworkProxySettings(candidateSettings);
  if (parsed.errors.length > 0) {
    throw new ConfigServiceError(400, "Network proxy settings contain an invalid URL");
  }
  const values: Partial<Record<ProxyField, string>> = {};
  for (const field of fields) {
    const normalized = parsed.configured[field];
    if (normalized !== undefined) values[field] = normalized;
  }
  return { fields, values };
}

function mutableAncestors(settings: Record<string, unknown>): {
  easyresearch: Record<string, unknown>;
  network: Record<string, unknown>;
  hadEasyResearch: boolean;
} {
  const rawEasyResearch = settings.easyresearch;
  if (rawEasyResearch !== undefined && !isRecord(rawEasyResearch)) {
    throw new ConfigServiceError(409, "easyresearch settings must contain an object", "CONFIG_INVALID");
  }
  const easyresearch = { ...(rawEasyResearch as Record<string, unknown> | undefined) };
  const rawNetwork = easyresearch.network;
  if (rawNetwork !== undefined && !isRecord(rawNetwork)) {
    throw new ConfigServiceError(409, "easyresearch.network must contain an object", "CONFIG_INVALID");
  }
  return {
    easyresearch,
    network: { ...(rawNetwork as Record<string, unknown> | undefined) },
    hadEasyResearch: rawEasyResearch !== undefined,
  };
}

function applyPatch(
  settings: Record<string, unknown>,
  patch: ValidatedPatch,
  ancestors: ReturnType<typeof mutableAncestors>,
): Record<string, unknown> {
  const next = { ...settings };
  if (patch.fields.includes("all")) {
    if (patch.values.all === undefined) delete next.httpProxy;
    else next.httpProxy = patch.values.all;
  }

  for (const [field, settingField] of [
    ["llm", "llmProxy"],
    ["search", "searchProxy"],
  ] as const) {
    if (!patch.fields.includes(field)) continue;
    const normalized = patch.values[field];
    if (normalized === undefined) delete ancestors.network[settingField];
    else ancestors.network[settingField] = normalized;
  }

  if (Object.keys(ancestors.network).length === 0) delete ancestors.easyresearch.network;
  else ancestors.easyresearch.network = ancestors.network;

  const touchesCategory = patch.fields.includes("llm") || patch.fields.includes("search");
  if (ancestors.hadEasyResearch || touchesCategory) {
    if (Object.keys(ancestors.easyresearch).length === 0 && !ancestors.hadEasyResearch) {
      delete next.easyresearch;
    } else {
      next.easyresearch = ancestors.easyresearch;
    }
  }
  return next;
}

function copyConfigured(configured: ConfiguredNetworkProxies): NetworkProxyValuesDto {
  const copy: NetworkProxyValuesDto = {};
  if (configured.all !== undefined) copy.all = configured.all;
  if (configured.llm !== undefined) copy.llm = configured.llm;
  if (configured.search !== undefined) copy.search = configured.search;
  return copy;
}

function copySources(sources: NetworkProxySources): NetworkProxySourcesDto {
  return {
    all: sources.all,
    llm: sources.llm,
    search: sources.search,
  };
}

export class NetworkProxySettingsService {
  constructor(
    private readonly config: ConfigFileService,
    private readonly appliedPolicy: NetworkPolicy,
  ) {}

  async get(): Promise<NetworkProxySettingsDto> {
    let settings: unknown = {};
    try {
      const content = await this.config.read({ scope: "global", path: "settings.json" });
      try {
        settings = parsePiSettingsJson(content);
      } catch {
        settings = undefined;
      }
    } catch (error) {
      if (!(error instanceof ConfigServiceError) || error.status !== 404) throw error;
    }
    return this.dto(parseNetworkProxySettings(settings));
  }

  async patch(value: unknown): Promise<NetworkProxySettingsDto> {
    const patch = validatePatch(value);
    return this.config.mutateGlobalSettings((settings) => {
      const ancestors = mutableAncestors(settings);
      if (patch.fields.length === 0) {
        return {
          settings,
          result: this.dto(parseNetworkProxySettings(settings)),
          write: false,
        };
      }

      const next = applyPatch(settings, patch, ancestors);
      const parsed = parseNetworkProxySettings(next);
      if (parsed.errors.length > 0) {
        throw new ConfigServiceError(409, "Current network proxy settings are invalid", "CONFIG_INVALID");
      }
      return {
        settings: next,
        result: this.dto(parsed),
      };
    }, { notify: false });
  }

  private dto(parsed: ParsedNetworkProxySettings): NetworkProxySettingsDto {
    return {
      configured: copyConfigured(parsed.configured),
      appliedConfigured: copyConfigured(this.appliedPolicy.configured),
      sources: copySources(this.appliedPolicy.sources),
      errors: parsed.errors.map((error) => ({ ...error })),
      restartRequired: parsed.configuredFingerprint !== this.appliedPolicy.configuredFingerprint,
    };
  }
}
