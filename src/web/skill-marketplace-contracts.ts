export type SkillMarketView = "all-time" | "trending" | "hot";

export interface MarketSkillDto {
  id: string;
  source: string;
  slug: string;
  name: string;
  installs: number;
  description?: string;
  supported: boolean;
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
}

export interface SkillMarketInstallDto {
  id: string;
  commit: string;
}

export interface SkillMarketInstalledDto {
  id: string;
  name: string;
}
