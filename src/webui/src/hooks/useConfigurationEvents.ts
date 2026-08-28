import { useEffect, useRef, useState } from "react";
import { connectConfigurationEvents, replaceConfigurationProjectWatches } from "../api";

export interface ConfigurationState {
  generation: number;
  availabilityEpoch: number;
  revision: number;
  error: string | null;
  setProjectInterests(owner: string, cwds: readonly string[]): void;
}

const RECONNECTING_ERROR = "Configuration updates disconnected. Reconnecting.";
const PROJECT_MONITORING_ERROR = "Configuration project monitoring failed. Refresh to retry.";
const PROJECT_INTEREST_OWNERS = ["work", "settings", "config"] as const;

type ProjectInterestOwner = (typeof PROJECT_INTEREST_OWNERS)[number];

interface ConnectionToken {
  active: boolean;
}

interface LeaseToken {
  id: string;
  serverRevision: number;
}

interface ProjectInterestCoordinator {
  connection: ConnectionToken | null;
  lease: LeaseToken | null;
  nextRevision: number;
  intentVersion: number;
  owners: Map<ProjectInterestOwner, Set<string>>;
  cwds: string[];
  reportReplacementFailure(): void;
}

function isProjectInterestOwner(owner: string): owner is ProjectInterestOwner {
  return PROJECT_INTEREST_OWNERS.some((candidate) => candidate === owner);
}

function sameStrings(left: ReadonlySet<string>, right: ReadonlySet<string>): boolean {
  if (left.size !== right.size) return false;
  for (const value of left) if (!right.has(value)) return false;
  return true;
}

function projectInterestUnion(owners: ReadonlyMap<ProjectInterestOwner, Set<string>>): string[] {
  const union = new Set<string>();
  for (const owner of PROJECT_INTEREST_OWNERS) {
    for (const cwd of owners.get(owner) ?? []) union.add(cwd);
  }
  return [...union];
}

function sendProjectInterests(coordinator: ProjectInterestCoordinator, attempt = 0): void {
  const connection = coordinator.connection;
  const lease = coordinator.lease;
  if (!connection?.active || !lease || !Number.isSafeInteger(coordinator.nextRevision)) return;

  const revision = coordinator.nextRevision;
  const intentVersion = coordinator.intentVersion;
  coordinator.nextRevision += 1;
  void replaceConfigurationProjectWatches(lease.id, {
    revision,
    cwds: [...coordinator.cwds],
  })
    .then((result) => {
      if (!connection.active || coordinator.connection !== connection || coordinator.lease !== lease) return;
      lease.serverRevision = Math.max(lease.serverRevision, result.revision);
    })
    .catch(() => {
      if (
        !connection.active ||
        coordinator.connection !== connection ||
        coordinator.lease !== lease ||
        coordinator.intentVersion !== intentVersion
      )
        return;
      if (attempt === 0) {
        sendProjectInterests(coordinator, 1);
        return;
      }
      coordinator.reportReplacementFailure();
    });
}

export function useConfigurationEvents(): ConfigurationState {
  const [state, setState] = useState({
    generation: 0,
    availabilityEpoch: 0,
    revision: 0,
    error: null as string | null,
  });
  const coordinatorRef = useRef<ProjectInterestCoordinator>({
    connection: null,
    lease: null,
    nextRevision: 0,
    intentVersion: 0,
    owners: new Map(),
    cwds: [],
    reportReplacementFailure: () => {
      setState((current) => ({ ...current, error: PROJECT_MONITORING_ERROR }));
    },
  });
  const [setProjectInterests] = useState<ConfigurationState["setProjectInterests"]>(
    () => (owner: string, cwds: readonly string[]) => {
      if (!isProjectInterestOwner(owner)) {
        throw new Error(`Unknown configuration project-interest owner: ${owner}`);
      }
      const coordinator = coordinatorRef.current;
      const nextOwnerCwds = new Set(cwds);
      const currentOwnerCwds = coordinator.owners.get(owner) ?? new Set<string>();
      if (sameStrings(currentOwnerCwds, nextOwnerCwds)) return;

      if (nextOwnerCwds.size === 0) coordinator.owners.delete(owner);
      else coordinator.owners.set(owner, nextOwnerCwds);
      const nextCwds = projectInterestUnion(coordinator.owners);
      if (sameStrings(new Set(coordinator.cwds), new Set(nextCwds))) return;
      coordinator.cwds = nextCwds;
      coordinator.intentVersion += 1;
      sendProjectInterests(coordinator);
    },
  );

  useEffect(() => {
    const coordinator = coordinatorRef.current;
    const connection = { active: true };
    coordinator.connection = connection;
    const disconnect = connectConfigurationEvents({
      onEvent: (event) => {
        if (!connection.active || coordinator.connection !== connection) return;
        if (event.projectWatchLeaseId !== undefined && event.projectWatchLeaseId !== coordinator.lease?.id) {
          coordinator.lease = { id: event.projectWatchLeaseId, serverRevision: -1 };
          sendProjectInterests(coordinator);
        }
        setState((current) => {
          const nextGeneration = Math.max(current.generation, event.generation);
          const nextAvailabilityEpoch = Math.max(
            current.availabilityEpoch,
            event.availabilityEpoch ?? current.availabilityEpoch,
          );
          const generationChanged = nextGeneration > current.generation;
          const availabilityChanged = nextAvailabilityEpoch > current.availabilityEpoch;
          if (event.generation < current.generation && (event.availabilityEpoch ?? 0) <= current.availabilityEpoch)
            return current;
          const availabilityOnly = event.type === "config.updated" && event.availabilityChanged === true;
          return {
            generation: nextGeneration,
            availabilityEpoch: nextAvailabilityEpoch,
            revision: current.revision + (generationChanged || availabilityChanged ? 1 : 0),
            error: event.type === "config.error" ? event.message : availabilityOnly ? current.error : null,
          };
        });
      },
      onError: () => {
        if (!connection.active || coordinator.connection !== connection) return;
        setState((current) => ({ ...current, error: RECONNECTING_ERROR }));
      },
    });
    return () => {
      connection.active = false;
      if (coordinator.connection === connection) {
        coordinator.connection = null;
        coordinator.lease = null;
      }
      disconnect();
    };
  }, []);

  return { ...state, setProjectInterests };
}
