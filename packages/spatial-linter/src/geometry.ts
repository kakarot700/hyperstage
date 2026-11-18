import { add, buildNodeMesh, checkManifold, meshBounds, cross, dot, length, normalize, quatAxes, scale, sub } from "@hyperstage/core";
import type { Quat, ResolvedGeometry, TriangleMesh, Vec3 } from "@hyperstage/core";

const AXES = [0, 1, 2] as const;

/** Collision proxy: spheres are exact, every other primitive is an oriented box (OBB). */
export type Shape =
  | { type: "sphere"; center: Vec3; radius: number }
  | { type: "obb"; center: Vec3; axes: [Vec3, Vec3, Vec3]; half: Vec3 };

export function shapeOf(geometry: ResolvedGeometry, center: Vec3 = geometry.center, quaternion: Quat = geometry.quaternion): Shape {
  if (geometry.node.kind === "sphere") {
    return { type: "sphere", center, radius: geometry.node.radius };
  }
  return { type: "obb", center, axes: quatAxes(quaternion), half: geometry.localHalf };
}

export interface Contact {
  /** Positive = penetration depth in metres; negative = separation distance along the best axis. */
  depth: number;
  /** Unit vector pointing from shape A towards shape B (minimum translation direction for B). */
  normal: Vec3;
}

function projectRadius(axes: [Vec3, Vec3, Vec3], half: Vec3, axis: Vec3): number {
  return (
    Math.abs(dot(axes[0], axis)) * half[0] +
    Math.abs(dot(axes[1], axis)) * half[1] +
    Math.abs(dot(axes[2], axis)) * half[2]
  );
}

function obbObb(a: Extract<Shape, { type: "obb" }>, b: Extract<Shape, { type: "obb" }>): Contact {
  const delta = sub(b.center, a.center);
  let bestDepth = Infinity;
  let bestNormal: Vec3 = [0, 1, 0];
  const test = (rawAxis: Vec3, bias: number): void => {
    const len = length(rawAxis);
    if (len < 1e-6) return;
    const axis = scale(rawAxis, 1 / len);
    const ra = projectRadius(a.axes, a.half, axis);
    const rb = projectRadius(b.axes, b.half, axis);
    const d = dot(delta, axis);
    const overlap = ra + rb - Math.abs(d);
    // Face axes are preferred over edge axes for clean, axis-aligned repair vectors.
    if (overlap + bias < bestDepth) {
      bestDepth = overlap + bias;
      bestNormal = d >= 0 ? axis : scale(axis, -1);
    }
  };
  for (const axis of a.axes) test(axis, 0);
  for (const axis of b.axes) test(axis, 0);
  for (const ax of a.axes) for (const bx of b.axes) test(cross(ax, bx), 1e-4);
  return { depth: bestDepth, normal: bestNormal };
}

function sphereObb(s: Extract<Shape, { type: "sphere" }>, o: Extract<Shape, { type: "obb" }>): Contact {
  // Returns contact with normal from the OBB towards the sphere.
  const rel = sub(s.center, o.center);
  const local: Vec3 = [dot(rel, o.axes[0]), dot(rel, o.axes[1]), dot(rel, o.axes[2])];
  const clamped: Vec3 = [
    Math.max(-o.half[0], Math.min(o.half[0], local[0])),
    Math.max(-o.half[1], Math.min(o.half[1], local[1])),
    Math.max(-o.half[2], Math.min(o.half[2], local[2])),
  ];
  const inside = clamped[0] === local[0] && clamped[1] === local[1] && clamped[2] === local[2];
  if (!inside) {
    const closest = add(
      o.center,
      add(add(scale(o.axes[0], clamped[0]), scale(o.axes[1], clamped[1])), scale(o.axes[2], clamped[2])),
    );
    const diff = sub(s.center, closest);
    const dist = length(diff);
    return { depth: s.radius - dist, normal: dist > 1e-9 ? scale(diff, 1 / dist) : [0, 1, 0] };
  }
  let bestAxis = 0;
  let bestFace = Infinity;
  for (let i = 0; i < 3; i++) {
    const h = o.half[i] ?? 0;
    const l = local[i] ?? 0;
    const faceDist = h - Math.abs(l);
    if (faceDist < bestFace) {
      bestFace = faceDist;
      bestAxis = i;
    }
  }
  const axis = o.axes[bestAxis] ?? [0, 1, 0];
  const sign = (local[bestAxis] ?? 0) >= 0 ? 1 : -1;
  return { depth: s.radius + bestFace, normal: scale(axis, sign) };
}

