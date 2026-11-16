import { fileURLToPath } from "node:url";

const root = (path: string): string => fileURLToPath(new URL(path, import.meta.url));

/** Resolve workspace packages to their TypeScript sources so tests never depend on dist/. */
export const workspaceAliases = [
  { find: /^@hyperstage\/core\/jsx-runtime$/, replacement: root("./packages/core/src/jsx-runtime.ts") },
  { find: /^@hyperstage\/core\/jsx-dev-runtime$/, replacement: root("./packages/core/src/jsx-dev-runtime.ts") },
  { find: /^@hyperstage\/core$/, replacement: root("./packages/core/src/index.ts") },
  { find: /^@hyperstage\/spatial-linter$/, replacement: root("./packages/spatial-linter/src/index.ts") },
  { find: /^@hyperstage\/mcp-server\/html-exporter$/, replacement: root("./packages/mcp-server/src/html-exporter.ts") },
  { find: /^@hyperstage\/mcp-server\/three-sources$/, replacement: root("./packages/mcp-server/src/three-sources.ts") },
  { find: /^@hyperstage\/mcp-server$/, replacement: root("./packages/mcp-server/src/tools.ts") },
];
