import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, normalize, sep } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createConfigurationProjectWatches } from "./configuration-project-watches";

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

interface AcquisitionGate {
  entered: Deferred<void>;
  resume: Deferred<void>;
}

class ControlledLiveConfiguration {
  generation = 1;
  error: string | null = null;
  readonly synchronizationProjectCwds: string[][] = [];
  private readonly revisions = new Map<string, number>();
  private readonly baselines = new Map<string, number>();
  private readonly refs = new Map<string, number>();
  private readonly physicalRegistrations = new Map<number, { cwd: string; closed: boolean }>();
  private readonly acquisitionGates = new Map<string, AcquisitionGate>();
  private readonly acquisitionFailures = new Set<string>();
  private readonly releaseFailures = new Map<string, number>();
  private nextRegistration = 0;
  private synchronizationFailure: unknown;

  gateAcquisition(cwd: string): AcquisitionGate {
    const gate = { entered: deferred<void>(), resume: deferred<void>() };
    this.acquisitionGates.set(cwd, gate);
    return gate;
  }

  failAcquisition(cwd: string): void {
    this.acquisitionFailures.add(cwd);
  }

  failNextReleases(cwd: string, count: number): void {
    this.releaseFailures.set(cwd, count);
  }

  failNextSynchronization(error: unknown): void {
    this.synchronizationFailure = error;
  }

  editProject(cwd: string): void {
    this.revisions.set(cwd, (this.revisions.get(cwd) ?? 0) + 1);
  }

  refCount(cwd: string): number {
    return this.refs.get(cwd) ?? 0;
  }

  physicalCount(cwd: string): number {
    return [...this.physicalRegistrations.values()].filter(
      (registration) => registration.cwd === cwd && !registration.closed,
    ).length;
  }

  async acquireProject(cwd: string) {
    const gate = this.acquisitionGates.get(cwd);
    if (gate) {
      gate.entered.resolve();
      await gate.resume.promise;
      this.acquisitionGates.delete(cwd);
    }
    if (this.acquisitionFailures.delete(cwd)) {
      throw new Error(`/private/${cwd}/acquisition failed`);
    }

    const previousRefs = this.refCount(cwd);
    if (previousRefs === 0) this.baselines.set(cwd, this.revisions.get(cwd) ?? 0);
    this.refs.set(cwd, previousRefs + 1);
    const token = ++this.nextRegistration;
    const physical = { cwd, closed: false };
    this.physicalRegistrations.set(token, physical);
    let logicallyReleased = false;

    return {
      cwd,
      release: async () => {
        if (!logicallyReleased) {
          logicallyReleased = true;
          const nextRefs = this.refCount(cwd) - 1;
          if (nextRefs === 0) {
            this.refs.delete(cwd);
            this.baselines.delete(cwd);
          } else {
            this.refs.set(cwd, nextRefs);
          }
        }
        if (physical.closed) return;
        const failures = this.releaseFailures.get(cwd) ?? 0;
        if (failures > 0) {
          this.releaseFailures.set(cwd, failures - 1);
          throw new Error(`/private/${cwd}/release failed`);
        }
        physical.closed = true;
      },
    };
  }

  async synchronize(options?: { projectCwds?: readonly string[] }): Promise<void> {
    const projectCwds = [...(options?.projectCwds ?? [])];
    this.synchronizationProjectCwds.push(projectCwds);
    if (this.synchronizationFailure !== undefined) {
      const error = this.synchronizationFailure;
      this.synchronizationFailure = undefined;
      throw error;
    }
    let changed = false;
    for (const cwd of projectCwds) {
      const baseline = this.baselines.get(cwd);
      const revision = this.revisions.get(cwd) ?? 0;
      if (baseline !== undefined && baseline !== revision) {
        this.baselines.set(cwd, revision);
        changed = true;
      }
    }
    if (changed) this.generation += 1;
  }
}

const temporaryRoots: string[] = [];

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "easyresearch-project-watches-"));
  temporaryRoots.push(root);
  return root;
}

function directory(root: string, name: string): string {
  const cwd = join(root, name);
  mkdirSync(cwd, { recursive: true });
  return cwd;
}