/** Signed contact between two shapes (SAT for OBB pairs, closest-point for spheres). */
export function contact(a: Shape, b: Shape): Contact {
  if (a.type === "sphere" && b.type === "sphere") {
    const diff = sub(b.center, a.center);
    const dist = length(diff);
    return { depth: a.radius + b.radius - dist, normal: dist > 1e-9 ? scale(diff, 1 / dist) : [0, 1, 0] };
  }
  if (a.type === "sphere" && b.type === "obb") {
    const c = sphereObb(a, b);
    return { depth: c.depth, normal: scale(c.normal, -1) };
  }
  if (a.type === "obb" && b.type === "sphere") {
    return sphereObb(b, a);
  }
  if (a.type === "obb" && b.type === "obb") return obbObb(a, b);
  return { depth: -Infinity, normal: [0, 1, 0] };
}

export function aabbOverlapXZ(a: { min: Vec3; max: Vec3 }, b: { min: Vec3; max: Vec3 }, eps = 0): boolean {
  return a.min[0] < b.max[0] - eps && a.max[0] > b.min[0] + eps && a.min[2] < b.max[2] - eps && a.max[2] > b.min[2] + eps;
}

/** Segment (t in [0,1]) vs AABB slab test; returns entry parameter or null. */
export function segmentAabb(origin: Vec3, delta: Vec3, min: Vec3, max: Vec3): number | null {
  let tMin = 0;
  let tMax = 1;
  for (const axis of AXES) {
    const o = origin[axis] ?? 0;
    const d = delta[axis] ?? 0;
    const lo = min[axis] ?? 0;
    const hi = max[axis] ?? 0;
    if (Math.abs(d) < 1e-12) {
      if (o < lo || o > hi) return null;
      continue;
    }
    let t1 = (lo - o) / d;
    let t2 = (hi - o) / d;
    if (t1 > t2) {
      const tmp = t1;
      t1 = t2;
      t2 = tmp;
    }
    tMin = Math.max(tMin, t1);
    tMax = Math.min(tMax, t2);
    if (tMin > tMax) return null;
  }
  return tMin;
}

export function pointAabbDistance(p: Vec3, min: Vec3, max: Vec3): number {
  let sq = 0;
  for (const axis of AXES) {
    const v = p[axis] ?? 0;
    const lo = min[axis] ?? 0;
    const hi = max[axis] ?? 0;
    const d = v < lo ? lo - v : v > hi ? v - hi : 0;
    sq += d * d;
  }
  return Math.sqrt(sq);
}

export function lookBasis(from: Vec3, to: Vec3): { forward: Vec3; right: Vec3; up: Vec3 } {
  const forward = normalize(sub(to, from));
  let right = normalize(cross(forward, [0, 1, 0]));
  if (length(right) < 1e-6) right = [1, 0, 0];
  const up = normalize(cross(right, forward));
  return { forward, right, up };
}

// ---------------------------------------------------------------------------
// v2 mesh-accurate proxies (capsule, torus, CSG). v1 kinds keep the exact
// sphere / OBB proxies above so their results are bit-for-bit unchanged.
// ---------------------------------------------------------------------------

/** Radial tessellation used for lint meshes (coarser than render meshes; deterministic). */
export const LINT_MESH_SEGMENTS = 16;
const MESH_EPS = 1e-7;

