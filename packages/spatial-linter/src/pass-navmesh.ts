import { add, dot, quatAxes, round6, roundVec, scale } from "@hyperstage/core";
import type { GoalNode, ResolvedGeometry, ResolvedScene, SpawnNode, Vec3 } from "@hyperstage/core";
import { meshColumnSpans, meshProxyOf, segmentAabb, segmentMesh } from "./geometry.js";
import type { SpatialDiagnostic } from "./types.js";

export const NAV_CELL_M = 0.25;
export const NAV_CLEARANCE_M = 1.5;
export const NAV_STEP_M = 0.5;
export const NAV_JUMP_M = 2.0;
export const NAV_MAX_DROP_M = 4.0;
/** Height above the take-off surface that must stay clear along a gap jump. */
export const JUMP_TORSO_M = 0.9;
const MAX_LAYERS = 8;
const MAX_CELLS_PER_AXIS = 480;
const WALKABLE_COS = Math.cos((50 * Math.PI) / 180);

export interface NavResult {
  reachable: boolean;
  pathLengthMeters: number;
  waypoints: Vec3[];
  closestReachable: Vec3 | null;
  cells: number;
}

interface Span {
  top: number;
  bottom: number;
  walkable: boolean;
  owner: number;
}

interface Column {
  heights: number[];
}

/** Height of the walkable top face of `g` at (x, z), plus the vertical thickness of the body there. */
function topAt(g: ResolvedGeometry, x: number, z: number): { top: number; bottom: number; walkable: boolean } | null {
  const node = g.node;
  if (node.kind === "sphere") {
    const dx = x - g.center[0];
    const dz = z - g.center[2];
    const r = node.radius;
    const d2 = dx * dx + dz * dz;
    if (d2 > r * r) return null;
    const h = Math.sqrt(r * r - d2);
    return { top: g.center[1] + h, bottom: g.center[1] - h, walkable: false };
  }
  if (node.kind === "cylinder" && (node.rotationDeg === undefined || node.rotationDeg.every((v) => v === 0))) {
    const dx = x - g.center[0];
    const dz = z - g.center[2];
    const r = Math.max(node.radiusTop, node.radiusBottom);
    if (dx * dx + dz * dz > r * r) return null;
    return { top: g.max[1], bottom: g.min[1], walkable: dx * dx + dz * dz <= node.radiusTop * node.radiusTop };
  }
  const axes = quatAxes(g.quaternion);
  let upIndex = 0;
  let upAbs = -1;
  for (let i = 0; i < 3; i++) {
    const a = Math.abs(axes[i]?.[1] ?? 0);
    if (a > upAbs) {
      upAbs = a;
      upIndex = i;
    }
  }
  const upAxis = axes[upIndex] ?? [0, 1, 0];
  const n: Vec3 = upAxis[1] >= 0 ? upAxis : scale(upAxis, -1);
  const hn = g.localHalf[upIndex] ?? 0;
  const p0 = add(g.center, scale(n, hn));
  if (Math.abs(n[1]) < 1e-6) return null;
  const y = p0[1] - ((x - p0[0]) * n[0] + (z - p0[2]) * n[2]) / n[1];
  const d: Vec3 = [x - p0[0], y - p0[1], z - p0[2]];
  for (let i = 0; i < 3; i++) {
    if (i === upIndex) continue;
    const axis = axes[i] ?? [0, 0, 0];
    if (Math.abs(dot(d, axis)) > (g.localHalf[i] ?? 0) + 1e-6) return null;
  }
  const thickness = (2 * hn) / n[1];
  return { top: y, bottom: y - thickness, walkable: n[1] >= WALKABLE_COS };
}

class MinHeap {
  private readonly ids: number[] = [];
  private readonly keys: number[] = [];
  get size(): number {
    return this.ids.length;
  }
  push(id: number, key: number): void {
    this.ids.push(id);
    this.keys.push(key);
    let i = this.ids.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if ((this.keys[parent] ?? 0) <= key) break;
      this.swap(i, parent);
      i = parent;
    }
  }
  pop(): number | undefined {
    const top = this.ids[0];
    const lastId = this.ids.pop();
    const lastKey = this.keys.pop();
    if (this.ids.length > 0 && lastId !== undefined && lastKey !== undefined) {
      this.ids[0] = lastId;
      this.keys[0] = lastKey;
      let i = 0;
      const n = this.ids.length;
      for (;;) {
        const l = i * 2 + 1;
        const r = l + 1;
        let m = i;
        if (l < n && (this.keys[l] ?? 0) < (this.keys[m] ?? 0)) m = l;
        if (r < n && (this.keys[r] ?? 0) < (this.keys[m] ?? 0)) m = r;
        if (m === i) break;
        this.swap(i, m);
        i = m;
      }
    }
    return top;
  }
  private swap(a: number, b: number): void {
    const ia = this.ids[a] ?? 0;
    const ka = this.keys[a] ?? 0;
    this.ids[a] = this.ids[b] ?? 0;
    this.keys[a] = this.keys[b] ?? 0;
    this.ids[b] = ia;
    this.keys[b] = ka;
  }
}

