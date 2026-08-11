import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // @testing-library/react auto-cleanup relies on global afterEach.
    globals: true,
    setupFiles: ["./vitest.setup.ts"],
    projects: [
      {
        extends: true,
        test: {
          name: "node",
          environment: "node",
          include: ["src/**/*.test.{ts,tsx}"],
          exclude: ["src/webui/**"],
        },
      },
      {
        extends: true,
        test: {
          name: "webui",
          environment: "jsdom",
          include: ["src/webui/**/*.test.{ts,tsx}"],
        },
      },
    ],
  },
});