/** World-space triangle soup with per-triangle bounds, built from core's `buildNodeMesh`. */
export interface LintMesh {
  id: string;
  /** 9 floats per triangle (a, b, c), world space. */
  tris: Float64Array;
  /** 6 floats per triangle: min xyz, max xyz. */
  triBounds: Float64Array;
  triangleCount: number;
  min: Vec3;
  max: Vec3;
  /** `checkManifold(...).closed` of the source mesh. */
  closed: boolean;
  boundaryEdges: number;
  degenerateTriangles: number;
}

const MESH_KINDS = new Set(["capsule", "torus", "csg"]);
const meshCache = new WeakMap<ResolvedGeometry, LintMesh>();

/** True for kinds whose collision proxy is their real triangle mesh (capsule, torus, csg). */
export function isMeshKind(g: ResolvedGeometry): boolean {
  return MESH_KINDS.has(g.node.kind);
}

/** Cached world-space lint mesh of any resolved geometry node. */
/** Max entries of the cross-lint mesh cache (keyed by node definition + pose). */
export const LINT_MESH_CACHE_SIZE = 256;
const meshByKey = new Map<string, LintMesh>();

function poseKey(g: ResolvedGeometry): string {
  return JSON.stringify([g.node, g.center, g.quaternion]);
}

export function lintMeshOf(g: ResolvedGeometry): LintMesh {
  const cached = meshCache.get(g);
  if (cached !== undefined) return cached;
  // Re-lints of an unchanged node (Studio edits, auto-fix passes, benchmarks) reuse its mesh.
  const key = poseKey(g);
  const shared = meshByKey.get(key);
  if (shared !== undefined) {
    meshByKey.delete(key);
    meshByKey.set(key, shared);
    meshCache.set(g, shared);
    return shared;
  }
  const mesh: TriangleMesh = buildNodeMesh(g, { segments: LINT_MESH_SEGMENTS });
  const extent = meshBounds(mesh);
  const diagonal = Math.hypot(extent.max[0] - extent.min[0], extent.max[1] - extent.min[1], extent.max[2] - extent.min[2]);
  // Weld tolerance relative to the part: 1e-6 of its diagonal (6 nm for a 6 mm bracket, 6 um for a 6 m wall).
  const manifold = checkManifold(mesh, Math.max(1e-12, diagonal * 1e-6));
  const count = mesh.indices.length / 3;
  const tris = new Float64Array(count * 9);
  const triBounds = new Float64Array(count * 6);
  const min: Vec3 = [Infinity, Infinity, Infinity];
  const max: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (let t = 0; t < count; t++) {
    for (let k = 0; k < 3; k++) {
      const v = mesh.indices[t * 3 + k] ?? 0;
      for (const axis of AXES) {
        const value = mesh.positions[v * 3 + axis] ?? 0;
        tris[t * 9 + k * 3 + axis] = value;
        if (k === 0 || value < (triBounds[t * 6 + axis] ?? 0)) triBounds[t * 6 + axis] = value;
        if (k === 0 || value > (triBounds[t * 6 + 3 + axis] ?? 0)) triBounds[t * 6 + 3 + axis] = value;
        if (value < min[axis]) min[axis] = value;
        if (value > max[axis]) max[axis] = value;
      }
    }
  }
  const result: LintMesh = {
    id: g.id,
    tris,
    triBounds,
    triangleCount: count,
    min,
    max,
    closed: manifold.closed,
    boundaryEdges: manifold.boundaryEdges + manifold.nonManifoldEdges + manifold.inconsistentEdges,
    degenerateTriangles: manifold.degenerateTriangles,
  };
  meshCache.set(g, result);
  meshByKey.set(key, result);
  if (meshByKey.size > LINT_MESH_CACHE_SIZE) {
    const oldest = meshByKey.keys().next().value;
    if (oldest !== undefined) meshByKey.delete(oldest);
  }
  return result;
}

