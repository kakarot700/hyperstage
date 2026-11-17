import { defineConfig } from "vitest/config";
import { workspaceAliases } from "../../vitest.shared";

export default defineConfig({
  resolve: { alias: workspaceAliases },
  test: { include: ["test/**/*.test.ts"], environment: "node", testTimeout: 60000, hookTimeout: 60000, pool: "forks" },
});
