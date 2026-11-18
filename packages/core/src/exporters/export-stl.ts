/** Binary STL exporter for slicers (Bambu Studio, PrusaSlicer, Cura). */
import { mergeMeshes, meshTriangleCount } from "../mesh.js";
import type { ResolvedScene } from "../resolver.js";
import type { SceneAST, Vec3 } from "../schema.js";
import { exportableMeshes, roundMm } from "./common.js";
import type { ExportOptions, ExportResult } from "./common.js";

export interface StlExportOptions extends ExportOptions {
  /** Multiplier from scene metres to file units (default 1000: millimetres, what slicers assume). */
  unitScale?: number;
  /** Convert HyperStage +Y-up to the slicer convention +Z-up (default true). */
  zUp?: boolean;
}

export const STL_HEADER_BYTES = 80;
export const STL_TRIANGLE_BYTES = 50;

/**
 * Writes all solids (world space, closed manifold meshes) to one binary STL:
 * 80-byte header, uint32 triangle count, then 50 bytes per triangle (normal, 3 vertices, uint16 0).
 */
export function exportStl(input: SceneAST | ResolvedScene, options?: StlExportOptions): ExportResult {
  const meshes = exportableMeshes(input, options);
  const unitScale = options?.unitScale ?? 1000;
  if (!(unitScale > 0) || !Number.isFinite(unitScale)) throw new RangeError("unitScale must be a positive finite number");
  const zUp = options?.zUp ?? true;
  const merged = mergeMeshes(meshes.map((m) => m.world));
  const count = meshTriangleCount(merged);

  const bytes = new Uint8Array(STL_HEADER_BYTES + 4 + STL_TRIANGLE_BYTES * count);
  const view = new DataView(bytes.buffer);
  const header = new TextEncoder().encode("HyperStage binary STL (units: mm, +Z up)".slice(0, STL_HEADER_BYTES));
  bytes.set(header.subarray(0, STL_HEADER_BYTES), 0);
  view.setUint32(STL_HEADER_BYTES, count, true);

  const point = (index: number): Vec3 => {
    const x = (merged.positions[index * 3] ?? 0) * unitScale;
    const y = (merged.positions[index * 3 + 1] ?? 0) * unitScale;
    const z = (merged.positions[index * 3 + 2] ?? 0) * unitScale;
    return zUp ? [x, -z, y] : [x, y, z];
  };

  const min: Vec3 = [Infinity, Infinity, Infinity];
  const max: Vec3 = [-Infinity, -Infinity, -Infinity];
  let offset = STL_HEADER_BYTES + 4;
  for (let t = 0; t < count; t++) {
    const a = point(merged.indices[t * 3] ?? 0);
    const b = point(merged.indices[t * 3 + 1] ?? 0);
    const c = point(merged.indices[t * 3 + 2] ?? 0);
    const ux = b[0] - a[0];
    const uy = b[1] - a[1];
    const uz = b[2] - a[2];
    const vx = c[0] - a[0];
    const vy = c[1] - a[1];
    const vz = c[2] - a[2];
    let nx = uy * vz - uz * vy;
    let ny = uz * vx - ux * vz;
    let nz = ux * vy - uy * vx;
    const len = Math.hypot(nx, ny, nz);
    if (len > 0) {
      nx /= len;
      ny /= len;
      nz /= len;
    }
    view.setFloat32(offset, nx, true);
    view.setFloat32(offset + 4, ny, true);
    view.setFloat32(offset + 8, nz, true);
    offset += 12;
    for (const p of [a, b, c]) {
      for (let k = 0; k < 3; k++) {
        const v = p[k] ?? 0;
        view.setFloat32(offset, v, true);
        offset += 4;
        if (v < (min[k] ?? 0)) min[k] = v;
        if (v > (max[k] ?? 0)) max[k] = v;
      }
    }
    view.setUint16(offset, 0, true);
    offset += 2;
  }

  const toMm = 1000 / unitScale;
  const extent = (k: number): number => (count === 0 ? 0 : roundMm(((max[k] ?? 0) - (min[k] ?? 0)) * toMm));
  return {
    bytes,
    stats: { triangles: count, vertices: count * 3, meshes: meshes.length, boundsMm: [extent(0), extent(1), extent(2)] },
  };
}