/** Mesh proxy for mesh kinds whose mesh is closed; null means "use the v1 bounds proxy". */
export function meshProxyOf(g: ResolvedGeometry): LintMesh | null {
  if (!isMeshKind(g)) return null;
  const mesh = lintMeshOf(g);
  return mesh.closed ? mesh : null;
}

/** Notes for mesh kinds that failed `checkManifold` and were linted with their bounds instead. */
export function meshFallbackNotes(geometry: readonly ResolvedGeometry[]): string[] {
  const notes: string[] = [];
  for (const g of geometry) {
    if (!isMeshKind(g)) continue;
    const mesh = lintMeshOf(g);
    if (!mesh.closed) {
      notes.push(`"${g.id}" (${g.node.kind}) mesh is not closed (${mesh.boundaryEdges} open/non-manifold edges, ${mesh.degenerateTriangles} degenerate triangles); linted with its bounding box instead of its triangles.`);
    }
  }
  return notes;
}

function tri(mesh: LintMesh, t: number, k: number, o: Vec3): Vec3 {
  const base = t * 9 + k * 3;
  return [(mesh.tris[base] ?? 0) + o[0], (mesh.tris[base + 1] ?? 0) + o[1], (mesh.tris[base + 2] ?? 0) + o[2]];
}

/** Strict segment-vs-triangle crossing (touching contacts within MESH_EPS do not count). */
function segmentCrossesTriangle(p: Vec3, q: Vec3, a: Vec3, b: Vec3, c: Vec3): boolean {
  const n = cross(sub(b, a), sub(c, a));
  const nl = length(n);
  if (nl < 1e-14) return false;
  const nn = scale(n, 1 / nl);
  const dp = dot(sub(p, a), nn);
  const dq = dot(sub(q, a), nn);
  if ((dp >= -MESH_EPS && dq >= -MESH_EPS) || (dp <= MESH_EPS && dq <= MESH_EPS)) return false;
  const t = dp / (dp - dq);
  const x = add(p, scale(sub(q, p), t));
  const e = MESH_EPS * 10;
  const c0 = dot(cross(sub(b, a), sub(x, a)), nn);
  const c1 = dot(cross(sub(c, b), sub(x, b)), nn);
  const c2 = dot(cross(sub(a, c), sub(x, c)), nn);
  return c0 > e * length(sub(b, a)) && c1 > e * length(sub(c, b)) && c2 > e * length(sub(a, c));
}

function trianglesCross(a0: Vec3, a1: Vec3, a2: Vec3, b0: Vec3, b1: Vec3, b2: Vec3): boolean {
  return (
    segmentCrossesTriangle(a0, a1, b0, b1, b2) ||
    segmentCrossesTriangle(a1, a2, b0, b1, b2) ||
    segmentCrossesTriangle(a2, a0, b0, b1, b2) ||
    segmentCrossesTriangle(b0, b1, a0, a1, a2) ||
    segmentCrossesTriangle(b1, b2, a0, a1, a2) ||
    segmentCrossesTriangle(b2, b0, a0, a1, a2)
  );
}

/** Möller-Trumbore ray/triangle; returns t along `delta` or null. */
function rayTriangle(origin: Vec3, delta: Vec3, a: Vec3, b: Vec3, c: Vec3): number | null {
  const e1 = sub(b, a);
  const e2 = sub(c, a);
  const p = cross(delta, e2);
  const det = dot(e1, p);
  if (Math.abs(det) < 1e-14) return null;
  const inv = 1 / det;
  const s = sub(origin, a);
  const u = dot(s, p) * inv;
  if (u < -1e-9 || u > 1 + 1e-9) return null;
  const q = cross(s, e1);
  const v = dot(delta, q) * inv;
  if (v < -1e-9 || u + v > 1 + 1e-9) return null;
  return dot(e2, q) * inv;
}

const PARITY_DIR: Vec3 = normalize([0.5772, 0.5781, 0.5765]);

