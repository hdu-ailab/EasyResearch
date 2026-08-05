import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.{ts,tsx}"],
    // @testing-library/react auto-cleanup relies on global afterEach.
    globals: true,
    setupFiles: ["./vitest.setup.ts"],
  },
});
