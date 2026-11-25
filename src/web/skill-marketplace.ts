import { listGlobalSkills, serializeSkillWrite, type SkillResourceOptions } from "./agent-resources";
import { existsSync, lstatSync } from "node:fs";
import { join, resolve } from "node:path";
import { ConfigServiceError, type ConfigFileService } from "./config-files";
import type { SkillResourceDto } from "./contracts";
import type { MarketSkillDto, SkillMarketCatalogDto, SkillMarketDetailDto, SkillMarketInstalledDto, SkillMarketView } from "./skill-marketplace-contracts";
import { assertSkillInstallDiscoverable, publishNewSkill, skillMarketplaceIdentity, type SkillInstallFile } from "./skill-marketplace-install";
import { MARKET_RECEIPT, marketError, parseMarketId, skillInstallDirectory, validMarketRevision, SkillMarketplaceSource, type SkillSourceSnapshot } from "./skill-marketplace-source";

interface CacheEntry<T> { expires: number; value: T }

export interface SkillMarketplaceOptions {
  config: ConfigFileService;
  skillOptions(): SkillResourceOptions;
  fetch(url: string, init: RequestInit): Promise<Response>;
  /** Reuse the daemon's authoritative Skill-change acceptance and event owner. */
  notify(): Promise<unknown>;
}

export class SkillMarketplace {
  private readonly source: SkillMarketplaceSource;
  private readonly catalogs = new Map<string, CacheEntry<MarketSkillDto[]>>();
  private readonly snapshots = new Map<string, CacheEntry<SkillSourceSnapshot>>();
  private readonly explanations = new Map<string, CacheEntry<{ content: string; url: string; summary: string }>>();
  private readonly operations = new Map<AbortController, Promise<unknown>>();
  private readonly installing = new Set<string>();
  private closed = false;

  constructor(private readonly options: SkillMarketplaceOptions) {
    this.source = new SkillMarketplaceSource(options.fetch);
  }

  catalog(query: string, view: string, caller?: AbortSignal): Promise<SkillMarketCatalogDto> {
    if (query.length > 160 || (query.trim().length === 1) || !["all-time", "trending", "hot"].includes(view)) {
      return Promise.reject(new ConfigServiceError(400, "Search requires 2–160 characters and a valid catalog view."));
    }
    return this.run(caller, 30_000, async (signal) => {
      const key = `${view}:${query.trim()}`;
      const cached = this.catalogs.get(key);
      if (cached && cached.expires > Date.now()) return { skills: cached.value };
      const skills = await this.source.catalog(query.trim(), view as SkillMarketView, signal);
      this.cache(this.catalogs, key, skills, 60_000, 12);
      return { skills };
    });
  }

  detail(id: string, caller?: AbortSignal): Promise<SkillMarketDetailDto> {
    return this.run(caller, 90_000, async (signal) => {
      const snapshot = await this.snapshot(id, signal);
      const resources = await listGlobalSkills(this.options.config, this.options.skillOptions());
      return this.detailDto(snapshot, resources);
    });
  }

  description(id: string, caller?: AbortSignal) {
    return this.run(caller, 30_000, async signal => {
      const cached = this.explanations.get(id);
      if (cached && cached.expires > Date.now()) return cached.value;
      const value = await this.source.description(id, signal);
      this.cache(this.explanations, id, value, 300_000, 32);
      return value;
    });
  }