/** Ray-parity point-in-mesh for closed meshes (mesh translated by `offset`). */
export function pointInMesh(p: Vec3, mesh: LintMesh, offset: Vec3 = [0, 0, 0]): boolean {
  let hits = 0;
  for (let t = 0; t < mesh.triangleCount; t++) {
    const hit = rayTriangle(p, PARITY_DIR, tri(mesh, t, 0, offset), tri(mesh, t, 1, offset), tri(mesh, t, 2, offset));
    if (hit !== null && hit > 1e-9) hits++;
  }
  return hits % 2 === 1;
}

function boundsInside(innerMin: Vec3, innerMax: Vec3, outerMin: Vec3, outerMax: Vec3): boolean {
  for (const axis of AXES) {
    if (innerMin[axis] < outerMin[axis] || innerMax[axis] > outerMax[axis]) return false;
  }
  return true;
}

/**
 * Mesh-accurate solid intersection of closed meshes A and B (B translated by `offsetB`):
 * AABB broadphase, per-triangle AABB culling, strict triangle-vs-triangle crossing,
 * then containment by ray parity. Flush (touching) contacts are not intersections.
 */
export function meshesIntersect(a: LintMesh, b: LintMesh, offsetB: Vec3 = [0, 0, 0]): boolean {
  const bMin = add(b.min, offsetB);
  const bMax = add(b.max, offsetB);
  const lo: Vec3 = [Math.max(a.min[0], bMin[0]), Math.max(a.min[1], bMin[1]), Math.max(a.min[2], bMin[2])];
  const hi: Vec3 = [Math.min(a.max[0], bMax[0]), Math.min(a.max[1], bMax[1]), Math.min(a.max[2], bMax[2])];
  if (lo[0] > hi[0] + MESH_EPS || lo[1] > hi[1] + MESH_EPS || lo[2] > hi[2] + MESH_EPS) return false;
  const inBox = (bounds: Float64Array, t: number, o: Vec3): boolean => {
    for (const axis of AXES) {
      if ((bounds[t * 6 + axis] ?? 0) + o[axis] > hi[axis] + MESH_EPS) return false;
      if ((bounds[t * 6 + 3 + axis] ?? 0) + o[axis] < lo[axis] - MESH_EPS) return false;
    }
    return true;
  };
  const zero: Vec3 = [0, 0, 0];
  const candA: number[] = [];
  const candB: number[] = [];
  for (let t = 0; t < a.triangleCount; t++) if (inBox(a.triBounds, t, zero)) candA.push(t);
  for (let t = 0; t < b.triangleCount; t++) if (inBox(b.triBounds, t, offsetB)) candB.push(t);
  for (const ta of candA) {
    const a0 = tri(a, ta, 0, zero);
    const a1 = tri(a, ta, 1, zero);
    const a2 = tri(a, ta, 2, zero);
    for (const tb of candB) {
      let separated = false;
      for (const axis of AXES) {
        if (separated) break;
        if ((a.triBounds[ta * 6 + axis] ?? 0) > (b.triBounds[tb * 6 + 3 + axis] ?? 0) + offsetB[axis] + MESH_EPS) separated = true;
        else if ((a.triBounds[ta * 6 + 3 + axis] ?? 0) < (b.triBounds[tb * 6 + axis] ?? 0) + offsetB[axis] - MESH_EPS) separated = true;
      }
      if (separated) continue;
      if (trianglesCross(a0, a1, a2, tri(b, tb, 0, offsetB), tri(b, tb, 1, offsetB), tri(b, tb, 2, offsetB))) return true;
    }
  }
  if (b.triangleCount > 0 && boundsInside(bMin, bMax, a.min, a.max)) {
    const centroid = scale(add(add(tri(b, 0, 0, offsetB), tri(b, 0, 1, offsetB)), tri(b, 0, 2, offsetB)), 1 / 3);
    if (pointInMesh(centroid, a)) return true;
  }
  if (a.triangleCount > 0 && boundsInside(a.min, a.max, bMin, bMax)) {
    const centroid = scale(add(add(tri(a, 0, 0, zero), tri(a, 0, 1, zero)), tri(a, 0, 2, zero)), 1 / 3);
    if (pointInMesh(centroid, b, offsetB)) return true;
  }
  return false;
}

