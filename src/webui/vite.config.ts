import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv } from "vite";
import { workerPlugins } from "./worker-plugins";

export default defineConfig(({ command, mode }) => {
  const root = fileURLToPath(new URL(".", import.meta.url));
  const env = loadEnv(mode, root, "");

  return {
    plugins: [react(), tailwindcss()],
    resolve:
      command === "serve" ? { conditions: ["worker", "module", "browser", "development|production"] } : undefined,
    root,
    base: "/",
    build: {
      outDir: "dist",
      emptyOutDir: true,
    },
    worker: { plugins: workerPlugins },
    optimizeDeps: { exclude: ["rehype-katex", "hast-util-from-html-isomorphic"] },
    server: {
      port: 5173,
      proxy: {
        "/api": env.VITE_API_PROXY_TARGET || "http://127.0.0.1:3000",
      },
    },
  };
});
