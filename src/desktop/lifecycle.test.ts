import { describe, expect, it } from "vitest";
import {
  beginDesktopExit,
  createDesktopLifecycleState,
  handleWindowClose,
} from "./lifecycle";

describe("desktop window lifecycle", () => {
  it("hides an ordinary window close while Agents remain owned", () => {
    const state = createDesktopLifecycleState();
    expect(handleWindowClose(state)).toEqual({ action: "hide", state });
  });

  it("allows the window to close after terminal Exit begins", () => {
    const exiting = beginDesktopExit(createDesktopLifecycleState());
    expect(handleWindowClose(exiting)).toEqual({ action: "close", state: exiting });
  });

  it("makes terminal Exit one-way and idempotent", () => {
    const exiting = beginDesktopExit(createDesktopLifecycleState());
    expect(beginDesktopExit(exiting)).toBe(exiting);
    expect(exiting.exiting).toBe(true);
  });
});
