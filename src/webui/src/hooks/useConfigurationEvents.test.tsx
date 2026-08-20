import { act, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ConfigurationEvent } from "../../../web/contracts";
import * as api from "../api";
import { useConfigurationEvents } from "./useConfigurationEvents";

vi.mock("../api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api")>();
  return { ...actual, connectConfigurationEvents: vi.fn() };
});

let handlers: { onEvent: (event: ConfigurationEvent) => void; onError: () => void };
let disconnect: () => void;

function Probe() {
  const state = useConfigurationEvents();
  return <output>{JSON.stringify(state)}</output>;
}

beforeEach(() => {
  disconnect = vi.fn();
  vi.mocked(api.connectConfigurationEvents)
    .mockReset()
    .mockImplementation((next) => {
      handlers = next;
      return disconnect;
    });
});

describe("useConfigurationEvents", () => {
  it("owns one connection, keeps generations monotonic, and clears errors on recovery", () => {
    const view = render(<Probe />);
    expect(api.connectConfigurationEvents).toHaveBeenCalledOnce();
    expect(screen.getByText('{"generation":0,"error":null}')).toBeVisible();

    act(() => handlers.onEvent({ type: "config.updated", generation: 2, agentsChanged: true, modelsChanged: false }));
    expect(screen.getByText('{"generation":2,"error":null}')).toBeVisible();

    act(() => handlers.onEvent({ type: "config.error", generation: 2, message: "Invalid Agent configuration" }));
    expect(screen.getByText('{"generation":2,"error":"Invalid Agent configuration"}')).toBeVisible();

    act(() => handlers.onEvent({ type: "config.updated", generation: 1, agentsChanged: true, modelsChanged: true }));
    expect(screen.getByText('{"generation":2,"error":"Invalid Agent configuration"}')).toBeVisible();

    act(() => handlers.onEvent({ type: "config.updated", generation: 3, agentsChanged: false, modelsChanged: true }));
    expect(screen.getByText('{"generation":3,"error":null}')).toBeVisible();
    expect(api.connectConfigurationEvents).toHaveBeenCalledOnce();

    view.unmount();
    expect(disconnect).toHaveBeenCalledOnce();
  });

  it("retains the accepted generation across a transport error and recovers on the same native stream", () => {
    render(<Probe />);
    act(() => handlers.onEvent({ type: "config.updated", generation: 4, agentsChanged: true, modelsChanged: true }));
    act(() => handlers.onError());
    expect(screen.getByText(/"generation":4/)).toBeVisible();
    expect(screen.getByText(/Reconnecting/)).toBeVisible();
    expect(api.connectConfigurationEvents).toHaveBeenCalledOnce();

    act(() => handlers.onEvent({ type: "config.updated", generation: 5, agentsChanged: false, modelsChanged: true }));
    expect(screen.getByText('{"generation":5,"error":null}')).toBeVisible();
  });
});