const MTV_SCAN_STEPS = 12;
const MTV_BISECT_STEPS = 16;

/**
 * Mesh-accurate contact: depth is the smallest translation of B (along the six world axes
 * and `hint`) that separates the meshes; normal is that direction. Returns a negative
 * depth when the meshes do not intersect.
 */
export function meshContact(a: LintMesh, b: LintMesh, hint: Vec3 | null): Contact {
  if (!meshesIntersect(a, b)) return { depth: -1, normal: [0, 1, 0] };
  const dirs: Vec3[] = [
    [1, 0, 0],
    [-1, 0, 0],
    [0, 1, 0],
    [0, -1, 0],
    [0, 0, 1],
    [0, 0, -1],
  ];
  if (hint !== null && length(hint) > 1e-9) dirs.push(normalize(hint));
  let best: Contact = { depth: Infinity, normal: [0, 1, 0] };
  for (const dir of dirs) {
    // Translation that certainly clears the bounds along dir.
    let aHi = -Infinity;
    let bLo = Infinity;
    for (let i = 0; i < 8; i++) {
      const pa: Vec3 = [i & 1 ? a.max[0] : a.min[0], i & 2 ? a.max[1] : a.min[1], i & 4 ? a.max[2] : a.min[2]];
      const pb: Vec3 = [i & 1 ? b.max[0] : b.min[0], i & 2 ? b.max[1] : b.min[1], i & 4 ? b.max[2] : b.min[2]];
      aHi = Math.max(aHi, dot(pa, dir));
      bLo = Math.min(bLo, dot(pb, dir));
    }
    const tMax = Math.max(0, aHi - bLo) + 1e-4;
    if (tMax >= best.depth) continue;
    const step = tMax / MTV_SCAN_STEPS;
    let lo = 0;
    let hi = tMax;
    for (let k = 1; k <= MTV_SCAN_STEPS; k++) {
      const t = step * k;
      if (t >= best.depth) break;
      if (!meshesIntersect(a, b, scale(dir, t))) {
        hi = t;
        break;
      }
      lo = t;
    }
    if (hi >= best.depth) continue;
    for (let k = 0; k < MTV_BISECT_STEPS; k++) {
      const mid = (lo + hi) / 2;
      if (meshesIntersect(a, b, scale(dir, mid))) lo = mid;
      else hi = mid;
    }
    if (hi < best.depth) best = { depth: hi, normal: dir };
  }
  return best;
}

/** First hit parameter t in [0, 1) of the segment origin + t * delta against the mesh triangles. */
export function segmentMesh(origin: Vec3, delta: Vec3, mesh: LintMesh): number | null {
  const end = add(origin, delta);
  const lo: Vec3 = [Math.min(origin[0], end[0]), Math.min(origin[1], end[1]), Math.min(origin[2], end[2])];
  const hi: Vec3 = [Math.max(origin[0], end[0]), Math.max(origin[1], end[1]), Math.max(origin[2], end[2])];
  const zero: Vec3 = [0, 0, 0];
  let best: number | null = null;
  for (let t = 0; t < mesh.triangleCount; t++) {
    let outside = false;
    for (const axis of AXES) {
      if (outside) break;
      if ((mesh.triBounds[t * 6 + axis] ?? 0) > hi[axis] + MESH_EPS || (mesh.triBounds[t * 6 + 3 + axis] ?? 0) < lo[axis] - MESH_EPS) outside = true;
    }
    if (outside) continue;
    const hit = rayTriangle(origin, delta, tri(mesh, t, 0, zero), tri(mesh, t, 1, zero), tri(mesh, t, 2, zero));
    if (hit !== null && hit >= 0 && hit <= 1 && (best === null || hit < best)) best = hit;
  }
  return best;
}

