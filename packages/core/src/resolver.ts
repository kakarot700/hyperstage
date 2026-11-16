import {
  IDENTITY_QUAT,
  add,
  component,
  orientedHalfExtents,
  quatFromEulerDeg,
  quatMultiply,
  roundVec,
  withComponent,
} from "./math.js";
import type { AnchorFace, GeometryNode, Quat, SceneAST, SceneNode, SnapRule, Vec3 } from "./schema.js";
import { isGeometryNode } from "./schema.js";

export class AnchorCycleError extends Error {
  readonly cycle: string[];
  constructor(cycle: string[]) {
    super(`snapTo anchor cycle detected: ${cycle.join(" -> ")}`);
    this.name = "AnchorCycleError";
    this.cycle = cycle;
  }
}

export class AnchorTargetError extends Error {
  readonly nodeId: string;
  readonly targetId: string;
  constructor(nodeId: string, targetId: string) {
    super(`node "${nodeId}" snaps to unknown or non-geometry target "${targetId}"`);
    this.name = "AnchorTargetError";
    this.nodeId = nodeId;
    this.targetId = targetId;
  }
}

export interface ResolvedGeometry {
  id: string;
  node: GeometryNode;
  /** World-space center of the shape (also the center of its AABB). */
  center: Vec3;
  /** Orientation as quaternion [x, y, z, w]; ramps include their slope tilt. */
  quaternion: Quat;
  /** Local (oriented) half sizes of the shape's bounding box. */
  localHalf: Vec3;
  /** World-space AABB half extents. */
  halfExtents: Vec3;
  min: Vec3;
  max: Vec3;
  /** Index in topological order. */
  order: number;
}

export interface ResolvedScene {
  scene: SceneAST;
  /** Scene with every geometry node's absolute position baked in. */
  bakedScene: SceneAST;
  geometry: ResolvedGeometry[];
  byId: Map<string, ResolvedGeometry>;
  topologicalOrder: string[];
}

export interface FaceAxis {
  axis: 0 | 1 | 2;
  sign: 1 | -1;
}

/** Face to world axis mapping: top=+Y, bottom=-Y, north=-Z, south=+Z, east=+X, west=-X. */
export const FACE_AXIS: Record<AnchorFace, FaceAxis> = {
  top: { axis: 1, sign: 1 },
  bottom: { axis: 1, sign: -1 },
  north: { axis: 2, sign: -1 },
  south: { axis: 2, sign: 1 },
  east: { axis: 0, sign: 1 },
  west: { axis: 0, sign: -1 },
};

export function localHalfSize(node: GeometryNode): Vec3 {
  switch (node.kind) {
    case "box":
    case "ramp":
      return [node.size[0] / 2, node.size[1] / 2, node.size[2] / 2];
    case "sphere":
      return [node.radius, node.radius, node.radius];
    case "cylinder": {
      const r = Math.max(node.radiusTop, node.radiusBottom);
      return [r, node.height / 2, r];
    }
  }
}

export function nodeQuaternion(node: GeometryNode): Quat {
  const base = node.rotationDeg ? quatFromEulerDeg(node.rotationDeg) : IDENTITY_QUAT;
  if (node.kind === "ramp") {
    return quatMultiply(base, quatFromEulerDeg([0, 0, node.angleDeg]));
  }
  return base;
}

/** World AABB half extents of a geometry node (OBB projected onto world axes). */
export function halfExtentsOf(node: GeometryNode): Vec3 {
  if (node.kind === "sphere") return [node.radius, node.radius, node.radius];
  return orientedHalfExtents(nodeQuaternion(node), localHalfSize(node));
}

/** Computes the world center of `child` when snapped to `target` per `rule`. */
export function snapCenter(
  rule: SnapRule,
  targetCenter: Vec3,
  targetHalf: Vec3,
  childHalf: Vec3,
): Vec3 {
  const { axis, sign } = FACE_AXIS[rule.face];
  const align = rule.align ?? "center";
  let center: Vec3 = [targetCenter[0], targetCenter[1], targetCenter[2]];
  center = withComponent(
    center,
    axis,
    component(targetCenter, axis) + sign * (component(targetHalf, axis) + component(childHalf, axis)),
  );
  for (const ortho of [0, 1, 2] as const) {
    if (ortho === axis) continue;
    const tc = component(targetCenter, ortho);
    const th = component(targetHalf, ortho);
    const ch = component(childHalf, ortho);
    const value = align === "min" ? tc - th + ch : align === "max" ? tc + th - ch : tc;
    center = withComponent(center, ortho, value);
  }
  return rule.offset ? add(center, rule.offset) : center;
}

function findCycle(remaining: Set<string>, targetOf: Map<string, string>, order: string[]): string[] {
  const start = order.find((id) => remaining.has(id));
  if (start === undefined) return [];
  const path: string[] = [];
  const indexOf = new Map<string, number>();
  let current: string | undefined = start;
  while (current !== undefined && !indexOf.has(current)) {
    indexOf.set(current, path.length);
    path.push(current);
    current = targetOf.get(current);
  }
  if (current === undefined) return path;
  const begin = indexOf.get(current) ?? 0;
  // Each arrow reads "snaps to": A -> B means A is anchored on B.
  const cycle = path.slice(begin);
  const first = cycle[0];
  return first === undefined ? cycle : [...cycle, first];
}

