/** Binary glTF 2.0 (.glb) exporter: pure TypedArray/DataView code, no DOM. */
import { hexToLinearRgb } from "../materials.js";
import type { ResolvedMaterial } from "../materials.js";
import { meshBounds, meshTriangleCount } from "../mesh.js";
import type { ResolvedScene } from "../resolver.js";
import type { SceneAST, Vec3 } from "../schema.js";
import { exportableMeshes, roundMm } from "./common.js";
import type { ExportOptions, ExportResult } from "./common.js";

export const GLB_MAGIC = 0x46546c67;
export const GLB_CHUNK_JSON = 0x4e4f534a;
export const GLB_CHUNK_BIN = 0x004e4942;

const FLOAT = 5126;
const UNSIGNED_INT = 5125;
const ARRAY_BUFFER = 34962;
const ELEMENT_ARRAY_BUFFER = 34963;

export interface GltfAccessor {
  bufferView: number;
  componentType: number;
  count: number;
  type: "SCALAR" | "VEC3";
  min?: number[];
  max?: number[];
}

export interface GltfBufferView {
  buffer: number;
  byteOffset: number;
  byteLength: number;
  target: number;
}

export interface GltfMaterial {
  name: string;
  pbrMetallicRoughness: { baseColorFactor: [number, number, number, number]; metallicFactor: number; roughnessFactor: number };
  emissiveFactor?: [number, number, number];
  alphaMode?: "BLEND";
  extensions?: { KHR_materials_emissive_strength: { emissiveStrength: number } };
}

export interface GltfNode {
  name: string;
  mesh?: number;
  translation: Vec3;
  rotation: [number, number, number, number];
  extras: { hyperstage: { id: string; kind: string } };
}

export interface GltfMesh {
  name: string;
  primitives: { attributes: { POSITION: number; NORMAL: number }; indices: number; material: number; mode: 4 }[];
}

/** The JSON chunk written by exportGlb. */
export interface GltfDocument {
  asset: { version: "2.0"; generator: string };
  extensionsUsed?: string[];
  scene: 0;
  scenes: { name: string; nodes: number[] }[];
  nodes: GltfNode[];
  meshes: GltfMesh[];
  materials: GltfMaterial[];
  accessors: GltfAccessor[];
  bufferViews: GltfBufferView[];
  buffers: { byteLength: number }[];
}

export interface GlbExportResult extends ExportResult {
  /** The glTF JSON document embedded in the GLB. */
  gltf: GltfDocument;
}

function round(value: number, digits = 6): number {
  const f = 10 ** digits;
  const r = Math.round(value * f) / f;
  return Object.is(r, -0) ? 0 : r;
}

function gltfMaterial(m: ResolvedMaterial): GltfMaterial {
  const [r, g, b] = hexToLinearRgb(m.color);
  const out: GltfMaterial = {
    name: m.name,
    pbrMetallicRoughness: {
      baseColorFactor: [round(r), round(g), round(b), round(m.opacity)],
      metallicFactor: round(m.metalness),
      roughnessFactor: round(m.roughness),
    },
  };
  if (m.emissiveIntensity > 0 && m.emissive !== "#000000") {
    const [er, eg, eb] = hexToLinearRgb(m.emissive);
    const k = Math.min(1, m.emissiveIntensity);
    out.emissiveFactor = [round(er * k), round(eg * k), round(eb * k)];
    if (m.emissiveIntensity > 1) {
      out.extensions = { KHR_materials_emissive_strength: { emissiveStrength: round(m.emissiveIntensity) } };
    }
  }
  if (m.transparent) out.alphaMode = "BLEND";
  return out;
}

function pad4(n: number): number {
  return (n + 3) & ~3;
}

/**
 * Exports every geometry node as one glTF mesh + node (local-frame vertices, node TRS from the
 * resolver), with pbrMetallicRoughness materials from resolveMaterial(). Units: metres, +Y up.
 */
