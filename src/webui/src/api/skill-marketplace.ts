import type {
  MarketSkillDto,
  SkillMarketCatalogDto,
  SkillMarketDetailDto,
  SkillMarketInstallDto,
  SkillMarketInstalledDto,
  SkillMarketView,
} from "../../../web/skill-marketplace-contracts";
import { routes } from "./routes";
import { requestJson } from "./transport";

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid marketplace response");
  return value as Record<string, unknown>;
}
function text(row: Record<string, unknown>, key: string): string {
  if (typeof row[key] !== "string") throw new Error("Invalid marketplace field");
  return row[key];
}
export function parseMarketCatalog(value: unknown): SkillMarketCatalogDto {
  const row = record(value);
  if (!Array.isArray(row.skills)) throw new Error("Invalid skills");
  return {
    skills: row.skills.map((value): MarketSkillDto => {
      const skill = record(value);
      if (
        !Number.isSafeInteger(skill.installs) ||
        (skill.installs as number) < 0 ||
        typeof skill.supported !== "boolean"
      ) {
        throw new Error("Invalid skill metadata");
      }
      return {
        id: text(skill, "id"),
        source: text(skill, "source"),
        slug: text(skill, "slug"),
        name: text(skill, "name"),
        installs: skill.installs as number,
        supported: skill.supported,
        ...(skill.unsupportedReason === "source" || skill.unsupportedReason === "identity"
          ? { unsupportedReason: skill.unsupportedReason }
          : {}),
        ...(typeof skill.description === "string" ? { description: skill.description } : {}),
      };
    }),
  };
}
export function parseMarketDetail(value: unknown): SkillMarketDetailDto {
  const row = record(value);
  if (
    !Array.isArray(row.files) ||
    row.files.some((file) => typeof file !== "string") ||
    !["available", "installed", "conflict"].includes(String(row.state))
  )
    throw new Error("Invalid skill detail");
  return {
    id: text(row, "id"),
    name: text(row, "name"),
    description: text(row, "description"),
    content: text(row, "content"),
    commit: text(row, "commit"),
    directory: text(row, "directory"),
    files: row.files as string[],
    state: row.state as SkillMarketDetailDto["state"],
    ...(row.sourceType === "github" || row.sourceType === "well-known" ? { sourceType: row.sourceType } : {}),
    ...(typeof row.sourceUrl === "string" && /^https:\/\//.test(row.sourceUrl) ? { sourceUrl: row.sourceUrl } : {}),
  };
}
export function getSkillMarket(query: string, view: SkillMarketView, signal?: AbortSignal) {
  return requestJson(routes.skillMarket(query, view), parseMarketCatalog, { signal });
}
export function getSkillMarketDetail(id: string, signal?: AbortSignal) {
  return requestJson(routes.skillMarketDetail(id), parseMarketDetail, { signal });
}
export function getSkillMarketDescription(id: string, signal?: AbortSignal) {
  return requestJson(
    routes.skillMarketDescription(id),
    (value) => {
      const row = record(value);
      return { content: text(row, "content"), url: text(row, "url") };
    },
    { signal },
  );
}
export function getSkillMarketSummary(id: string, signal?: AbortSignal): Promise<string> {
  return requestJson(routes.skillMarketDescription(id, true), (value) => text(record(value), "summary"), { signal });
}
export function installMarketSkill(input: SkillMarketInstallDto): Promise<SkillMarketInstalledDto> {
  return requestJson(
    routes.skillMarketInstall(),
    (value) => {
      const row = record(value);
      return { id: text(row, "id"), name: text(row, "name") };
    },
    { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input) },
  );
}
