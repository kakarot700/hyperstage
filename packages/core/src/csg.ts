/**
 * BSP-tree constructive solid geometry (after Evan Wallace's csg.js), followed by a
 * weld + T-junction repair pass so results are closed, edge-manifold triangle meshes.
 * Pure math: no DOM, no WebGL.
 */
import { add, cross, dot, length, normalize, scale, sub } from "./math.js";
import type { CsgOperation, Vec3 } from "./schema.js";

/** Plane-classification tolerance (metres). */
export const CSG_EPSILON = 1e-5;

/** Indexed triangle soup in float64 used internally by the mesh builders. */
export interface RawMesh {
  positions: number[];
  normals: number[];
  indices: number[];
}

export interface CsgVertex {
  pos: Vec3;
  normal: Vec3;
}

function lerp(a: Vec3, b: Vec3, t: number): Vec3 {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

function interpolate(a: CsgVertex, b: CsgVertex, t: number): CsgVertex {
  return { pos: lerp(a.pos, b.pos, t), normal: lerp(a.normal, b.normal, t) };
}

function flipVertex(v: CsgVertex): CsgVertex {
  return { pos: v.pos, normal: [-v.normal[0], -v.normal[1], -v.normal[2]] };
}

function at<T>(items: readonly T[], index: number): T {
  const item = items[index];
  if (item === undefined) throw new RangeError(`index ${index} out of range (${items.length})`);
  return item;
}

const COPLANAR = 0;
const FRONT = 1;
const BACK = 2;
const SPANNING = 3;

class Plane {
  constructor(
    readonly normal: Vec3,
    readonly w: number,
  ) {}

  static fromPoints(a: Vec3, b: Vec3, c: Vec3): Plane | null {
    const n = cross(sub(b, a), sub(c, a));
    const len = length(n);
    if (len < 1e-14) return null;
    const unit = scale(n, 1 / len);
    return new Plane(unit, dot(unit, a));
  }

  flipped(): Plane {
    return new Plane([-this.normal[0], -this.normal[1], -this.normal[2]], -this.w);
  }

  splitPolygon(
    polygon: CsgPolygon,
    coplanarFront: CsgPolygon[],
    coplanarBack: CsgPolygon[],
    front: CsgPolygon[],
    back: CsgPolygon[],
  ): void {
    let polygonType = 0;
    const types: number[] = [];
    for (const v of polygon.vertices) {
      const t = dot(this.normal, v.pos) - this.w;
      const type = t < -CSG_EPSILON ? BACK : t > CSG_EPSILON ? FRONT : COPLANAR;
      polygonType |= type;
      types.push(type);
    }
    switch (polygonType) {
      case COPLANAR:
        (dot(this.normal, polygon.plane.normal) > 0 ? coplanarFront : coplanarBack).push(polygon);
        return;
      case FRONT:
        front.push(polygon);
        return;
      case BACK:
        back.push(polygon);
        return;
      default: {
        const f: CsgVertex[] = [];
        const b: CsgVertex[] = [];
        const n = polygon.vertices.length;
        for (let i = 0; i < n; i++) {
          const j = (i + 1) % n;
          const ti = at(types, i);
          const tj = at(types, j);
          const vi = at(polygon.vertices, i);
          const vj = at(polygon.vertices, j);
          if (ti !== BACK) f.push(vi);
          if (ti !== FRONT) b.push(vi);
          if ((ti | tj) === SPANNING) {
            const t = (this.w - dot(this.normal, vi.pos)) / dot(this.normal, sub(vj.pos, vi.pos));
            const v = interpolate(vi, vj, t);
            f.push(v);
            b.push(v);
          }
        }
        if (f.length >= 3) front.push(new CsgPolygon(f, polygon.plane));
        if (b.length >= 3) back.push(new CsgPolygon(b, polygon.plane));
      }
    }
  }
}

/** Convex planar polygon. */
export class CsgPolygon {
  readonly vertices: CsgVertex[];
  readonly plane: Plane;

  constructor(vertices: CsgVertex[], plane: Plane) {
    this.vertices = vertices;
    this.plane = plane;
  }

  static create(vertices: CsgVertex[]): CsgPolygon | null {
    if (vertices.length < 3) return null;
    const plane = Plane.fromPoints(at(vertices, 0).pos, at(vertices, 1).pos, at(vertices, 2).pos);
    return plane === null ? null : new CsgPolygon(vertices, plane);
  }

  flipped(): CsgPolygon {
    return new CsgPolygon([...this.vertices].reverse().map(flipVertex), this.plane.flipped());
  }
}

class BspNode {
  plane: Plane | null = null;
  front: BspNode | null = null;
  back: BspNode | null = null;
  polygons: CsgPolygon[] = [];

  constructor(polygons?: CsgPolygon[]) {
    if (polygons !== undefined) this.build(polygons);
  }

  invert(): void {
    this.polygons = this.polygons.map((p) => p.flipped());
    if (this.plane !== null) this.plane = this.plane.flipped();
    this.front?.invert();
    this.back?.invert();
    const temp = this.front;
    this.front = this.back;
    this.back = temp;
  }

  clipPolygons(polygons: CsgPolygon[]): CsgPolygon[] {
    if (this.plane === null) return polygons.slice();
    let front: CsgPolygon[] = [];
    let back: CsgPolygon[] = [];
    for (const polygon of polygons) this.plane.splitPolygon(polygon, front, back, front, back);
    if (this.front !== null) front = this.front.clipPolygons(front);
    back = this.back !== null ? this.back.clipPolygons(back) : [];
    return front.concat(back);
  }

  clipTo(bsp: BspNode): void {
    this.polygons = bsp.clipPolygons(this.polygons);
    this.front?.clipTo(bsp);
    this.back?.clipTo(bsp);
  }

  allPolygons(): CsgPolygon[] {
    const out: CsgPolygon[] = [];
    const stack: BspNode[] = [this];
    while (stack.length > 0) {
      const node = stack.pop();
      if (node === undefined) break;
      for (const p of node.polygons) out.push(p);
      if (node.front !== null) stack.push(node.front);
      if (node.back !== null) stack.push(node.back);
    }
    return out;
  }

  build(polygons: CsgPolygon[]): void {
    if (polygons.length === 0) return;
    if (this.plane === null) this.plane = at(polygons, 0).plane;
    const front: CsgPolygon[] = [];
    const back: CsgPolygon[] = [];
    for (const polygon of polygons) this.plane.splitPolygon(polygon, this.polygons, this.polygons, front, back);
    if (front.length > 0) {
      this.front ??= new BspNode();
      this.front.build(front);
    }
    if (back.length > 0) {
      this.back ??= new BspNode();
      this.back.build(back);
    }
  }
}

/** Boolean operation on two closed polygon sets. */
export function csgPolygons(operation: CsgOperation, aPolygons: CsgPolygon[], bPolygons: CsgPolygon[]): CsgPolygon[] {
  const a = new BspNode(aPolygons.slice());
  const b = new BspNode(bPolygons.slice());
  switch (operation) {
    case "union":
      a.clipTo(b);
      b.clipTo(a);
      b.invert();
      b.clipTo(a);
      b.invert();
      a.build(b.allPolygons());
      return a.allPolygons();
    case "subtract":
      a.invert();
      a.clipTo(b);
      b.clipTo(a);
      b.invert();
      b.clipTo(a);
      b.invert();
      a.build(b.allPolygons());
      a.invert();
      return a.allPolygons();
    case "intersect":
      a.invert();
      b.clipTo(a);
      b.invert();
      a.clipTo(b);
      b.clipTo(a);
      a.build(b.allPolygons());
      a.invert();
      return a.allPolygons();
  }
}

function vec(arr: readonly number[], i: number): Vec3 {
  return [at(arr, i * 3), at(arr, i * 3 + 1), at(arr, i * 3 + 2)];
}

/** One polygon per non-degenerate triangle. */
export function rawMeshToPolygons(mesh: RawMesh): CsgPolygon[] {
  const out: CsgPolygon[] = [];
  for (let t = 0; t < mesh.indices.length; t += 3) {
    const verts: CsgVertex[] = [];
    for (let k = 0; k < 3; k++) {
      const i = at(mesh.indices, t + k);
      verts.push({ pos: vec(mesh.positions, i), normal: vec(mesh.normals, i) });
    }
    const polygon = CsgPolygon.create(verts);
    if (polygon !== null) out.push(polygon);
  }
  return out;
}

/** Spatial-hash vertex welder (tolerance-based, checks neighbouring cells). */
export class VertexWelder {
  readonly positions: Vec3[] = [];
  private readonly cells = new Map<string, number[]>();
  private readonly tolSq: number;

  constructor(
    readonly tolerance = 1e-7,
    private readonly cellSize = 1e-5,
  ) {
    this.tolSq = tolerance * tolerance;
  }

  private key(x: number, y: number, z: number): string {
    return `${x},${y},${z}`;
  }

  weld(p: Vec3): number {
    const cx = Math.floor(p[0] / this.cellSize);
    const cy = Math.floor(p[1] / this.cellSize);
    const cz = Math.floor(p[2] / this.cellSize);
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        for (let dz = -1; dz <= 1; dz++) {
          const bucket = this.cells.get(this.key(cx + dx, cy + dy, cz + dz));
          if (bucket === undefined) continue;
          for (const index of bucket) {
            const q = at(this.positions, index);
            const ex = q[0] - p[0];
            const ey = q[1] - p[1];
            const ez = q[2] - p[2];
            if (ex * ex + ey * ey + ez * ez <= this.tolSq) return index;
          }
        }
      }
    }
    const index = this.positions.length;
    this.positions.push([p[0], p[1], p[2]]);
    const k = this.key(cx, cy, cz);
    const bucket = this.cells.get(k);
    if (bucket === undefined) this.cells.set(k, [index]);
    else bucket.push(index);
    return index;
  }
}

