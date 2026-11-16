import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import type { ThreeSources } from "./html-exporter.js";

let cached: ThreeSources | null = null;

/** Reads the minified three.js ES module build plus OrbitControls from node_modules (Node only). */
export function loadThreeSources(): ThreeSources {
  if (cached !== null) return cached;
  const require = createRequire(import.meta.url);
  const buildDir = dirname(require.resolve("three"));
  cached = {
    core: readFileSync(join(buildDir, "three.core.min.js"), "utf8"),
    module: readFileSync(join(buildDir, "three.module.min.js"), "utf8"),
    orbitControls: readFileSync(join(buildDir, "..", "examples", "jsm", "controls", "OrbitControls.js"), "utf8"),
  };
  return cached;
}
