import { accessSync, constants, readdirSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { DirectoryEntryDto } from "./contracts";

export interface DirectoryListing {
  path: string;
  entries: DirectoryEntryDto[];
}

/** Typed service error mapping to a 4xx HTTP status in routes. */
export class DirectoryServiceError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/**
 * Server-backed local directory navigation. Only directories are returned,
 * sorted by name. The selected path is canonicalized to its absolute real
 * path; a project root is never inferred from an ancestor.
 */
export class DirectoryService {
  constructor(private readonly homeDir: string = homedir()) {}

  list(path?: string): DirectoryListing {
    const target = path ?? this.homeDir;
    let real: string;
    try {
      real = realpathSync(target);
    } catch (error) {
      throw new DirectoryServiceError(404, `does not exist: ${target}`);
    }
    let stat;
    try {
      stat = statSync(real);
    } catch {
      throw new DirectoryServiceError(404, `does not exist: ${target}`);
    }
    if (!stat.isDirectory()) {
      throw new DirectoryServiceError(400, `not a directory: ${target}`);
    }
    try {
      accessSync(real, constants.R_OK);
    } catch {
      throw new DirectoryServiceError(403, `Directory is not readable: ${target}`);
    }
    let dirents;
    try {
      dirents = readdirSync(real, { withFileTypes: true });
    } catch {
      throw new DirectoryServiceError(403, `Directory is not readable: ${target}`);
    }
    const entries: DirectoryEntryDto[] = dirents
      .filter((d) => d.isDirectory())
      .map((d) => ({ name: d.name, path: join(real, d.name) }))
      .sort((a, b) => a.name.localeCompare(b.name));
    return { path: real, entries };
  }

  requireCwd(path: string): string {
    let stat;
    try {
      stat = statSync(path);
    } catch {
      throw new DirectoryServiceError(404, `does not exist: ${path}`);
    }
    if (!stat.isDirectory()) {
      throw new DirectoryServiceError(400, `not a directory: ${path}`);
    }
    try {
      return realpathSync(path);
    } catch {
      throw new DirectoryServiceError(404, `does not exist: ${path}`);
    }
  }
}
