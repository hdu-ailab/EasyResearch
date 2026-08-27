import { randomUUID } from "node:crypto";
import { stat } from "node:fs/promises";
import { isAbsolute, normalize } from "node:path";
import type { ProjectWatchRegistration } from "../runtime/configuration-watchers";
import type { LiveConfiguration } from "../runtime/live-configuration";

const MAX_PROJECT_CWDS = 32;
const SAFE_OPERATION_ERROR = "Configuration project monitoring failed. Refresh and retry.";
const SAFE_REFRESH_ERROR = "Configuration refresh failed. Retry refresh.";
const CLOSED_ERROR = "Configuration project watches are closing or closed.";

export interface ProjectWatchReplacement {
  revision: number;
  cwds: string[];
}

export interface ProjectWatchReplacementResult {
  applied: boolean;
  revision: number;
}

export interface ConfigurationRefreshRequest {
  projectCwds?: string[];
}

export interface ConfigurationRefreshResult {
  generation: number;
  error: string | null;
}

export interface ConfigurationProjectWatches {
  acquireLease(): string;
  replace(
    leaseId: string,
    request: ProjectWatchReplacement,
  ): Promise<ProjectWatchReplacementResult>;
  releaseLease(leaseId: string): Promise<void>;
  refresh(request: ConfigurationRefreshRequest): Promise<ConfigurationRefreshResult>;
  close(): Promise<void>;
}

export class ConfigurationProjectWatchRequestError extends Error {
  constructor(
    readonly status: 400 | 404,
    message: string,
  ) {
    super(message);
    this.name = "ConfigurationProjectWatchRequestError";
  }
}

interface ProjectWatchLease {
  readonly id: string;
  revision: number;
  registrations: Map<string, ProjectWatchRegistration>;
  readonly retainedReleases: Set<ProjectWatchRegistration>;
  tail: Promise<void>;
  readonly pendingReplacements: Set<Promise<unknown>>;
  released: boolean;
  releaseAttempt?: Promise<void>;
}

