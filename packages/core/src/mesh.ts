/**
 * Pure triangle-mesh builders for every solid HyperStage kind (zero DOM / WebGL deps).
 * Every mesh is closed, CCW-outward and uses metres in a Y-up frame.
 */
import { VertexWelder, csgRawMesh } from "./csg.js";
import type { RawMesh } from "./csg.js";
import { resolveMaterial } from "./materials.js";
import type { ResolvedMaterial } from "./materials.js";
import { IDENTITY_QUAT, cross, dot, rotateVec, sub } from "./math.js";
import { resolveScene } from "./resolver.js";
import type { ResolvedGeometry, ResolvedScene } from "./resolver.js";
import type { CsgOperation, GeometryNode, GeometrySpec, Quat, SceneAST, ShapeSpec, Vec3 } from "./schema.js";
import { gltfSize, shapeQuaternion } from "./shapes.js";
import type { Aabb } from "./shapes.js";

/** Indexed triangle mesh: xyz positions, unit xyz normals, uint32 triangle indices (CCW = outward). */
export interface TriangleMesh {
  positions: Float32Array;
  normals: Float32Array;
  indices: Uint32Array;
}

export interface MeshOptions {
  /** Radial tessellation for round shapes (clamped to 8..128, default 32). */
  segments?: number;
}

export interface SceneMesh {
  id: string;
  node: GeometryNode;
  /** Mesh in the node's local frame (apply `quaternion` then `center` to place it). */
  local: TriangleMesh;
  /** Mesh in world space. */
  world: TriangleMesh;
  center: Vec3;
  quaternion: Quat;
  material: ResolvedMaterial;
  /** Tight world-space AABB of `world`. */
  bounds: Aabb;
}

export interface ManifoldReport {
  /** True when every undirected edge is used by exactly two triangles with opposite winding and none are degenerate. */
  closed: boolean;
  weldedVertices: number;
  triangles: number;
  boundaryEdges: number;
  nonManifoldEdges: number;
  inconsistentEdges: number;
  degenerateTriangles: number;
}

const DEFAULT_SEGMENTS = 32;

function segmentsOf(options: MeshOptions | undefined): number {
  const s = Math.round(options?.segments ?? DEFAULT_SEGMENTS);
  return Math.min(128, Math.max(8, Number.isFinite(s) ? s : DEFAULT_SEGMENTS));
}

function emptyRaw(): RawMesh {
  return { positions: [], normals: [], indices: [] };
}

function pushVertex(mesh: RawMesh, p: Vec3, n: Vec3): number {
  const index = mesh.positions.length / 3;
  mesh.positions.push(p[0], p[1], p[2]);
  mesh.normals.push(n[0], n[1], n[2]);
  return index;
}

function boxRaw(size: Vec3): RawMesh {
  const mesh = emptyRaw();
  const h: Vec3 = [size[0] / 2, size[1] / 2, size[2] / 2];
  const faces: [Vec3, Vec3, Vec3][] = [
    [[1, 0, 0], [0, 1, 0], [0, 0, 1]],
    [[-1, 0, 0], [0, 0, 1], [0, 1, 0]],
    [[0, 1, 0], [0, 0, 1], [1, 0, 0]],
    [[0, -1, 0], [1, 0, 0], [0, 0, 1]],
    [[0, 0, 1], [1, 0, 0], [0, 1, 0]],
    [[0, 0, -1], [0, 1, 0], [1, 0, 0]],
  ];
  for (const [n, u, v] of faces) {
    const corner = (su: number, sv: number): Vec3 => [
      (n[0] + u[0] * su + v[0] * sv) * h[0],
      (n[1] + u[1] * su + v[1] * sv) * h[1],
      (n[2] + u[2] * su + v[2] * sv) * h[2],
    ];
    const a = pushVertex(mesh, corner(-1, -1), n);
    const b = pushVertex(mesh, corner(1, -1), n);
    const c = pushVertex(mesh, corner(1, 1), n);
    const d = pushVertex(mesh, corner(-1, 1), n);
    mesh.indices.push(a, b, c, a, c, d);
  }
  return mesh;
}

/** Profile sample for a surface of revolution about Y: radius, height, and the outward normal's (radial, y) parts. */
interface ProfilePoint {
  r: number;
  y: number;
  nr: number;
  ny: number;
}

/**
 * Revolves profile strips (each ordered so travelling along it keeps the outside on the
 * surface's outward normal side, e.g. top to bottom on a sphere) around local Y.
 * Points with r = 0 collapse to a single pole vertex.
 */
