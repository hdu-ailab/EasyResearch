import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { posix, win32 } from "node:path";
import type { BuildArtifact } from "./build";
import type { DesktopTargetName } from "./build-desktop";

export interface NativeCommand {
  command: string;
  args: string[];
}

export interface DesktopSmokeState {
  origin?: string;
  loaded: boolean;
  stateVisible: boolean;
  agentRunning: boolean;
  hidden: boolean;
  sidecarPid?: number;
  exitStarted: boolean;
  stopped: boolean;
}

export function combineDesktopSmokeFailures(
  primary: Error | undefined,
  cleanupFailures: readonly Error[],
): Error | undefined {
  if (cleanupFailures.length === 0) return primary;
  const failures = primary ? [primary, ...cleanupFailures] : [...cleanupFailures];
  if (failures.length === 1) return failures[0];
  return new AggregateError(failures, "Desktop package smoke and cleanup failed.");
}

export function verifyPackagedSidecar(
  packagedPath: string,
  nativeArtifact: BuildArtifact,
  version: string,
): void {
  if (nativeArtifact.version !== version) {
    throw new Error("Packaged sidecar native manifest version mismatch.");
  }
  const size = statSync(packagedPath).size;
  if (size !== nativeArtifact.size) {
    throw new Error(
      `Packaged sidecar size mismatch: expected ${nativeArtifact.size}, received ${size}.`,
    );
  }
  const sha256 = createHash("sha256").update(readFileSync(packagedPath)).digest("hex");
  if (sha256 !== nativeArtifact.sha256) {
    throw new Error("Packaged sidecar SHA-256 mismatch.");
  }
}

export function verifyDesktopSidecarIdentity(
  desktopArtifact: BuildArtifact,
  nativeArtifact: BuildArtifact,
): void {
  const keys = ["version", "target", "binaryName", "size", "sha256", "builtAt"] as const;
  if (keys.some((key) => desktopArtifact[key] !== nativeArtifact[key])) {
    throw new Error("Desktop manifest sidecar does not match the accepted native manifest.");
  }
}

export function nsisInstallCommand(installer: string, installDir: string): NativeCommand {
  return { command: installer, args: ["/S", `/D=${installDir}`] };
}

export function dmgAttachCommand(dmg: string, mountPoint: string): NativeCommand {
  return {
    command: "/usr/bin/hdiutil",
    args: ["attach", dmg, "-nobrowse", "-readonly", "-mountpoint", mountPoint],
  };
}

export function dmgDetachCommand(mountPoint: string): NativeCommand {
  return {
    command: "/usr/bin/hdiutil",
    args: ["detach", mountPoint, "-force"],
  };
}

export function packagedApplicationPaths(
  target: DesktopTargetName,
  root: string,
): { executable: string; sidecar: string; uninstaller?: string } {
  if (target === "windows-x64") {
    return {
      executable: win32.join(root, "EasyResearch.exe"),
      sidecar: win32.join(root, "resources", "sidecar", "easyresearch.exe"),
      uninstaller: win32.join(root, "Uninstall EasyResearch.exe"),
    };
  }
  return {
    executable: posix.join(root, "EasyResearch.app", "Contents", "MacOS", "EasyResearch"),
    sidecar: posix.join(
      root,
      "EasyResearch.app",
      "Contents",
      "Resources",
      "sidecar",
      "easyresearch",
    ),
  };
}

export function readDesktopSmokeEvents(path: string): Array<Record<string, unknown>> {
  const content = readFileSync(path, "utf8");
  if (!content) return [];
  if (!content.endsWith("\n")) throw new Error("Invalid desktop smoke event: partial JSONL record.");
  return content
    .split(/\r?\n/u)
    .filter(Boolean)
    .map((line) => {
      try {
        const parsed = JSON.parse(line) as unknown;
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
        return parsed as Record<string, unknown>;
      } catch (error) {
        throw new Error("Invalid desktop smoke event JSON.", { cause: error });
      }
    });
}

export function reduceDesktopSmokeEvents(
  events: readonly Record<string, unknown>[],
): DesktopSmokeState {
  const state: DesktopSmokeState = {
    loaded: false,
    stateVisible: false,
    agentRunning: false,
    hidden: false,
    exitStarted: false,
    stopped: false,
  };
  for (const event of events) {
    switch (event.type) {
      case "desktop-smoke.sidecar-ready": {
        if (state.origin !== undefined || typeof event.origin !== "string") {
          throw new Error("Invalid duplicate desktop sidecar readiness milestone.");
        }
        state.origin = validateSmokeOrigin(event.origin);
        break;
      }
      case "desktop-smoke.window-loaded":
        requireMilestone(state.origin !== undefined, "Window loaded before sidecar readiness.");
        state.loaded = true;
        break;
      case "desktop-smoke.state-visible":
        requireMilestone(state.loaded, "Shared state was checked before the window loaded.");
        state.stateVisible = true;
        break;
      case "desktop-smoke.agent-running":
        requireMilestone(state.stateVisible, "Agent started before shared state validation.");
        state.agentRunning = true;
        break;
      case "desktop-smoke.window-hidden":
        requireMilestone(state.agentRunning, "Window hid before an Agent was running.");
        requireMilestone(event.hidden === true, "Desktop close did not hide the window.");
        requireMilestone(
          Number.isSafeInteger(event.sidecarPid) && (event.sidecarPid as number) > 0,
          "Desktop close did not report a valid sidecar process.",
        );
        state.hidden = true;
        state.sidecarPid = event.sidecarPid as number;
        break;
      case "desktop-smoke.exit-started":
        requireMilestone(state.hidden, "Desktop Exit started before close-to-tray validation.");
        state.exitStarted = true;
        break;
      case "desktop-smoke.sidecar-stopped":
        requireMilestone(state.exitStarted, "Sidecar stopped before terminal Exit began.");
        state.stopped = true;
        break;
      default:
        throw new Error(`Invalid desktop smoke event type: ${String(event.type)}`);
    }
  }
  return state;
}

function validateSmokeOrigin(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch (error) {
    throw new Error("Desktop smoke did not receive an exact loopback origin.", { cause: error });
  }
  if (
    url.protocol !== "http:"
    || url.hostname !== "127.0.0.1"
    || !url.port
    || url.pathname !== "/"
    || url.search
    || url.hash
    || url.username
    || url.password
  ) {
    throw new Error("Desktop smoke did not receive an exact loopback origin.");
  }
  return url.origin;
}

function requireMilestone(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