/** One solid interval of a vertical ray through a mesh column. */
export interface VerticalSpan {
  top: number;
  bottom: number;
  /** Unit normal Y of the top surface triangle. */
  topNormalY: number;
}

/**
 * Rasterises a closed mesh into vertical solid spans per (ix, iz) column of a grid
 * with cell centres at (x0 + (ix + 0.5) * cell, z0 + (iz + 0.5) * cell).
 */
export function meshColumnSpans(
  mesh: LintMesh,
  x0: number,
  z0: number,
  cell: number,
  nx: number,
  nz: number,
): Map<number, VerticalSpan[]> {
  const hits = new Map<number, { y: number; ny: number }[]>();
  const zero: Vec3 = [0, 0, 0];
  for (let t = 0; t < mesh.triangleCount; t++) {
    const a = tri(mesh, t, 0, zero);
    const b = tri(mesh, t, 1, zero);
    const c = tri(mesh, t, 2, zero);
    const n = cross(sub(b, a), sub(c, a));
    const nl = length(n);
    if (nl < 1e-14) continue;
    const ny = n[1] / nl;
    if (Math.abs(ny) < 1e-9) continue;
    const ix0 = Math.max(0, Math.ceil(((mesh.triBounds[t * 6] ?? 0) - x0) / cell - 0.5 - 1e-9));
    const ix1 = Math.min(nx - 1, Math.floor(((mesh.triBounds[t * 6 + 3] ?? 0) - x0) / cell - 0.5 + 1e-9));
    const iz0 = Math.max(0, Math.ceil(((mesh.triBounds[t * 6 + 2] ?? 0) - z0) / cell - 0.5 - 1e-9));
    const iz1 = Math.min(nz - 1, Math.floor(((mesh.triBounds[t * 6 + 5] ?? 0) - z0) / cell - 0.5 + 1e-9));
    // 2D barycentrics in XZ.
    const det = (b[0] - a[0]) * (c[2] - a[2]) - (c[0] - a[0]) * (b[2] - a[2]);
    if (Math.abs(det) < 1e-14) continue;
    for (let ix = ix0; ix <= ix1; ix++) {
      const x = x0 + (ix + 0.5) * cell;
      for (let iz = iz0; iz <= iz1; iz++) {
        const z = z0 + (iz + 0.5) * cell;
        const u = ((x - a[0]) * (c[2] - a[2]) - (c[0] - a[0]) * (z - a[2])) / det;
        const v = ((b[0] - a[0]) * (z - a[2]) - (x - a[0]) * (b[2] - a[2])) / det;
        if (u < -1e-9 || v < -1e-9 || u + v > 1 + 1e-9) continue;
        const y = a[1] + u * (b[1] - a[1]) + v * (c[1] - a[1]);
        const key = ix * nz + iz;
        const list = hits.get(key);
        if (list === undefined) hits.set(key, [{ y, ny }]);
        else list.push({ y, ny });
      }
    }
  }
  const out = new Map<number, VerticalSpan[]>();
  for (const [key, list] of hits) {
    list.sort((p, q) => q.y - p.y || q.ny - p.ny);
    // Merge duplicate hits on shared edges (same height, same facing).
    const merged: { y: number; ny: number }[] = [];
    for (const h of list) {
      const prev = merged[merged.length - 1];
      if (prev !== undefined && Math.abs(prev.y - h.y) < 1e-6 && Math.sign(prev.ny) === Math.sign(h.ny)) continue;
      merged.push(h);
    }
    const spans: VerticalSpan[] = [];
    let open: { y: number; ny: number } | null = null;
    for (const h of merged) {
      if (h.ny > 0) {
        if (open === null) open = h;
      } else if (open !== null) {
        spans.push({ top: open.y, bottom: h.y, topNormalY: open.ny });
        open = null;
      }
    }
    if (spans.length > 0) out.set(key, spans);
  }
  return out;
}
