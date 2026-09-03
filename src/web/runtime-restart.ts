import type {
  RuntimeRestartBusyDto,
  RuntimeRestartRequestDto,
  RuntimeRestartResultDto,
} from "./contracts";

export interface RuntimeRestartReservation {
  commit(): void;
  release(): boolean | void;
}

export interface RuntimeRestartCoordinatorOptions {
  bootId: string;
  activeWorkCount(): number;
  beginSessionShutdown(): void;
  activeAuthFlow(): boolean;
  beginAuthShutdown(): Promise<void>;
  reserveOwnerTransition(): Promise<RuntimeRestartReservation>;
}

type CoordinatorState = "idle" | "reserving" | "terminal";

const restarting = (): RuntimeRestartResultDto => ({ code: "RUNTIME_RESTARTING" });

export class RuntimeRestartCoordinator {
  private state: CoordinatorState = "idle";

  constructor(private readonly options: RuntimeRestartCoordinatorOptions) {}

  async request(request: RuntimeRestartRequestDto): Promise<RuntimeRestartResultDto> {
    if (this.state !== "idle") return restarting();
    this.state = "reserving";

    let reservation: RuntimeRestartReservation | undefined;
    let committed = false;
    let releaseAttempted = false;
    let admissionClosed = false;
    const release = (): boolean => {
      if (!reservation || committed || releaseAttempted) return true;
      releaseAttempted = true;
      try {
        return reservation.release() !== false;
      } catch {
        return false;
      }
    };

    try {
      if (!request.force) {
        const initialBusy = this.sampleBusy();
        if (isBusy(initialBusy)) {
          this.state = "idle";
          return initialBusy;
        }
      }

      try {
        reservation = await this.options.reserveOwnerTransition();
      } catch {
        this.state = "idle";
        return restarting();
      }

      const finalBusy = this.sampleBusy();
      if (!request.force && isBusy(finalBusy)) {
        const released = release();
        this.state = released ? "idle" : "terminal";
        return released ? finalBusy : restarting();
      }

      this.options.beginSessionShutdown();
      admissionClosed = true;
      try {
        const authShutdown = this.options.beginAuthShutdown();
        void authShutdown.catch(() => {});
      } catch {
        // Server cleanup retries the same idempotent auth shutdown owner.
      }

      try {
        reservation.commit();
        committed = true;
      } catch {
        release();
        this.state = "terminal";
        return restarting();
      }

      this.state = "terminal";
      return { accepted: true, bootId: this.options.bootId };
    } catch {
      const released = release();
      this.state = admissionClosed || !released ? "terminal" : "idle";
      return restarting();
    } finally {
      if (reservation && !committed && !releaseAttempted) {
        if (!release()) this.state = "terminal";
      }
    }
  }

  private sampleBusy(): RuntimeRestartBusyDto {
    return {
      code: "RUNTIME_BUSY",
      activeSessions: this.options.activeWorkCount(),
      authFlowActive: this.options.activeAuthFlow(),
    };
  }
}

function isBusy(sample: RuntimeRestartBusyDto): boolean {
  return sample.activeSessions > 0 || sample.authFlowActive;
}