const DIRS: [number, number][] = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
  [1, 1],
  [1, -1],
  [-1, 1],
  [-1, -1],
];

/** Voxelised walkable-surface navigation with step-up and gap-jump A*. */
export function computeNavigation(resolved: ResolvedScene, spawn: SpawnNode, goal: GoalNode): NavResult {
  const geometry = resolved.geometry;
  let minX = Math.min(spawn.position[0], goal.position[0]);
  let maxX = Math.max(spawn.position[0], goal.position[0]);
  let minZ = Math.min(spawn.position[2], goal.position[2]);
  let maxZ = Math.max(spawn.position[2], goal.position[2]);
  for (const g of geometry) {
    minX = Math.min(minX, g.min[0]);
    maxX = Math.max(maxX, g.max[0]);
    minZ = Math.min(minZ, g.min[2]);
    maxZ = Math.max(maxZ, g.max[2]);
  }
  minX -= NAV_CELL_M;
  minZ -= NAV_CELL_M;
  maxX += NAV_CELL_M;
  maxZ += NAV_CELL_M;
  const cell = Math.max(NAV_CELL_M, (maxX - minX) / MAX_CELLS_PER_AXIS, (maxZ - minZ) / MAX_CELLS_PER_AXIS);
  const nx = Math.max(1, Math.ceil((maxX - minX) / cell));
  const nz = Math.max(1, Math.ceil((maxZ - minZ) / cell));
  const cellX = (ix: number): number => minX + (ix + 0.5) * cell;
  const cellZ = (iz: number): number => minZ + (iz + 0.5) * cell;

  // Rasterise every body into per-column vertical spans.
  const spans: Span[][] = Array.from({ length: nx * nz }, () => []);
  geometry.forEach((g, owner) => {
    const mesh = meshProxyOf(g);
    if (mesh !== null) {
      // Closed capsule/torus/CSG meshes: every solid interval of the column is a span, so a
      // doorway leaves only the lintel overhead and the floor beneath stays walkable.
      for (const [key, list] of meshColumnSpans(mesh, minX, minZ, cell, nx, nz)) {
        for (const span of list) {
          spans[key]?.push({ top: span.top, bottom: span.bottom, walkable: span.topNormalY >= WALKABLE_COS, owner });
        }
      }
      return;
    }
    const ix0 = Math.max(0, Math.floor((g.min[0] - minX) / cell));
    const ix1 = Math.min(nx - 1, Math.floor((g.max[0] - minX) / cell));
    const iz0 = Math.max(0, Math.floor((g.min[2] - minZ) / cell));
    const iz1 = Math.min(nz - 1, Math.floor((g.max[2] - minZ) / cell));
    for (let ix = ix0; ix <= ix1; ix++) {
      for (let iz = iz0; iz <= iz1; iz++) {
        const s = topAt(g, cellX(ix), cellZ(iz));
        if (s === null) continue;
        spans[ix * nz + iz]?.push({ top: s.top, bottom: s.bottom, walkable: s.walkable, owner });
      }
    }
  });

  const columns: Column[] = spans.map((list) => {
    const heights: number[] = [];
    for (const s of list) {
      if (!s.walkable) continue;
      let clear = true;
      for (const o of list) {
        if (o === s) continue;
        if (o.bottom < s.top + NAV_CLEARANCE_M && o.top > s.top + 0.02) {
          clear = false;
          break;
        }
      }
      if (clear && !heights.some((h) => Math.abs(h - s.top) < 0.05)) heights.push(s.top);
    }
    heights.sort((a, b) => a - b);
    return { heights: heights.slice(0, MAX_LAYERS) };
  });

  const encode = (ix: number, iz: number, layer: number): number => (ix * nz + iz) * MAX_LAYERS + layer;
  const decode = (id: number): [number, number, number] => {
    const layer = id % MAX_LAYERS;
    const c = (id - layer) / MAX_LAYERS;
    return [Math.floor(c / nz), c % nz, layer];
  };
  const heightOf = (id: number): number => {
    const [ix, iz, layer] = decode(id);
    return columns[ix * nz + iz]?.heights[layer] ?? 0;
  };
  const pointOf = (id: number): Vec3 => {
    const [ix, iz] = decode(id);
    return [cellX(ix), heightOf(id), cellZ(iz)];
  };

  const locate = (p: Vec3, above: number, below: number): number | null => {
    const cx = Math.floor((p[0] - minX) / cell);
    const cz = Math.floor((p[2] - minZ) / cell);
    let best: number | null = null;
    let bestScore = Infinity;
    const radius = Math.ceil(1 / cell);
    for (let dx = -radius; dx <= radius; dx++) {
      for (let dz = -radius; dz <= radius; dz++) {
        const ix = cx + dx;
        const iz = cz + dz;
        if (ix < 0 || iz < 0 || ix >= nx || iz >= nz) continue;
        const heights = columns[ix * nz + iz]?.heights ?? [];
        heights.forEach((h, layer) => {
          if (h > p[1] + above || h < p[1] - below) return;
          const score = Math.hypot(dx * cell, dz * cell) + Math.abs(p[1] - h) * 0.1;
          if (score < bestScore) {
            bestScore = score;
            best = encode(ix, iz, layer);
          }
        });
      }
    }
    return best;
  };

  const start = locate(spawn.position, NAV_STEP_M, 3);
  const cells = nx * nz;
  if (start === null) {
    return { reachable: false, pathLengthMeters: 0, waypoints: [], closestReachable: null, cells };
  }
  const goalReached = (id: number): boolean => {
    const p = pointOf(id);
    const horizontal = Math.hypot(p[0] - goal.position[0], p[2] - goal.position[2]);
    return horizontal <= goal.radius + cell * 0.75 && Math.abs(goal.position[1] - p[1]) <= 2.0;
  };
  const heuristic = (id: number): number => {
    const p = pointOf(id);
    return Math.hypot(p[0] - goal.position[0], p[2] - goal.position[2]);
  };

  const gScore = new Map<number, number>();
  const cameFrom = new Map<number, number>();
  const closed = new Set<number>();
  const open = new MinHeap();
  gScore.set(start, 0);
  open.push(start, heuristic(start));
  let found: number | null = null;
  let closest = start;
  let closestDist = Infinity;
  const maxJumpCells = Math.floor(NAV_JUMP_M / cell + 1e-9);

  const relax = (from: number, to: number, cost: number): void => {
    if (closed.has(to)) return;
    const tentative = (gScore.get(from) ?? Infinity) + cost;
    if (tentative < (gScore.get(to) ?? Infinity)) {
      gScore.set(to, tentative);
      cameFrom.set(to, from);
      open.push(to, tentative + heuristic(to));
    }
  };

  // A jump is blocked when a solid crosses the torso-height line between take-off and landing.
  const jumpBlocked = (from: Vec3, to: Vec3): boolean => {
    const delta: Vec3 = [to[0] - from[0], to[1] - from[1], to[2] - from[2]];
    for (const g of geometry) {
      const boxT = segmentAabb(from, delta, add(g.min, [1e-4, 1e-4, 1e-4]), add(g.max, [-1e-4, -1e-4, -1e-4]));
      if (boxT === null) continue;
      const mesh = meshProxyOf(g);
      const t = mesh === null ? boxT : segmentMesh(from, delta, mesh);
      if (t !== null && t < 1) return true;
    }
    return false;
  };

  while (open.size > 0) {
    const current = open.pop();
    if (current === undefined) break;
    if (closed.has(current)) continue;
    closed.add(current);
    const cp = pointOf(current);
    const gd = Math.hypot(cp[0] - goal.position[0], cp[1] - goal.position[1], cp[2] - goal.position[2]);
    if (gd < closestDist) {
      closestDist = gd;
      closest = current;
    }
    if (goalReached(current)) {
      found = current;
      break;
    }
    const [ix, iz] = decode(current);
    const h = cp[1];
    for (const [dx, dz] of DIRS) {
      const stepLen = Math.hypot(dx, dz) * cell;
      // Walk / step-up / drop-down to the adjacent column.
      const ax = ix + dx;
      const az = iz + dz;
      let adjacentSupport = false;
      if (ax >= 0 && az >= 0 && ax < nx && az < nz) {
        const heights = columns[ax * nz + az]?.heights ?? [];
        heights.forEach((h2, layer) => {
          const rise = h2 - h;
          if (rise <= NAV_STEP_M && -rise <= NAV_MAX_DROP_M) {
            if (Math.abs(rise) <= NAV_STEP_M) adjacentSupport = true;
            relax(current, encode(ax, az, layer), stepLen + Math.abs(rise));
          }
        });
      }
      if (adjacentSupport) continue;
      // Gap jump: horizontal gaps up to 2.0 m with landing at most 0.5 m higher.
      for (let k = 2; k <= maxJumpCells; k++) {
        const jx = ix + dx * k;
        const jz = iz + dz * k;
        if (jx < 0 || jz < 0 || jx >= nx || jz >= nz) break;
        if (Math.hypot(dx * k, dz * k) * cell > NAV_JUMP_M + 1e-9) break;
        const between = columns[(ix + dx * (k - 1)) * nz + (iz + dz * (k - 1))]?.heights ?? [];
        if (between.some((hb) => hb > h + NAV_STEP_M && hb < h + NAV_CLEARANCE_M)) break;
        const heights = columns[jx * nz + jz]?.heights ?? [];
        let landed = false;
        heights.forEach((h2, layer) => {
          const rise = h2 - h;
          if (Math.abs(rise) <= NAV_STEP_M && !jumpBlocked([cp[0], h + JUMP_TORSO_M, cp[2]], [cellX(jx), Math.max(h, h2) + JUMP_TORSO_M, cellZ(jz)])) {
            landed = true;
            relax(current, encode(jx, jz, layer), Math.hypot(dx * k, dz * k) * cell * 1.5 + Math.abs(rise));
          }
        });
        if (landed) break;
      }
    }
  }

  const closestPoint = pointOf(closest);
  if (found === null) {
    return { reachable: false, pathLengthMeters: 0, waypoints: [], closestReachable: roundVec(closestPoint), cells };
  }

  const raw: Vec3[] = [];
  let cursor: number | undefined = found;
  while (cursor !== undefined) {
    raw.push(pointOf(cursor));
    cursor = cameFrom.get(cursor);
  }
  raw.reverse();
  // Smooth: drop interior points that continue the same heading on the same slope.
  const waypoints: Vec3[] = [];
  for (let i = 0; i < raw.length; i++) {
    const p = raw[i];
    if (p === undefined) continue;
    const prev = waypoints[waypoints.length - 1];
    const next = raw[i + 1];
    if (prev !== undefined && next !== undefined) {
      const d1: Vec3 = [p[0] - prev[0], p[1] - prev[1], p[2] - prev[2]];
      const d2: Vec3 = [next[0] - p[0], next[1] - p[1], next[2] - p[2]];
      const l1 = Math.hypot(d1[0], d1[1], d1[2]);
      const l2 = Math.hypot(d2[0], d2[1], d2[2]);
      if (l1 > 0 && l2 > 0 && dot(d1, d2) / (l1 * l2) > 0.9995) continue;
    }
    waypoints.push(roundVec(p));
  }
  let pathLength = 0;
  for (let i = 1; i < waypoints.length; i++) {
    const a = waypoints[i - 1];
    const b = waypoints[i];
    if (a !== undefined && b !== undefined) pathLength += Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
  }
  return {
    reachable: true,
    pathLengthMeters: round6(pathLength),
    waypoints,
    closestReachable: roundVec(closestPoint),
    cells,
  };
}

