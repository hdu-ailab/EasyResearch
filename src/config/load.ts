import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { sanitizeConfig, type LazyResearchConfig } from "./config";
import { getConfigPath } from "./paths";

export function loadConfig(configPath: string = getConfigPath()): LazyResearchConfig {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(configPath, "utf-8"));
  } catch {
    return { ...sanitizeConfig(undefined) };
  }
  return sanitizeConfig(raw);
}

export function saveConfig(config: LazyResearchConfig, configPath: string = getConfigPath()): void {
  mkdirSync(dirname(configPath), { recursive: true });
  writeFileSync(configPath, JSON.stringify(config, null, 2), "utf-8");
}