export function exportGlb(input: SceneAST | ResolvedScene, options?: ExportOptions): GlbExportResult {
  const sceneName = "geometry" in input ? input.scene.name : input.name;
  const meshes = exportableMeshes(input, options);

  const accessors: GltfAccessor[] = [];
  const bufferViews: GltfBufferView[] = [];
  const materials: GltfMaterial[] = [];
  const materialIndex = new Map<string, number>();
  const gltfMeshes: GltfMesh[] = [];
  const nodes: GltfNode[] = [];
  const binParts: Uint8Array[] = [];
  let byteOffset = 0;
  let triangles = 0;
  let vertices = 0;
  const min: Vec3 = [Infinity, Infinity, Infinity];
  const max: Vec3 = [-Infinity, -Infinity, -Infinity];

  const addView = (data: Float32Array | Uint32Array, target: number): number => {
    const bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    binParts.push(bytes);
    bufferViews.push({ buffer: 0, byteOffset, byteLength: bytes.byteLength, target });
    byteOffset += bytes.byteLength;
    return bufferViews.length - 1;
  };

  for (const m of meshes) {
    const local = meshBounds(m.local);
    const vertexCount = m.local.positions.length / 3;
    const posView = addView(m.local.positions, ARRAY_BUFFER);
    accessors.push({
      bufferView: posView,
      componentType: FLOAT,
      count: vertexCount,
      type: "VEC3",
      min: [Math.fround(local.min[0]), Math.fround(local.min[1]), Math.fround(local.min[2])],
      max: [Math.fround(local.max[0]), Math.fround(local.max[1]), Math.fround(local.max[2])],
    });
    const position = accessors.length - 1;
    accessors.push({ bufferView: addView(m.local.normals, ARRAY_BUFFER), componentType: FLOAT, count: vertexCount, type: "VEC3" });
    const normal = accessors.length - 1;
    accessors.push({
      bufferView: addView(m.local.indices, ELEMENT_ARRAY_BUFFER),
      componentType: UNSIGNED_INT,
      count: m.local.indices.length,
      type: "SCALAR",
    });
    const indices = accessors.length - 1;

    const material = gltfMaterial(m.material);
    const key = JSON.stringify(material);
    let mat = materialIndex.get(key);
    if (mat === undefined) {
      mat = materials.length;
      materials.push(material);
      materialIndex.set(key, mat);
    }
    gltfMeshes.push({ name: m.id, primitives: [{ attributes: { POSITION: position, NORMAL: normal }, indices, material: mat, mode: 4 }] });
    const [qx, qy, qz, qw] = m.quaternion;
    const qn = Math.hypot(qx, qy, qz, qw) || 1;
    nodes.push({
      name: m.id,
      mesh: gltfMeshes.length - 1,
      translation: [m.center[0], m.center[1], m.center[2]],
      rotation: [qx / qn, qy / qn, qz / qn, qw / qn],
      extras: { hyperstage: { id: m.id, kind: m.node.kind } },
    });
    triangles += meshTriangleCount(m.local);
    vertices += vertexCount;
    for (let a = 0; a < 3; a++) {
      min[a] = Math.min(min[a] ?? 0, m.bounds.min[a] ?? 0);
      max[a] = Math.max(max[a] ?? 0, m.bounds.max[a] ?? 0);
    }
  }

  const usesEmissiveStrength = materials.some((m) => m.extensions !== undefined);
  const gltf: GltfDocument = {
    asset: { version: "2.0", generator: "HyperStage" },
    ...(usesEmissiveStrength ? { extensionsUsed: ["KHR_materials_emissive_strength"] } : {}),
    scene: 0,
    scenes: [{ name: sceneName, nodes: nodes.map((_, i) => i) }],
    nodes,
    meshes: gltfMeshes,
    materials,
    accessors,
    bufferViews,
    buffers: byteOffset > 0 ? [{ byteLength: byteOffset }] : [],
  };

  const jsonBytes = new TextEncoder().encode(JSON.stringify(gltf));
  const jsonLength = pad4(jsonBytes.byteLength);
  const binLength = pad4(byteOffset);
  const hasBin = byteOffset > 0;
  const total = 12 + 8 + jsonLength + (hasBin ? 8 + binLength : 0);
  const bytes = new Uint8Array(total);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, GLB_MAGIC, true);
  view.setUint32(4, 2, true);
  view.setUint32(8, total, true);
  view.setUint32(12, jsonLength, true);
  view.setUint32(16, GLB_CHUNK_JSON, true);
  bytes.set(jsonBytes, 20);
  bytes.fill(0x20, 20 + jsonBytes.byteLength, 20 + jsonLength);
  if (hasBin) {
    const binStart = 20 + jsonLength;
    view.setUint32(binStart, binLength, true);
    view.setUint32(binStart + 4, GLB_CHUNK_BIN, true);
    let offset = binStart + 8;
    for (const part of binParts) {
      bytes.set(part, offset);
      offset += part.byteLength;
    }
  }

  const extent = (a: number): number => (meshes.length === 0 ? 0 : roundMm(((max[a] ?? 0) - (min[a] ?? 0)) * 1000));
  return {
    bytes,
    gltf,
    stats: { triangles, vertices, meshes: meshes.length, boundsMm: [extent(0), extent(1), extent(2)] },
  };
}

/** Parses a GLB container back into its glTF JSON and BIN chunk (validates header and chunk layout). */
export function parseGlb(bytes: Uint8Array): { json: unknown; bin: Uint8Array | null } {
  if (bytes.byteLength < 20) throw new RangeError("GLB too short");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(0, true) !== GLB_MAGIC) throw new TypeError("not a GLB (bad magic)");
  if (view.getUint32(4, true) !== 2) throw new TypeError("unsupported GLB version");
  if (view.getUint32(8, true) !== bytes.byteLength) throw new RangeError("GLB length mismatch");
  const jsonLength = view.getUint32(12, true);
  if (view.getUint32(16, true) !== GLB_CHUNK_JSON) throw new TypeError("first GLB chunk must be JSON");
  if (jsonLength % 4 !== 0 || 20 + jsonLength > bytes.byteLength) throw new RangeError("bad JSON chunk length");
  const json: unknown = JSON.parse(new TextDecoder().decode(bytes.subarray(20, 20 + jsonLength)));
  const binStart = 20 + jsonLength;
  if (binStart === bytes.byteLength) return { json, bin: null };
  const binLength = view.getUint32(binStart, true);
  if (view.getUint32(binStart + 4, true) !== GLB_CHUNK_BIN) throw new TypeError("second GLB chunk must be BIN");
  if (binLength % 4 !== 0 || binStart + 8 + binLength !== bytes.byteLength) throw new RangeError("bad BIN chunk length");
  return { json, bin: bytes.subarray(binStart + 8, binStart + 8 + binLength) };
}