function latheRaw(strips: { points: ProfilePoint[]; closed?: boolean }[], segments: number, mesh: RawMesh = emptyRaw()): RawMesh {
  for (const strip of strips) {
    const rings: number[][] = [];
    for (const p of strip.points) {
      if (p.r < 1e-12) {
        const pole = pushVertex(mesh, [0, p.y, 0], [0, p.ny >= 0 ? 1 : -1, 0]);
        rings.push(new Array<number>(segments).fill(pole));
        continue;
      }
      const ring: number[] = [];
      for (let j = 0; j < segments; j++) {
        const theta = (j / segments) * Math.PI * 2;
        const s = Math.sin(theta);
        const c = Math.cos(theta);
        ring.push(pushVertex(mesh, [p.r * s, p.y, p.r * c], [p.nr * s, p.ny, p.nr * c]));
      }
      rings.push(ring);
    }
    const count = strip.closed === true ? rings.length : rings.length - 1;
    for (let i = 0; i < count; i++) {
      const upper = rings[i];
      const lower = rings[(i + 1) % rings.length];
      if (upper === undefined || lower === undefined) continue;
      for (let j = 0; j < segments; j++) {
        const k = (j + 1) % segments;
        const a = upper[j] ?? 0;
        const b = lower[j] ?? 0;
        const c = lower[k] ?? 0;
        const d = upper[k] ?? 0;
        if (a !== b && b !== c && a !== c) mesh.indices.push(a, b, c);
        if (a !== c && c !== d && a !== d) mesh.indices.push(a, c, d);
      }
    }
  }
  return mesh;
}

function arc(cy: number, radius: number, fromRad: number, toRad: number, steps: number): ProfilePoint[] {
  const out: ProfilePoint[] = [];
  for (let i = 0; i <= steps; i++) {
    const phi = fromRad + ((toRad - fromRad) * i) / steps;
    const c = Math.cos(phi);
    const s = Math.sin(phi);
    out.push({ r: Math.abs(c) < 1e-12 ? 0 : radius * c, y: cy + radius * s, nr: c, ny: s });
  }
  return out;
}

function sphereRaw(radius: number, segments: number): RawMesh {
  return latheRaw([{ points: arc(0, radius, Math.PI / 2, -Math.PI / 2, Math.max(4, Math.round(segments / 2))) }], segments);
}

function capsuleRaw(radius: number, height: number, segments: number): RawMesh {
  const half = Math.max(0, height / 2 - radius);
  const steps = Math.max(2, Math.round(segments / 4));
  const top = arc(half, radius, Math.PI / 2, 0, steps);
  const bottom = arc(-half, radius, 0, -Math.PI / 2, steps);
  const points = half > 1e-9 ? [...top, ...bottom] : [...top, ...bottom.slice(1)];
  return latheRaw([{ points }], segments);
}

function cylinderRaw(radiusTop: number, radiusBottom: number, height: number, segments: number): RawMesh {
  const h = height / 2;
  const slope = Math.hypot(height, radiusBottom - radiusTop);
  const nr = height / slope;
  const ny = (radiusBottom - radiusTop) / slope;
  return latheRaw(
    [
      { points: [{ r: 0, y: h, nr: 0, ny: 1 }, { r: radiusTop, y: h, nr: 0, ny: 1 }] },
      { points: [{ r: radiusTop, y: h, nr, ny }, { r: radiusBottom, y: -h, nr, ny }] },
      { points: [{ r: radiusBottom, y: -h, nr: 0, ny: -1 }, { r: 0, y: -h, nr: 0, ny: -1 }] },
    ],
    segments,
  );
}

function torusRaw(radius: number, tube: number, segments: number): RawMesh {
  const steps = Math.max(8, Math.round(segments / 2));
  const points: ProfilePoint[] = [];
  for (let i = 0; i < steps; i++) {
    const phi = Math.PI / 2 - (i / steps) * Math.PI * 2;
    const c = Math.cos(phi);
    const s = Math.sin(phi);
    points.push({ r: radius + tube * c, y: tube * s, nr: c, ny: s });
  }
  return latheRaw([{ points, closed: true }], segments);
}

function transformRaw(mesh: RawMesh, q: Quat, t: Vec3): RawMesh {
  const out: RawMesh = { positions: new Array<number>(mesh.positions.length), normals: new Array<number>(mesh.normals.length), indices: mesh.indices.slice() };
  for (let i = 0; i < mesh.positions.length; i += 3) {
    const p = rotateVec(q, [mesh.positions[i] ?? 0, mesh.positions[i + 1] ?? 0, mesh.positions[i + 2] ?? 0]);
    const n = rotateVec(q, [mesh.normals[i] ?? 0, mesh.normals[i + 1] ?? 0, mesh.normals[i + 2] ?? 0]);
    out.positions[i] = p[0] + t[0];
    out.positions[i + 1] = p[1] + t[1];
    out.positions[i + 2] = p[2] + t[2];
    out.normals[i] = n[0];
    out.normals[i + 1] = n[1];
    out.normals[i + 2] = n[2];
  }
  return out;
}

