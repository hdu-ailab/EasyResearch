import { afterEach, describe, expect, it, vi } from "vitest";
import { disableVersionUpdateCheck, runNativeTui, VERSION_CHECK_ENV } from "./pi-host";

const hoisted = vi.hoisted(() => ({
  originalEnv: "" as string | undefined,
  main: vi.fn(),
  bootstrap: vi.fn(),
  guard: vi.fn(),
  createExtension: vi.fn(() => ({ inner: true })),
}));

vi.mock("./pi-import", () => ({
  importPi: async () => ({ main: hoisted.main }),
}));
vi.mock("../bootstrap/resources", () => ({
  bootstrapBundledResources: () => hoisted.bootstrap(),
}));
vi.mock("./extensions-guard", () => ({
  assertNoUserExtensions: () => hoisted.guard(),
}));
vi.mock("./orchestrator-extension", () => ({
  createOrchestratorExtension: () => hoisted.createExtension(),
}));

afterEach(() => {
  if (hoisted.originalEnv === undefined) delete process.env[VERSION_CHECK_ENV];
  else process.env[VERSION_CHECK_ENV] = hoisted.originalEnv;
  hoisted.originalEnv = undefined;
  vi.clearAllMocks();
});

describe("disableVersionUpdateCheck (ADR-023)", () => {
  it("sets PI_SKIP_VERSION_CHECK=1", () => {
    hoisted.originalEnv = process.env[VERSION_CHECK_ENV];
    delete process.env[VERSION_CHECK_ENV];
    disableVersionUpdateCheck();
    expect(process.env[VERSION_CHECK_ENV]).toBe("1");
  });
});

describe("runNativeTui", () => {
  it("disables the version update check before invoking Pi main", async () => {
    hoisted.originalEnv = process.env[VERSION_CHECK_ENV];
    delete process.env[VERSION_CHECK_ENV];
    await runNativeTui();
    expect(process.env[VERSION_CHECK_ENV]).toBe("1");
    expect(hoisted.main).toHaveBeenCalledTimes(1);
  });

  it("bootstraps resources, guards extensions, and mounts the orchestrator extension", async () => {
    await runNativeTui();
    expect(hoisted.main).toHaveBeenCalledTimes(1);
    expect(hoisted.main).toHaveBeenCalledWith([], {
      extensionFactories: [{ inner: true }],
    });
  });

  it("does not touch PI_OFFLINE", async () => {
    hoisted.originalEnv = process.env.PI_OFFLINE;
    await runNativeTui();
    expect(process.env.PI_OFFLINE).toBeUndefined();
  });
});