/**
 * Resolves every snapTo relation using Kahn's topological sort and returns
 * world-space transforms and AABBs for all geometry nodes.
 */
export function resolveScene(scene: SceneAST): ResolvedScene {
  const nodes = scene.nodes;
  const byIdNode = new Map<string, SceneNode>();
  for (const node of nodes) byIdNode.set(node.id, node);

  const children = new Map<string, string[]>();
  const indegree = new Map<string, number>();
  const targetOf = new Map<string, string>();
  for (const node of nodes) indegree.set(node.id, 0);
  for (const node of nodes) {
    if (!isGeometryNode(node) || node.snapTo === undefined) continue;
    const target = byIdNode.get(node.snapTo.target);
    if (target === undefined || !isGeometryNode(target)) {
      throw new AnchorTargetError(node.id, node.snapTo.target);
    }
    targetOf.set(node.id, target.id);
    const list = children.get(target.id) ?? [];
    list.push(node.id);
    children.set(target.id, list);
    indegree.set(node.id, (indegree.get(node.id) ?? 0) + 1);
  }

  const queue: string[] = nodes.filter((n) => (indegree.get(n.id) ?? 0) === 0).map((n) => n.id);
  const order: string[] = [];
  let head = 0;
  while (head < queue.length) {
    const id = queue[head++];
    if (id === undefined) break;
    order.push(id);
    for (const child of children.get(id) ?? []) {
      const next = (indegree.get(child) ?? 0) - 1;
      indegree.set(child, next);
      if (next === 0) queue.push(child);
    }
  }

  if (order.length < nodes.length) {
    const visited = new Set(order);
    const remaining = new Set(nodes.map((n) => n.id).filter((id) => !visited.has(id)));
    throw new AnchorCycleError(
      findCycle(
        remaining,
        targetOf,
        nodes.map((n) => n.id),
      ),
    );
  }

  const byId = new Map<string, ResolvedGeometry>();
  const geometry: ResolvedGeometry[] = [];
  order.forEach((id, index) => {
    const node = byIdNode.get(id);
    if (node === undefined || !isGeometryNode(node)) return;
    const quaternion = nodeQuaternion(node);
    const localHalf = localHalfSize(node);
    const halfExtents = node.kind === "sphere" ? localHalf : orientedHalfExtents(quaternion, localHalf);
    let center: Vec3 = node.position ?? [0, 0, 0];
    if (node.snapTo !== undefined) {
      const target = byId.get(node.snapTo.target);
      if (target === undefined) throw new AnchorTargetError(node.id, node.snapTo.target);
      center = snapCenter(node.snapTo, target.center, target.halfExtents, halfExtents);
    }
    center = roundVec(center);
    const resolved: ResolvedGeometry = {
      id,
      node,
      center,
      quaternion,
      localHalf,
      halfExtents,
      min: [center[0] - halfExtents[0], center[1] - halfExtents[1], center[2] - halfExtents[2]],
      max: [center[0] + halfExtents[0], center[1] + halfExtents[1], center[2] + halfExtents[2]],
      order: index,
    };
    byId.set(id, resolved);
    geometry.push(resolved);
  });

  // Keep geometry in the author's declaration order for stable downstream output.
  const declared = nodes.filter(isGeometryNode).map((n) => byId.get(n.id));
  const geometryOrdered = declared.filter((g): g is ResolvedGeometry => g !== undefined);

  const bakedScene: SceneAST = {
    ...scene,
    nodes: nodes.map((node) => {
      if (!isGeometryNode(node)) return node;
      const resolved = byId.get(node.id);
      if (resolved === undefined) return node;
      const { snapTo: _snap, ...rest } = node;
      return { ...rest, position: resolved.center };
    }),
  };

  return { scene, bakedScene, geometry: geometryOrdered, byId, topologicalOrder: order };
}

/** Signed per-axis surface clearance between two AABBs (negative = penetration depth on that axis). */
export function aabbClearance(a: { min: Vec3; max: Vec3 }, b: { min: Vec3; max: Vec3 }): number {
  let gap = -Infinity;
  let minOverlap = Infinity;
  let separated = false;
  for (let axis = 0; axis < 3; axis++) {
    const aMin = component(a.min, axis);
    const aMax = component(a.max, axis);
    const bMin = component(b.min, axis);
    const bMax = component(b.max, axis);
    const overlap = Math.min(aMax, bMax) - Math.max(aMin, bMin);
    if (overlap < 0) {
      separated = true;
      gap = Math.max(gap, -overlap);
    }
    minOverlap = Math.min(minOverlap, overlap);
  }
  if (!separated) return -minOverlap;
  let sq = 0;
  for (let axis = 0; axis < 3; axis++) {
    const g = Math.max(component(a.min, axis), component(b.min, axis)) - Math.min(component(a.max, axis), component(b.max, axis));
    if (g > 0) sq += g * g;
  }
  return gap > 0 ? Math.sqrt(sq) : 0;
}