function shapeRaw(spec: ShapeSpec, segments: number): RawMesh {
  switch (spec.kind) {
    case "box":
    case "ramp":
      return boxRaw(spec.size);
    case "sphere":
      return sphereRaw(spec.radius, segments);
    case "cylinder":
      return cylinderRaw(spec.radiusTop, spec.radiusBottom, spec.height, segments);
    case "capsule":
      return capsuleRaw(spec.radius, spec.height, segments);
    case "torus":
      return torusRaw(spec.radius, spec.tube, segments);
    case "gltf":
      return boxRaw(gltfSize(spec).map((v) => Math.abs(v)) as Vec3);
    case "csg":
      return csgRawMesh(spec.operation, placedRaw(spec.base, segments), placedRaw(spec.tool, segments));
  }
}

function placedRaw(spec: GeometrySpec, segments: number): RawMesh {
  return transformRaw(shapeRaw(spec, segments), shapeQuaternion(spec), spec.position ?? [0, 0, 0]);
}

function toMesh(raw: RawMesh): TriangleMesh {
  return {
    positions: Float32Array.from(raw.positions),
    normals: Float32Array.from(raw.normals),
    indices: Uint32Array.from(raw.indices),
  };
}

function fromMesh(mesh: TriangleMesh): RawMesh {
  return { positions: Array.from(mesh.positions), normals: Array.from(mesh.normals), indices: Array.from(mesh.indices) };
}

/**
 * Mesh of a shape in its own frame: centred on the origin for primitives, untilted for ramps
 * (the ramp slope lives in the node quaternion), CSG operands placed inside the CSG frame.
 */
export function buildShapeMesh(spec: ShapeSpec, options?: MeshOptions): TriangleMesh {
  return toMesh(shapeRaw(spec, segmentsOf(options)));
}

/** Mesh of a CSG operand / geometry spec with its own `position`, `rotationDeg` and ramp tilt applied. */
export function buildGeometryMesh(spec: GeometrySpec, options?: MeshOptions): TriangleMesh {
  return toMesh(placedRaw(spec, segmentsOf(options)));
}

/** World-space mesh of a resolved geometry node (resolver centre + quaternion applied). */
export function buildNodeMesh(geometry: ResolvedGeometry, options?: MeshOptions): TriangleMesh {
  return toMesh(transformRaw(shapeRaw(geometry.node, segmentsOf(options)), geometry.quaternion, geometry.center));
}

/** Local + world meshes, resolved material and tight bounds for every geometry node, in declaration order. */
export function buildSceneMeshes(input: SceneAST | ResolvedScene, options?: MeshOptions): SceneMesh[] {
  const resolved = "geometry" in input ? input : resolveScene(input);
  const segments = segmentsOf(options);
  return resolved.geometry.map((g) => {
    const raw = shapeRaw(g.node, segments);
    const world = toMesh(transformRaw(raw, g.quaternion, g.center));
    return {
      id: g.id,
      node: g.node,
      local: toMesh(raw),
      world,
      center: g.center,
      quaternion: g.quaternion,
      material: resolveMaterial(g.node.material),
      bounds: meshBounds(world),
    };
  });
}

/** Boolean operation on two closed meshes (same frame); the result is closed and edge-manifold. */
export function csgMesh(operation: CsgOperation, a: TriangleMesh, b: TriangleMesh): TriangleMesh {
  return toMesh(csgRawMesh(operation, fromMesh(a), fromMesh(b)));
}

/** Rotates by `quaternion` then translates by `translation` (normals rotated only). */
export function transformMesh(mesh: TriangleMesh, quaternion: Quat = IDENTITY_QUAT, translation: Vec3 = [0, 0, 0]): TriangleMesh {
  return toMesh(transformRaw(fromMesh(mesh), quaternion, translation));
}

/** Concatenates meshes into one (indices re-based). */
export function mergeMeshes(meshes: readonly TriangleMesh[]): TriangleMesh {
  let vertexCount = 0;
  let indexCount = 0;
  for (const m of meshes) {
    vertexCount += m.positions.length;
    indexCount += m.indices.length;
  }
  const positions = new Float32Array(vertexCount);
  const normals = new Float32Array(vertexCount);
  const indices = new Uint32Array(indexCount);
  let vOffset = 0;
  let iOffset = 0;
  for (const m of meshes) {
    positions.set(m.positions, vOffset);
    normals.set(m.normals, vOffset);
    const base = vOffset / 3;
    for (let i = 0; i < m.indices.length; i++) indices[iOffset + i] = (m.indices[i] ?? 0) + base;
    vOffset += m.positions.length;
    iOffset += m.indices.length;
  }
  return { positions, normals, indices };
}

