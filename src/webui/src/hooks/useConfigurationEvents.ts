import { useEffect, useState } from "react";
import { connectConfigurationEvents } from "../api";

export interface ConfigurationState {
  generation: number;
  error: string | null;
}

const RECONNECTING_ERROR = "Configuration updates disconnected. Reconnecting.";

export function useConfigurationEvents(): ConfigurationState {
  const [state, setState] = useState<ConfigurationState>({ generation: 0, error: null });

  useEffect(
    () =>
      connectConfigurationEvents({
        onEvent: (event) => {
          setState((current) => {
            if (event.generation < current.generation) return current;
            return event.type === "config.updated"
              ? { generation: event.generation, error: null }
              : { generation: event.generation, error: event.message };
          });
        },
        onError: () => {
          setState((current) => ({ ...current, error: RECONNECTING_ERROR }));
        },
      }),
    [],
  );

  return state;
}