  install(input: unknown, caller?: AbortSignal): Promise<SkillMarketInstalledDto> {
    return this.run(caller, 120_000, async (signal) => {
      if (!input || typeof input !== "object" || Array.isArray(input)) marketError("Invalid install request.", 400);
      const row = input as Record<string, unknown>;
      const { id } = parseMarketId(row.id);
      if (Object.keys(row).some((key) => key !== "id" && key !== "commit") || !validMarketRevision(row.commit)) {
        marketError("Installation requires the previewed source revision.", 400);
      }
      const snapshot = await this.snapshot(id, signal, row.commit);
      if (this.installing.has(snapshot.name)) marketError("This skill is already being installed.", 409, "SKILL_MARKET_CONFLICT");
      this.installing.add(snapshot.name);
      try {
        return await serializeSkillWrite(this.options.config, snapshot.name, async () => {
          signal.throwIfAborted();
          const resources = await listGlobalSkills(this.options.config, this.options.skillOptions());
          const detail = this.detailDto(snapshot, resources);
          if (detail.state === "installed") {
            await this.notifyInstalled();
            await this.verifyInstalled(snapshot);
            return { id, name: snapshot.name };
          }
          if (this.physicalTarget(snapshot) && skillMarketplaceIdentity(this.targetResource(snapshot)) === id) this.notDiscoverable();
          if (detail.state === "conflict") marketError("A skill with this name is already available. Existing files were preserved.", 409, "SKILL_MARKET_CONFLICT");
          const files: SkillInstallFile[] = [];
          let next = 0;
          const downloadAbort = new AbortController();
          const downloadSignal = AbortSignal.any([signal, downloadAbort.signal]);
          const workers = Array.from({ length: Math.min(4, snapshot.files.length) }, async () => {
            try {
              for (;;) {
                const file = snapshot.files[next++];
                if (!file) return;
                downloadSignal.throwIfAborted();
                const bytes = file.path === "SKILL.md" ? snapshot.descriptorBytes : await this.source.file(snapshot, file, downloadSignal);
                files.push({ path: file.path, bytes, executable: file.executable });
              }
            } catch (error) { downloadAbort.abort(error); throw error; }
          });
          const settled = await Promise.allSettled(workers);
          const failed = settled.find((result) => result.status === "rejected");
          if (failed?.status === "rejected") throw failed.reason;
          signal.throwIfAborted();
          // Recheck after network awaits; other editors/installs may have added this identity.
          const latest = await listGlobalSkills(this.options.config, this.options.skillOptions());
          if (latest.some((skill) => skill.name.toLowerCase() === snapshot.name.toLowerCase())) {
            marketError("A skill with this name was added while downloading. Existing files were preserved.", 409, "SKILL_MARKET_CONFLICT");
          }
          signal.throwIfAborted();
          files.push({ path: MARKET_RECEIPT, bytes: Buffer.from(JSON.stringify({ version: 1, id, name: snapshot.name, commit: snapshot.commit })) });
          assertSkillInstallDiscoverable(this.options.config.globalRoot, skillInstallDirectory(snapshot.name), files);
          publishNewSkill(this.options.config.globalRoot, skillInstallDirectory(snapshot.name), files);
          await this.notifyInstalled();
          await this.verifyInstalled(snapshot);
          return { id, name: snapshot.name };
        });
      } finally { this.installing.delete(snapshot.name); }
    });
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const controller of this.operations.keys()) controller.abort();
    await Promise.allSettled([...this.operations.values()]);
    this.catalogs.clear();
    this.snapshots.clear();
    this.explanations.clear();
  }

  private detailDto(snapshot: SkillSourceSnapshot, resources: SkillResourceDto[]): SkillMarketDetailDto {
    const existing = resources.find((skill) => skill.name.toLowerCase() === snapshot.name.toLowerCase());
    const exact = this.exactInstalled(snapshot, resources);
    return {
      id: snapshot.id, name: snapshot.name, description: snapshot.description,
      content: snapshot.content, commit: snapshot.commit, directory: snapshot.directory,
      files: snapshot.files.map((file) => file.path),
      sourceType: snapshot.sourceType,
      sourceUrl: snapshot.sourceUrl,
      state: exact ? "installed" : existing || existsSync(this.targetResource(snapshot).path) ? "conflict" : "available",
    };
  }

  private targetResource(snapshot: SkillSourceSnapshot): SkillResourceDto {
    const path = join(this.options.config.globalRoot, "skills", skillInstallDirectory(snapshot.name));
    return { name: snapshot.name, source: "global", path, skillPath: join(path, "SKILL.md") };
  }

  private exactInstalled(snapshot: SkillSourceSnapshot, resources: SkillResourceDto[]): boolean {
    const target = this.targetResource(snapshot);
    if (!this.physicalTarget(snapshot)) return false;
    return resources.some((skill) => skill.source === "global" && skill.name === snapshot.name
      && resolve(skill.skillPath) === resolve(target.skillPath) && skillMarketplaceIdentity(skill) === snapshot.id);
  }

  private physicalTarget(snapshot: SkillSourceSnapshot): boolean {
    const target = this.targetResource(snapshot);
    try {
      if (lstatSync(join(this.options.config.globalRoot, "skills")).isSymbolicLink()
        || !lstatSync(target.path).isDirectory() || lstatSync(target.path).isSymbolicLink()
        || !lstatSync(target.skillPath).isFile() || lstatSync(target.skillPath).isSymbolicLink()) return false;
    } catch { return false; }
    return true;
  }

  private notDiscoverable(): never {
    return marketError("Skill files are saved, but the installed descriptor is not selected by global discovery. Check ignore files, ancestor SKILL.md and name conflicts, then refresh Settings. Existing files were preserved.", 409, "SKILL_MARKET_NOT_DISCOVERABLE");
  }

  private async verifyInstalled(snapshot: SkillSourceSnapshot): Promise<void> {
    const resources = await listGlobalSkills(this.options.config, this.options.skillOptions()).catch(() => this.notDiscoverable());
    if (!this.exactInstalled(snapshot, resources)) this.notDiscoverable();
  }

  private async notifyInstalled(): Promise<void> {
    try {
      const outcome = await this.options.notify();
      if (outcome && typeof outcome === "object" && "status" in outcome && (outcome.status === "rejected" || outcome.status === "closed")) throw new Error("rejected");
    } catch {
      marketError("Skill files are saved, but configuration could not be accepted. Repair configuration and refresh Settings. Existing files were preserved.", 409, "CONFIG_REJECTED");
    }
  }

  private async snapshot(id: string, signal: AbortSignal, commit?: string): Promise<SkillSourceSnapshot> {
    parseMarketId(id);
    const cached = this.snapshots.get(id);
    if (cached && cached.expires > Date.now() && (!commit || cached.value.commit === commit)) return cached.value;
    const value = await this.source.snapshot(id, signal, commit);
    this.cache(this.snapshots, id, value, 300_000, 8);
    // Website snapshots include verified supporting bytes rather than mutable URLs.
    const retainedBytes = () => [...this.snapshots.values()].reduce((total, entry) => total + entry.value.descriptorBytes.length
      + entry.value.files.reduce((sum, file) => sum + (file.bytes?.length ?? 0), 0), 0);
    while (this.snapshots.size > 1 && retainedBytes() > 32 * 1024 * 1024) this.snapshots.delete(this.snapshots.keys().next().value!);
    return value;
  }

  private cache<T>(map: Map<string, CacheEntry<T>>, key: string, value: T, ttl: number, limit: number): void {
    map.delete(key);
    map.set(key, { expires: Date.now() + ttl, value });
    if (map.size > limit) map.delete(map.keys().next().value!);
  }

  private run<T>(caller: AbortSignal | undefined, timeout: number, operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (this.closed) return Promise.reject(new ConfigServiceError(503, "Skill marketplace is shutting down."));
    if (this.operations.size >= 8) return Promise.reject(new ConfigServiceError(429, "Too many skill marketplace requests. Retry shortly."));
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error("deadline")), timeout);
    const signal = caller ? AbortSignal.any([caller, controller.signal]) : controller.signal;
    const promise = Promise.resolve().then(() => { signal.throwIfAborted(); return operation(signal); }).catch((error: unknown) => {
      if (error instanceof ConfigServiceError) throw error;
      if (signal.aborted) throw new ConfigServiceError(408, "Skill marketplace request cancelled or timed out.");
      throw new ConfigServiceError(502, "Could not complete the skill operation. Check the source and retry.");
    }).finally(() => { clearTimeout(timer); this.operations.delete(controller); });
    this.operations.set(controller, promise);
    return promise;
  }
}
