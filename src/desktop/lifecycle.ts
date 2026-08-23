export interface DesktopLifecycleState {
  readonly exiting: boolean;
}

export function createDesktopLifecycleState(): DesktopLifecycleState {
  return { exiting: false };
}

export function beginDesktopExit(state: DesktopLifecycleState): DesktopLifecycleState {
  return state.exiting ? state : { exiting: true };
}

export function handleWindowClose(state: DesktopLifecycleState): {
  action: "hide" | "close";
  state: DesktopLifecycleState;
} {
  return { action: state.exiting ? "close" : "hide", state };
}
