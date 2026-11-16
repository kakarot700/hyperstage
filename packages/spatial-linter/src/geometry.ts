import { add, cross, dot, length, normalize, quatAxes, scale, sub } from "@hyperstage/core";
import type { Quat, ResolvedGeometry, Vec3 } from "@hyperstage/core";

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
  for (let axis = 0; axis < 3; axis++) {
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
  for (let axis = 0; axis < 3; axis++) {
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