export function findSpawnGoal(resolved: ResolvedScene): { spawn: SpawnNode; goal: GoalNode } | null {
  const spawn = resolved.scene.nodes.find((n): n is SpawnNode => n.kind === "spawn");
  const goal = resolved.scene.nodes.find((n): n is GoalNode => n.kind === "goal");
  return spawn !== undefined && goal !== undefined ? { spawn, goal } : null;
}

/** Pass 4 (E04_UNREACHABLE_GOAL). */
export function passNavmesh(resolved: ResolvedScene): { diagnostics: SpatialDiagnostic[]; navPath: Vec3[]; cells: number } {
  const pair = findSpawnGoal(resolved);
  if (pair === null) return { diagnostics: [], navPath: [], cells: 0 };
  const nav = computeNavigation(resolved, pair.spawn, pair.goal);
  if (nav.reachable) return { diagnostics: [], navPath: nav.waypoints, cells: nav.cells };
  const closest = nav.closestReachable;
  const diagnostic: SpatialDiagnostic = {
    code: "E04_UNREACHABLE_GOAL",
    severity: "error",
    nodeId: pair.goal.id,
    relatedNodeId: pair.spawn.id,
    message:
      closest === null
        ? `Spawn "${pair.spawn.id}" is not standing on any walkable surface`
        : `Goal "${pair.goal.id}" is unreachable from "${pair.spawn.id}" (closest reachable point [${closest.map((v) => v.toFixed(2)).join(", ")}])`,
    metrics:
      closest === null
        ? { navCells: nav.cells }
        : {
            closestX: closest[0],
            closestY: closest[1],
            closestZ: closest[2],
            distanceToGoal: round6(Math.hypot(closest[0] - pair.goal.position[0], closest[1] - pair.goal.position[1], closest[2] - pair.goal.position[2])),
            navCells: nav.cells,
          },
  };
  if (closest !== null) {
    diagnostic.suggestedFix = {
      nodeId: pair.goal.id,
      patch: { position: roundVec([closest[0], closest[1] + 1, closest[2]]) },
      rationale: `Move goal "${pair.goal.id}" onto the closest reachable walkable surface (step-ups <= ${NAV_STEP_M} m, gaps <= ${NAV_JUMP_M} m).`,
    };
  }
  return { diagnostics: [diagnostic], navPath: [], cells: nav.cells };
}