function createHarness(knownCwds: Iterable<string>) {
  const live = new ControlledLiveConfiguration();
  const known = new Set(knownCwds);
  const watches = createConfigurationProjectWatches({
    live,
    isKnownCwd: async (cwd) => known.has(cwd),
  });
  return { live, watches };
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("configuration project watch replacements", () => {
  it("normalizes, exactly deduplicates, and preserves a symlink cwd spelling", async () => {
    const root = temporaryRoot();
    const physical = directory(root, "physical");
    const alias = join(root, "alias");
    symlinkSync(physical, alias, process.platform === "win32" ? "junction" : "dir");
    const { live, watches } = createHarness([physical, alias]);
    const leaseId = watches.acquireLease();

    await expect(watches.replace(leaseId, {
      revision: 0,
      cwds: [`${physical}${sep}.`, physical, alias],
    })).resolves.toEqual({ applied: true, revision: 0 });

    expect(live.refCount(physical)).toBe(1);
    expect(live.refCount(alias)).toBe(1);
    expect(normalize(alias)).not.toBe(physical);
    await watches.close();
  });

  it("rejects malformed revisions, cwd values, relative paths, files, and unknown directories", async () => {
    const root = temporaryRoot();
    const known = directory(root, "known");
    const unknown = directory(root, "unknown");
    const file = join(root, "paper.txt");
    writeFileSync(file, "paper");
    const { live, watches } = createHarness([known, file]);
    const leaseId = watches.acquireLease();

    for (const request of [
      { revision: -1, cwds: [known] },
      { revision: Number.MAX_SAFE_INTEGER + 1, cwds: [known] },
      { revision: 0.5, cwds: [known] },
      { revision: 0, cwds: "not-an-array" },
      { revision: 0, cwds: [42] },
      { revision: 0, cwds: ["relative/project"] },
      { revision: 0, cwds: [file] },
      { revision: 0, cwds: [unknown] },
    ]) {
      await expect(watches.replace(leaseId, request as never)).rejects.toMatchObject({ status: 400 });
    }

    expect(live.refCount(known)).toBe(0);
    await watches.close();
  });

  it("applies the 32 distinct cwd bound after exact normalization and deduplication", async () => {
    const root = temporaryRoot();
    const cwds = Array.from({ length: 33 }, (_, index) => directory(root, `project-${index}`));
    const [firstCwd, ...remainingCwds] = cwds;
    if (!firstCwd) throw new Error("Expected a project cwd fixture");
    const { live, watches } = createHarness(cwds);
    const leaseId = watches.acquireLease();

    await expect(watches.replace(leaseId, {
      revision: 0,
      cwds: cwds.slice(0, 32),
    })).resolves.toEqual({ applied: true, revision: 0 });
    expect(cwds.slice(0, 32).every((cwd) => live.refCount(cwd) === 1)).toBe(true);

    await expect(watches.replace(leaseId, { revision: 1, cwds })).rejects.toMatchObject({ status: 400 });
    expect(cwds.slice(0, 32).every((cwd) => live.refCount(cwd) === 1)).toBe(true);
    await expect(watches.replace(leaseId, {
      revision: 2,
      cwds: Array.from({ length: 33 }, () => firstCwd),
    })).resolves.toEqual({ applied: true, revision: 2 });

    expect(live.refCount(firstCwd)).toBe(1);
    expect(remainingCwds.every((cwd) => live.refCount(cwd) === 0)).toBe(true);
    await watches.close();
  });

  it("returns 404 for a lease that is unknown or already released", async () => {
    const { watches } = createHarness([]);
    await expect(watches.replace("missing", { revision: 0, cwds: [] })).rejects.toMatchObject({ status: 404 });

    const leaseId = watches.acquireLease();
    await watches.releaseLease(leaseId);
    await expect(watches.replace(leaseId, { revision: 0, cwds: [] })).rejects.toMatchObject({ status: 404 });
    await watches.close();
  });

  it("keeps the latest revision and leaves ownership unchanged for stale replacements", async () => {
    const root = temporaryRoot();
    const first = directory(root, "first");
    const stale = directory(root, "stale");
    const { live, watches } = createHarness([first, stale]);
    const leaseId = watches.acquireLease();

    await watches.replace(leaseId, { revision: 2, cwds: [first] });
    await expect(watches.replace(leaseId, { revision: 1, cwds: [stale] })).resolves.toEqual({
      applied: false,
      revision: 2,
    });

    expect(live.refCount(first)).toBe(1);
    expect(live.refCount(stale)).toBe(0);
    await watches.close();
  });

  it("reserves a newer revision while an older acquisition is delayed", async () => {
    const root = temporaryRoot();
    const original = directory(root, "original");
    const older = directory(root, "older");
    const newer = directory(root, "newer");
    const live = new ControlledLiveConfiguration();
    const known = new Set([original, older, newer]);
    const newerValidated = deferred<void>();
    const watches = createConfigurationProjectWatches({
      live,
      isKnownCwd: async (cwd) => {
        if (cwd === newer) newerValidated.resolve();
        return known.has(cwd);
      },
    });
    const leaseId = watches.acquireLease();
    await watches.replace(leaseId, { revision: 0, cwds: [original] });
    const gate = live.gateAcquisition(older);

    const olderReplacement = watches.replace(leaseId, { revision: 1, cwds: [older] });
    await gate.entered.promise;
    const newerReplacement = watches.replace(leaseId, { revision: 2, cwds: [newer] });
    await newerValidated.promise;
    await Promise.resolve();
    gate.resume.resolve();

    await expect(olderReplacement).resolves.toEqual({ applied: false, revision: 2 });
    await expect(newerReplacement).resolves.toEqual({ applied: true, revision: 2 });
    expect(live.refCount(original)).toBe(0);
    expect(live.refCount(older)).toBe(0);
    expect(live.refCount(newer)).toBe(1);
    await watches.close();
  });

  it("retains the old set until every new acquisition succeeds", async () => {
    const root = temporaryRoot();
    const original = directory(root, "original");
    const first = directory(root, "first");
    const second = directory(root, "second");
    const { live, watches } = createHarness([original, first, second]);
    const leaseId = watches.acquireLease();
    await watches.replace(leaseId, { revision: 0, cwds: [original] });
    const gate = live.gateAcquisition(second);

    const replacing = watches.replace(leaseId, { revision: 1, cwds: [first, second] });
    await gate.entered.promise;
    expect(live.refCount(original)).toBe(1);
    expect(live.refCount(first)).toBe(1);
    gate.resume.resolve();
    await replacing;

    expect(live.refCount(original)).toBe(0);
    expect(live.refCount(first)).toBe(1);
    expect(live.refCount(second)).toBe(1);
    await watches.close();
  });

  it("rolls back partial acquisitions without replacing the old set", async () => {
    const root = temporaryRoot();
    const original = directory(root, "original");
    const acquired = directory(root, "acquired");
    const failed = directory(root, "failed");
    const { live, watches } = createHarness([original, acquired, failed]);
    const leaseId = watches.acquireLease();
    await watches.replace(leaseId, { revision: 0, cwds: [original] });
    live.failAcquisition(failed);

    const error = await watches.replace(leaseId, {
      revision: 1,
      cwds: [acquired, failed],
    }).catch((cause) => cause);

    expect(error).toBeInstanceOf(Error);
    expect(String(error)).not.toContain("/private/");
    expect(live.refCount(original)).toBe(1);
    expect(live.refCount(acquired)).toBe(0);
    expect(live.physicalCount(acquired)).toBe(0);
    await expect(watches.replace(leaseId, { revision: 1, cwds: [original] })).resolves.toEqual({
      applied: false,
      revision: 1,
    });
    await watches.close();
  });

  it("retains failed release ownership for a retryable close", async () => {
    const root = temporaryRoot();
    const original = directory(root, "original");
    const replacement = directory(root, "replacement");
    const { live, watches } = createHarness([original, replacement]);
    const leaseId = watches.acquireLease();
    await watches.replace(leaseId, { revision: 0, cwds: [original] });
    live.failNextReleases(original, 2);

    await expect(watches.replace(leaseId, { revision: 1, cwds: [replacement] })).resolves.toEqual({
      applied: true,
      revision: 1,
    });
    expect(live.refCount(original)).toBe(0);
    expect(live.refCount(replacement)).toBe(1);
    expect(live.physicalCount(original)).toBe(1);

    await expect(watches.close()).rejects.toThrow(/monitoring|watch/i);
    expect(() => watches.acquireLease()).toThrow(/closed|closing/i);
    expect(live.physicalCount(original)).toBe(1);
    await watches.close();
    expect(live.physicalCount(original)).toBe(0);
    expect(live.physicalCount(replacement)).toBe(0);
  });

  it("disconnect waits for an in-flight replacement and releases every registration", async () => {
    const root = temporaryRoot();
    const original = directory(root, "original");
    const replacement = directory(root, "replacement");
    const { live, watches } = createHarness([original, replacement]);
    const leaseId = watches.acquireLease();
    await watches.replace(leaseId, { revision: 0, cwds: [original] });
    const gate = live.gateAcquisition(replacement);
    const replacing = watches.replace(leaseId, { revision: 1, cwds: [replacement] });
    await gate.entered.promise;
    let disconnected = false;
    const disconnecting = watches.releaseLease(leaseId).then(() => {
      disconnected = true;
    });
    await Promise.resolve();
    expect(disconnected).toBe(false);

    gate.resume.resolve();
    await expect(replacing).resolves.toEqual({ applied: false, revision: 1 });
    await disconnecting;
    expect(live.refCount(original)).toBe(0);
    expect(live.refCount(replacement)).toBe(0);
    await expect(watches.replace(leaseId, { revision: 2, cwds: [] })).rejects.toMatchObject({ status: 404 });
    await watches.close();
  });

  it("close stops lease admission and waits for an in-flight replacement", async () => {
    const root = temporaryRoot();
    const project = directory(root, "project");
    const { live, watches } = createHarness([project]);
    const leaseId = watches.acquireLease();
    const gate = live.gateAcquisition(project);
    const replacing = watches.replace(leaseId, { revision: 0, cwds: [project] });
    const acquisitionStarted = await Promise.race([
      gate.entered.promise.then(() => true),
      replacing.then(
        () => false,
        () => false,
      ),
    ]);
    expect(acquisitionStarted).toBe(true);
    let closed = false;
    const closing = watches.close().then(() => {
      closed = true;
    });
    expect(() => watches.acquireLease()).toThrow(/closed|closing/i);
    await Promise.resolve();
    expect(closed).toBe(false);

    gate.resume.resolve();
    await replacing;
    await closing;
    expect(live.refCount(project)).toBe(0);
  });
});

describe("configuration manual refresh", () => {
  it("synchronizes global and home state only for missing or empty project lists", async () => {
    const { live, watches } = createHarness([]);
    live.error = "Configuration validation failed. Retry.";

    await expect(watches.refresh({})).resolves.toEqual({
      generation: 1,
      error: "Configuration validation failed. Retry.",
    });
    await watches.refresh({ projectCwds: [] });

    expect(live.synchronizationProjectCwds).toEqual([[], []]);
    await watches.close();
  });

  it("detects a missed change through an already-owned project baseline", async () => {
    const root = temporaryRoot();
    const project = directory(root, "project");
    const { live, watches } = createHarness([project]);
    const leaseId = watches.acquireLease();
    await watches.replace(leaseId, { revision: 0, cwds: [project] });
    live.editProject(project);

    await expect(watches.refresh({ projectCwds: [project] })).resolves.toEqual({
      generation: 2,
      error: null,
    });

    expect(live.refCount(project)).toBe(1);
    expect(live.synchronizationProjectCwds).toEqual([[project]]);
    await watches.close();
  });

  it("temporarily baselines an unowned project without fabricating a generation", async () => {
    const root = temporaryRoot();
    const project = directory(root, "project");
    const { live, watches } = createHarness([project]);
    live.editProject(project);

    await expect(watches.refresh({ projectCwds: [project, `${project}${sep}.`] })).resolves.toEqual({
      generation: 1,
      error: null,
    });

    expect(live.refCount(project)).toBe(0);
    expect(live.physicalCount(project)).toBe(0);
    expect(live.synchronizationProjectCwds).toEqual([[project]]);
    await watches.close();
  });

  it("rejects invalid project cwd input without synchronizing", async () => {
    const root = temporaryRoot();
    const unknown = directory(root, "unknown");
    const { live, watches } = createHarness([]);

    await expect(watches.refresh({ projectCwds: [unknown] })).rejects.toMatchObject({ status: 400 });
    await expect(watches.refresh({ projectCwds: "bad" } as never)).rejects.toMatchObject({ status: 400 });
    expect(live.synchronizationProjectCwds).toEqual([]);
    await watches.close();
  });

  it("returns a safe result and releases temporary ownership when synchronization fails", async () => {
    const root = temporaryRoot();
    const project = directory(root, "project");
    const { live, watches } = createHarness([project]);
    live.failNextSynchronization(new Error(`/private/${project}/fingerprint failed`));

    const result = await watches.refresh({ projectCwds: [project] });

    expect(result.generation).toBe(1);
    expect(result.error).toMatch(/refresh|monitoring|configuration/i);
    expect(result.error).not.toContain("/private/");
    expect(live.refCount(project)).toBe(0);
    expect(live.physicalCount(project)).toBe(0);
    await watches.close();
  });
});
