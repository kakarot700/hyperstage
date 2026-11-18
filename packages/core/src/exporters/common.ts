import { buildSceneMeshes, meshTriangleCount } from "../mesh.js";
import type { MeshOptions, SceneMesh } from "../mesh.js";
import type { ResolvedScene } from "../resolver.js";
import type { SceneAST, Vec3 } from "../schema.js";

export interface ExportStats {
  /** Triangles written. */
  triangles: number;
  /** Vertices written (STL counts 3 per triangle). */
  vertices: number;
  /** Solids exported (geometry nodes with at least one triangle). */
  meshes: number;
  /** Overall extents of the exported geometry in millimetres, in the file's axis order. */
  boundsMm: Vec3;
}

export interface ExportResult {
  bytes: Uint8Array;
  stats: ExportStats;
}

export interface ExportOptions extends MeshOptions {
  /** Export only these geometry node ids (default: every geometry node). */
  nodeIds?: readonly string[];
}

/** Builds the meshes to export, honouring `nodeIds` and dropping empty results. */
export function exportableMeshes(input: SceneAST | ResolvedScene, options: ExportOptions | undefined): SceneMesh[] {
  const wanted = options?.nodeIds === undefined ? null : new Set(options.nodeIds);
  const segments = options?.segments;
  const meshes = buildSceneMeshes(input, segments === undefined ? {} : { segments });
  if (wanted !== null) {
    const known = new Set(meshes.map((m) => m.id));
    const missing = [...wanted].filter((id) => !known.has(id));
    if (missing.length > 0) throw new RangeError(`unknown geometry node id(s): ${missing.join(", ")}`);
  }
  return meshes.filter((m) => (wanted === null || wanted.has(m.id)) && meshTriangleCount(m.world) > 0);
}

export function roundMm(value: number): number {
  const r = Math.round(value * 1000) / 1000;
  return Object.is(r, -0) ? 0 : r;
}