interface WeldedCorner {
  index: number;
  normal: Vec3;
}

function newellNormal(points: Vec3[]): Vec3 {
  let nx = 0;
  let ny = 0;
  let nz = 0;
  for (let i = 0; i < points.length; i++) {
    const a = at(points, i);
    const b = at(points, (i + 1) % points.length);
    nx += (a[1] - b[1]) * (a[2] + b[2]);
    ny += (a[2] - b[2]) * (a[0] + b[0]);
    nz += (a[0] - b[0]) * (a[1] + b[1]);
  }
  return [nx, ny, nz];
}

/** Escalating point-on-edge tolerances (metres) for T-junction repair. */
const T_JUNCTION_TOLERANCES = [1e-7, 1e-6, 1e-5, 1e-4] as const;

/**
 * Splits polygon edges that have no matching opposite half-edge at vertices of other
 * unmatched edges lying within `tolerance` of them (T-junctions left by BSP splitting).
 */
function repairTJunctions(rings: WeldedCorner[][], positions: Vec3[], tolerance: number): WeldedCorner[][] | "closed" | "unchanged" {
  const counts = new Map<string, number>();
  for (const ring of rings) {
    for (let i = 0; i < ring.length; i++) {
      const key = `${at(ring, i).index}>${at(ring, (i + 1) % ring.length).index}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  const unmatched = (a: number, b: number): boolean => (counts.get(`${b}>${a}`) ?? 0) < (counts.get(`${a}>${b}`) ?? 0);
  const open = new Set<number>();
  for (const ring of rings) {
    for (let i = 0; i < ring.length; i++) {
      const a = at(ring, i).index;
      const b = at(ring, (i + 1) % ring.length).index;
      if (unmatched(a, b) || unmatched(b, a)) {
        open.add(a);
        open.add(b);
      }
    }
  }
  if (open.size === 0) return "closed";
  const candidates = [...open];
  let changed = false;
  const result = rings.map((ring) => {
    const next: WeldedCorner[] = [];
    for (let i = 0; i < ring.length; i++) {
      const a = at(ring, i);
      const b = at(ring, (i + 1) % ring.length);
      next.push(a);
      if (!unmatched(a.index, b.index)) continue;
      const pa = at(positions, a.index);
      const pb = at(positions, b.index);
      const edge = sub(pb, pa);
      const lenSq = dot(edge, edge);
      if (lenSq < 1e-24) continue;
      const inserts: { t: number; index: number }[] = [];
      for (const k of candidates) {
        if (k === a.index || k === b.index) continue;
        const p = at(positions, k);
        const t = dot(sub(p, pa), edge) / lenSq;
        if (t <= 1e-9 || t >= 1 - 1e-9) continue;
        if (length(sub(p, add(pa, scale(edge, t)))) <= tolerance) inserts.push({ t, index: k });
      }
      inserts.sort((x, y) => x.t - y.t);
      for (const ins of inserts) next.push({ index: ins.index, normal: normalize(lerp(a.normal, b.normal, ins.t)) });
      if (inserts.length > 0) changed = true;
    }
    return next;
  });
  return changed ? result : "unchanged";
}

/**
 * Converts BSP output polygons into a closed triangle mesh: welds coincident vertices,
 * splits edges at T-junctions so neighbouring faces share exact edges, and triangulates
 * each convex polygon (centroid fan where collinear points would create slivers).
 */
export function polygonsToRawMesh(polygons: CsgPolygon[]): RawMesh {
  const welder = new VertexWelder();
  const faces: { corners: WeldedCorner[]; normal: Vec3 }[] = [];
  for (const polygon of polygons) {
    const corners: WeldedCorner[] = [];
    for (const v of polygon.vertices) {
      const index = welder.weld(v.pos);
      const last = corners[corners.length - 1];
      if (last !== undefined && last.index === index) continue;
      corners.push({ index, normal: v.normal });
    }
    while (corners.length > 1 && corners[0]?.index === corners[corners.length - 1]?.index) corners.pop();
    if (corners.length < 3) continue;
    const area = length(newellNormal(corners.map((c) => at(welder.positions, c.index))));
    if (area < 1e-12) continue;
    faces.push({ corners, normal: polygon.plane.normal });
  }

  const positions = welder.positions;
  let rings: WeldedCorner[][] = faces.map((f) => f.corners);
  for (const tolerance of T_JUNCTION_TOLERANCES) {
    const repaired = repairTJunctions(rings, positions, tolerance);
    if (repaired === "closed") break;
    if (repaired !== "unchanged") rings = repaired;
  }

  const out: RawMesh = { positions: [], normals: [], indices: [] };
  for (let f = 0; f < faces.length; f++) {
    const face = at(faces, f);
    const ring = at(rings, f);
    const base = out.positions.length / 3;
    for (const c of ring) {
      const p = at(positions, c.index);
      out.positions.push(p[0], p[1], p[2]);
      const nn = normalize(c.normal);
      const useNormal = length(nn) > 0 ? nn : face.normal;
      out.normals.push(useNormal[0], useNormal[1], useNormal[2]);
    }
    const m = ring.length;
    let collinear = false;
    for (let i = 0; i < m && !collinear; i++) {
      const p0 = at(positions, at(ring, (i + m - 1) % m).index);
      const p1 = at(positions, at(ring, i).index);
      const p2 = at(positions, at(ring, (i + 1) % m).index);
      const c = cross(normalize(sub(p1, p0)), normalize(sub(p2, p1)));
      if (length(c) < 1e-7) collinear = true;
    }
    if (!collinear) {
      for (let i = 1; i < m - 1; i++) out.indices.push(base, base + i, base + i + 1);
    } else {
      let cx = 0;
      let cy = 0;
      let cz = 0;
      let nx = 0;
      let ny = 0;
      let nz = 0;
      for (const c of ring) {
        const p = at(positions, c.index);
        cx += p[0];
        cy += p[1];
        cz += p[2];
        nx += c.normal[0];
        ny += c.normal[1];
        nz += c.normal[2];
      }
      const centerIndex = base + m;
      out.positions.push(cx / m, cy / m, cz / m);
      const cn = normalize([nx, ny, nz]);
      const centerNormal = length(cn) > 0 ? cn : face.normal;
      out.normals.push(centerNormal[0], centerNormal[1], centerNormal[2]);
      for (let i = 0; i < m; i++) out.indices.push(centerIndex, base + i, base + ((i + 1) % m));
    }
  }
  return out;
}

/** Centre and size of the combined bounds of two raw meshes. */
function combinedFrame(a: RawMesh, b: RawMesh): { center: Vec3; size: number } {
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (const mesh of [a, b]) {
    for (let i = 0; i + 2 < mesh.positions.length; i += 3) {
      for (let k = 0; k < 3; k++) {
        const value = mesh.positions[i + k] ?? 0;
        if (value < (min[k] ?? 0)) min[k] = value;
        if (value > (max[k] ?? 0)) max[k] = value;
      }
    }
  }
  if (!Number.isFinite(min[0])) return { center: [0, 0, 0], size: 1 };
  const size = Math.hypot(max[0] - min[0], max[1] - min[1], max[2] - min[2]);
  return { center: [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2], size: size > 0 ? size : 1 };
}

function reframe(mesh: RawMesh, center: Vec3, factor: number, inverse: boolean): RawMesh {
  const positions = mesh.positions.map((value, i) => {
    const c = center[i % 3] ?? 0;
    return inverse ? value * factor + c : (value - c) * factor;
  });
  return { positions, normals: [...mesh.normals], indices: [...mesh.indices] };
}

/** Operands are normalised so their combined bounds span ~CSG_UNIT_SIZE before the BSP runs. */
export const CSG_UNIT_SIZE = 4;

/**
 * Boolean operation on two closed raw meshes, returning a closed raw mesh.
 * The operands are first moved into a normalised frame (centred, combined bounds
 * diagonal = CSG_UNIT_SIZE) so every BSP / weld / T-junction tolerance is relative
 * to the part's size: a 6 mm bracket and a 6 m wall get the same precision.
 */
export function csgRawMesh(operation: CsgOperation, a: RawMesh, b: RawMesh): RawMesh {
  const { center, size } = combinedFrame(a, b);
  const factor = CSG_UNIT_SIZE / size;
  const result = polygonsToRawMesh(
    csgPolygons(operation, rawMeshToPolygons(reframe(a, center, factor, false)), rawMeshToPolygons(reframe(b, center, factor, false))),
  );
  return reframe(result, center, 1 / factor, true);
}
