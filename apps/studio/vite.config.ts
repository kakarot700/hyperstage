import { createRequire } from "node:module";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const require = createRequire(import.meta.url);
const repo = (path: string): string => fileURLToPath(new URL(`../../${path}`, import.meta.url));
const threeBuild = dirname(require.resolve("three"));

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: [
      { find: /^three-root\/(.*)$/, replacement: `${dirname(threeBuild)}/$1` },
      { find: /^@hyperstage\/core$/, replacement: repo("packages/core/src/index.ts") },
      { find: /^@hyperstage\/spatial-linter$/, replacement: repo("packages/spatial-linter/src/index.ts") },
      { find: /^@hyperstage\/mcp-server\/html-exporter$/, replacement: repo("packages/mcp-server/src/html-exporter.ts") },
    ],
  },
  build: {
    target: "es2022",
    sourcemap: false,
    chunkSizeWarningLimit: 6000,
    // Keep Rapier3D's embedded WASM bootstrap intact: Rollup tree-shaking strips its init context.
    rollupOptions: { treeshake: false },
  },
  server: { port: 5173 },
  preview: { port: 4173, strictPort: true },
});