/** Tight AABB of a mesh's vertices (zero box for an empty mesh). */
export function meshBounds(mesh: TriangleMesh): Aabb {
  if (mesh.positions.length === 0) return { min: [0, 0, 0], max: [0, 0, 0] };
  const min: Vec3 = [Infinity, Infinity, Infinity];
  const max: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < mesh.positions.length; i += 3) {
    for (let a = 0; a < 3; a++) {
      const v = mesh.positions[i + a] ?? 0;
      if (v < (min[a] ?? 0)) min[a] = v;
      if (v > (max[a] ?? 0)) max[a] = v;
    }
  }
  return { min, max };
}

export function meshTriangleCount(mesh: TriangleMesh): number {
  return Math.floor(mesh.indices.length / 3);
}

function vertexAt(mesh: TriangleMesh, i: number): Vec3 {
  return [mesh.positions[i * 3] ?? 0, mesh.positions[i * 3 + 1] ?? 0, mesh.positions[i * 3 + 2] ?? 0];
}

/** Enclosed volume (m^3) by the divergence theorem; positive for closed outward-wound meshes. */
export function meshVolume(mesh: TriangleMesh): number {
  let volume = 0;
  for (let t = 0; t < mesh.indices.length; t += 3) {
    const a = vertexAt(mesh, mesh.indices[t] ?? 0);
    const b = vertexAt(mesh, mesh.indices[t + 1] ?? 0);
    const c = vertexAt(mesh, mesh.indices[t + 2] ?? 0);
    volume += dot(a, cross(b, c)) / 6;
  }
  return volume;
}

/** Welds vertices by position (tolerance in metres) and checks that the surface is closed and 2-manifold. */
export function checkManifold(mesh: TriangleMesh, tolerance = 1e-6): ManifoldReport {
  const welder = new VertexWelder(tolerance, Math.max(tolerance * 10, 1e-7));
  const remap: number[] = [];
  for (let i = 0; i < mesh.positions.length / 3; i++) remap.push(welder.weld(vertexAt(mesh, i)));
  const directed = new Map<string, number>();
  let degenerate = 0;
  for (let t = 0; t < mesh.indices.length; t += 3) {
    const tri = [remap[mesh.indices[t] ?? 0] ?? 0, remap[mesh.indices[t + 1] ?? 0] ?? 0, remap[mesh.indices[t + 2] ?? 0] ?? 0];
    const [i0 = 0, i1 = 0, i2 = 0] = tri;
    if (i0 === i1 || i1 === i2 || i0 === i2) {
      degenerate++;
      continue;
    }
    const area = cross(sub(vertexAt(mesh, mesh.indices[t + 1] ?? 0), vertexAt(mesh, mesh.indices[t] ?? 0)), sub(vertexAt(mesh, mesh.indices[t + 2] ?? 0), vertexAt(mesh, mesh.indices[t] ?? 0)));
    if (Math.hypot(area[0], area[1], area[2]) < 1e-14) degenerate++;
    for (const [a, b] of [
      [i0, i1],
      [i1, i2],
      [i2, i0],
    ] as const) {
      const key = `${a}>${b}`;
      directed.set(key, (directed.get(key) ?? 0) + 1);
    }
  }
  let boundary = 0;
  let nonManifold = 0;
  let inconsistent = 0;
  const visited = new Set<string>();
  for (const key of directed.keys()) {
    const [aStr, bStr] = key.split(">");
    const a = Number(aStr);
    const b = Number(bStr);
    const undirected = a < b ? `${a}-${b}` : `${b}-${a}`;
    if (visited.has(undirected)) continue;
    visited.add(undirected);
    const forward = directed.get(`${a}>${b}`) ?? 0;
    const backward = directed.get(`${b}>${a}`) ?? 0;
    const total = forward + backward;
    if (total === 1) boundary++;
    else if (total > 2) nonManifold++;
    else if (forward !== 1 || backward !== 1) inconsistent++;
  }
  return {
    closed: boundary === 0 && nonManifold === 0 && inconsistent === 0 && degenerate === 0 && mesh.indices.length > 0,
    weldedVertices: welder.positions.length,
    triangles: meshTriangleCount(mesh),
    boundaryEdges: boundary,
    nonManifoldEdges: nonManifold,
    inconsistentEdges: inconsistent,
    degenerateTriangles: degenerate,
  };
}
