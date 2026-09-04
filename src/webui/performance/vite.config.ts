import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { workerPlugins } from "../worker-plugins";

export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  plugins: [react(), tailwindcss()],
  resolve: {
    conditions: ["worker", "module", "browser", "development|production"],
  },
  worker: { plugins: workerPlugins },
  optimizeDeps: { exclude: ["rehype-katex", "hast-util-from-html-isomorphic"] },
  server: {
    host: "127.0.0.1",
    port: 0,
    strictPort: false,
    fs: { allow: [fileURLToPath(new URL("../../..", import.meta.url))] },
  },
});