export function createConfigurationProjectWatches(options: {
  live: Pick<LiveConfiguration, "generation" | "error" | "acquireProject" | "synchronize">;
  isKnownCwd(cwd: string): Promise<boolean>;
}): ConfigurationProjectWatches {
  const leases = new Map<string, ProjectWatchLease>();
  const activeRefreshes = new Set<Promise<unknown>>();
  let closing = false;
  let closed = false;
  let closeAttempt: Promise<void> | undefined;

  const requestError = (status: 400 | 404, message: string): ConfigurationProjectWatchRequestError =>
    new ConfigurationProjectWatchRequestError(status, message);

  const validateCwds = async (value: unknown): Promise<string[]> => {
    if (!Array.isArray(value)) throw requestError(400, "cwds must be an array");
    const cwds: string[] = [];
    const seen = new Set<string>();
    for (const candidate of value) {
      if (typeof candidate !== "string" || candidate.length === 0) {
        throw requestError(400, "Every cwd must be an absolute directory path");
      }
      const cwd = normalize(candidate);
      if (!isAbsolute(cwd)) throw requestError(400, "Every cwd must be an absolute directory path");
      if (seen.has(cwd)) continue;
      seen.add(cwd);
      cwds.push(cwd);
      if (cwds.length > MAX_PROJECT_CWDS) {
        throw requestError(400, `At most ${MAX_PROJECT_CWDS} project cwds are allowed`);
      }
    }

    for (const cwd of cwds) {
      let existingDirectory = false;
      try {
        existingDirectory = (await stat(cwd)).isDirectory();
      } catch {
        existingDirectory = false;
      }
      if (!existingDirectory) throw requestError(400, "Every cwd must be an existing directory");

      let known: boolean;
      try {
        known = await options.isKnownCwd(cwd);
      } catch {
        throw new Error(SAFE_OPERATION_ERROR);
      }
      if (!known) throw requestError(400, "Every cwd must be a known configuration project");
    }
    return cwds;
  };

  const releaseRegistration = async (
    lease: ProjectWatchLease,
    registration: ProjectWatchRegistration,
  ): Promise<boolean> => {
    try {
      await registration.release();
      lease.retainedReleases.delete(registration);
      return true;
    } catch {
      lease.retainedReleases.add(registration);
      return false;
    }
  };

  const releaseRegistrations = async (
    lease: ProjectWatchLease,
    registrations: Iterable<ProjectWatchRegistration>,
  ): Promise<boolean> => {
    let released = true;
    for (const registration of registrations) {
      if (!(await releaseRegistration(lease, registration))) released = false;
    }
    return released;
  };

  const applyReplacement = async (
    lease: ProjectWatchLease,
    revision: number,
    cwds: readonly string[],
  ): Promise<ProjectWatchReplacementResult> => {
    if (lease.released || lease.revision !== revision) {
      return { applied: false, revision: lease.revision };
    }

    const acquired = new Map<string, ProjectWatchRegistration>();
    try {
      for (const cwd of cwds) {
        if (!lease.registrations.has(cwd)) {
          acquired.set(cwd, await options.live.acquireProject(cwd));
        }
      }
    } catch {
      await releaseRegistrations(lease, acquired.values());
      throw new Error(SAFE_OPERATION_ERROR);
    }

    if (lease.released || lease.revision !== revision) {
      await releaseRegistrations(lease, acquired.values());
      return { applied: false, revision: lease.revision };
    }

    const next = new Map<string, ProjectWatchRegistration>();
    for (const cwd of cwds) {
      const registration = lease.registrations.get(cwd) ?? acquired.get(cwd);
      if (registration) next.set(cwd, registration);
    }
    const removed = [...lease.registrations.entries()]
      .filter(([cwd]) => !next.has(cwd))
      .map(([, registration]) => registration);
    lease.registrations = next;
    await releaseRegistrations(lease, removed);
    return { applied: true, revision };
  };

  const replaceForLease = async (
    lease: ProjectWatchLease,
    request: ProjectWatchReplacement,
  ): Promise<ProjectWatchReplacementResult> => {
    if (
      !request ||
      typeof request !== "object" ||
      !Number.isSafeInteger(request.revision) ||
      request.revision < 0
    ) {
      throw requestError(400, "revision must be a non-negative safe integer");
    }
    const cwds = await validateCwds(request.cwds);
    if (request.revision <= lease.revision) {
      return { applied: false, revision: lease.revision };
    }

    // Reserve before acquisition so an older delayed request cannot commit
    // after a newer accepted intent.
    lease.revision = request.revision;
    if (lease.released) return { applied: false, revision: lease.revision };
    const operation = lease.tail.then(() => applyReplacement(lease, request.revision, cwds));
    lease.tail = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  };

  const settleLease = (lease: ProjectWatchLease): Promise<void> => {
    if (lease.releaseAttempt) return lease.releaseAttempt;
    lease.released = true;
    const attempt = (async () => {
      await Promise.allSettled([...lease.pendingReplacements]);
      await lease.tail;
      const registrations = new Set([
        ...lease.registrations.values(),
        ...lease.retainedReleases,
      ]);
      lease.registrations.clear();
      if (!(await releaseRegistrations(lease, registrations))) {
        throw new Error(SAFE_OPERATION_ERROR);
      }
      if (leases.get(lease.id) === lease) leases.delete(lease.id);
    })();
    lease.releaseAttempt = attempt;
    void attempt.finally(() => {
      if (lease.releaseAttempt === attempt) lease.releaseAttempt = undefined;
    }).catch(() => {});
    return attempt;
  };

  const refresh = async (request: ConfigurationRefreshRequest): Promise<ConfigurationRefreshResult> => {
    if (!request || typeof request !== "object" || Array.isArray(request)) {
      throw requestError(400, "Malformed configuration refresh request");
    }
    const projectCwds = await validateCwds(request.projectCwds ?? []);
    const registrations: ProjectWatchRegistration[] = [];
    let failed = false;
    try {
      for (const cwd of projectCwds) registrations.push(await options.live.acquireProject(cwd));
      if (projectCwds.length === 0) await options.live.synchronize();
      else await options.live.synchronize({ projectCwds });
    } catch {
      failed = true;
    } finally {
      const releases = await Promise.allSettled(registrations.map((registration) => registration.release()));
      if (releases.some((result) => result.status === "rejected")) failed = true;
    }
    return {
      generation: options.live.generation,
      error: failed ? (options.live.error ?? SAFE_REFRESH_ERROR) : options.live.error,
    };
  };

  return {
    acquireLease() {
      if (closing || closed) throw new Error(CLOSED_ERROR);
      let id = randomUUID();
      while (leases.has(id)) id = randomUUID();
      leases.set(id, {
        id,
        revision: -1,
        registrations: new Map(),
        retainedReleases: new Set(),
        tail: Promise.resolve(),
        pendingReplacements: new Set(),
        released: false,
      });
      return id;
    },
    replace(leaseId, request) {
      const lease = leases.get(leaseId);
      if (!lease || lease.released || closing || closed) {
        return Promise.reject(requestError(404, "Unknown configuration project watch lease"));
      }
      let operation!: Promise<ProjectWatchReplacementResult>;
      operation = replaceForLease(lease, request).finally(() => {
        lease.pendingReplacements.delete(operation);
      });
      lease.pendingReplacements.add(operation);
      return operation;
    },
    releaseLease(leaseId) {
      const lease = leases.get(leaseId);
      return lease ? settleLease(lease) : Promise.resolve();
    },
    refresh(request) {
      if (closing || closed) {
        return Promise.resolve({
          generation: options.live.generation,
          error: options.live.error ?? SAFE_REFRESH_ERROR,
        });
      }
      let operation!: Promise<ConfigurationRefreshResult>;
      operation = refresh(request).finally(() => {
        activeRefreshes.delete(operation);
      });
      activeRefreshes.add(operation);
      return operation;
    },
    close() {
      if (closed) return Promise.resolve();
      if (closeAttempt) return closeAttempt;
      closing = true;
      for (const lease of leases.values()) lease.released = true;
      const attempt = (async () => {
        await Promise.allSettled([...activeRefreshes]);
        const outcomes = await Promise.allSettled([...leases.values()].map((lease) => settleLease(lease)));
        if (outcomes.some((outcome) => outcome.status === "rejected")) {
          throw new Error(SAFE_OPERATION_ERROR);
        }
        closed = true;
      })();
      closeAttempt = attempt;
      void attempt.finally(() => {
        if (closeAttempt === attempt) closeAttempt = undefined;
      }).catch(() => {});
      return attempt;
    },
  };
}
