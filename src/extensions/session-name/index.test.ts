import { describe, expect, it } from "vitest";
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { createSessionNameExtension } from "./index";

interface FakeExtensionAPI {
  commands: Array<{ name: string; description?: string; handler: (args: string) => void | Promise<void> }>;
  sessionNames: string[];
  setSessionName(name: string): void;
  registerCommand(
    name: string,
    options: { description?: string; handler: (args: string) => void | Promise<void> },
  ): void;
}

function mount(): FakeExtensionAPI {
  const api: FakeExtensionAPI = {
    commands: [],
    sessionNames: [],
    setSessionName(name) {
      this.sessionNames.push(name);
    },
    registerCommand(name, options) {
      this.commands.push({ name, description: options.description, handler: options.handler });
    },
  };
  (createSessionNameExtension() as ExtensionFactory)(api as never);
  return api;
}

describe("session-name extension", () => {
  it("registers the Pi-native `name` command", () => {
    const api = mount();
    expect(api.commands.map((command) => command.name)).toEqual(["name"]);
    expect(api.commands[0]?.description).toContain("/name");
  });

  it("sets the trimmed argument as the session name", async () => {
    const api = mount();
    await api.commands[0]!.handler("  Paper v2  ");
    expect(api.sessionNames).toEqual(["Paper v2"]);
  });

  it("clears the session name with empty or whitespace-only arguments", async () => {
    const api = mount();
    await api.commands[0]!.handler("");
    await api.commands[0]!.handler("   ");
    expect(api.sessionNames).toEqual(["", ""]);
  });
});