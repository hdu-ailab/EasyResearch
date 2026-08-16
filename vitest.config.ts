import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      // Test stub: the generated module's `with { type: "file" }` imports
      // would execute real web bundles in the node test environment.
      "@easyresearch/embedded-assets": fileURLToPath(
        new URL("./src/generated/embedded-assets.test-stub.ts", import.meta.url),
      ),
    },
  },
  test: {
    // @testing-library/react auto-cleanup relies on global afterEach.
    globals: true,
    // Parallel cold-loading the complete pinned Pi module can exceed Vitest's
    // 5s default while Vite transforms the shared dependency graph.
    testTimeout: 10_000,
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
