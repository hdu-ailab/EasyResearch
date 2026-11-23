export type SkillMarketView = "all-time" | "trending" | "hot";

export interface MarketSkillDto {
  id: string;
  source: string;
  slug: string;
  name: string;
  installs: number;
  description?: string;
  supported: boolean;
  unsupportedReason?: "source" | "identity";
}

export interface SkillMarketCatalogDto {
  skills: MarketSkillDto[];
}

export interface SkillMarketDetailDto {
  id: string;
  name: string;
  description: string;
  content: string;
  commit: string;
  directory: string;
  files: string[];
  state: "available" | "installed" | "conflict";
  sourceType?: "github" | "well-known";
  sourceUrl?: string;
}

export interface SkillMarketDescriptionDto { content: string; url: string; summary?: string }

export function skillMarketAuthorUrl(source: string): string {
  const parts = source.split("/").map(encodeURIComponent);
  return `https://skills.sh/${parts.length === 1 ? "site/" : ""}${parts.join("/")}`;
}

export function skillMarketPageUrl(source: string, slug: string): string {
  return `${skillMarketAuthorUrl(source)}/${encodeURIComponent(slug)}`;
}

export interface SkillMarketInstallDto {
  id: string;
  commit: string;
}

export interface SkillMarketInstalledDto {
  id: string;
  name: string;
}
