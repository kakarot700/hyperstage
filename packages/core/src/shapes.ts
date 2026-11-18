import { IDENTITY_QUAT, quatFromEulerDeg, quatMultiply, rotateVec } from "./math.js";
import type { GeometrySpec, Quat, ShapeSpec, Vec3 } from "./schema.js";

/** Axis-aligned bounding box. */
export interface Aabb {
  min: Vec3;
  max: Vec3;
}

/**
 * Orientation of a shape relative to its parent frame: `rotationDeg` (intrinsic XYZ),
 * followed by the slope tilt about local Z for ramps.
 */
export function shapeQuaternion(spec: { kind: ShapeSpec["kind"]; rotationDeg?: Vec3; angleDeg?: number }): Quat {
  const base = spec.rotationDeg ? quatFromEulerDeg(spec.rotationDeg) : IDENTITY_QUAT;
  if (spec.kind === "ramp" && spec.angleDeg !== undefined) {
    return quatMultiply(base, quatFromEulerDeg([0, 0, spec.angleDeg]));
  }
  return base;
}

/** Effective world size of a glTF placeholder: fallbackSize * scale. */
export function gltfSize(spec: { fallbackSize: Vec3; scale?: Vec3 }): Vec3 {
  const s = spec.scale ?? [1, 1, 1];
  return [spec.fallbackSize[0] * s[0], spec.fallbackSize[1] * s[1], spec.fallbackSize[2] * s[2]];
}

function symmetric(h: Vec3): Aabb {
  return { min: [-h[0], -h[1], -h[2]], max: [h[0], h[1], h[2]] };
}

/** AABB of `box` after rotating by `q` and translating by `t` (AABB of the 8 transformed corners). */
export function transformAabb(box: Aabb, q: Quat, t: Vec3): Aabb {
  const min: Vec3 = [Infinity, Infinity, Infinity];
  const max: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < 8; i++) {
    const corner: Vec3 = [
      i & 1 ? box.max[0] : box.min[0],
      i & 2 ? box.max[1] : box.min[1],
      i & 4 ? box.max[2] : box.min[2],
    ];
    const p = rotateVec(q, corner);
    for (let a = 0; a < 3; a++) {
      const v = (p[a] ?? 0) + (t[a] ?? 0);
      if (v < (min[a] ?? 0)) min[a] = v;
      if (v > (max[a] ?? 0)) max[a] = v;
    }
  }
  return { min, max };
}

/**
 * Analytic bounds of a shape in its own (unplaced, untilted) frame. For CSG these are
 * conservative: subtract keeps the base bounds, intersect clips to both, union merges both.
 */
export function shapeLocalBounds(spec: ShapeSpec): Aabb {
  switch (spec.kind) {
    case "box":
    case "ramp":
      return symmetric([spec.size[0] / 2, spec.size[1] / 2, spec.size[2] / 2]);
    case "sphere":
      return symmetric([spec.radius, spec.radius, spec.radius]);
    case "cylinder": {
      const r = Math.max(spec.radiusTop, spec.radiusBottom);
      return symmetric([r, spec.height / 2, r]);
    }
    case "capsule":
      return symmetric([spec.radius, spec.height / 2, spec.radius]);
    case "torus": {
      const r = spec.radius + spec.tube;
      return symmetric([r, spec.tube, r]);
    }
    case "gltf": {
      const size = gltfSize(spec);
      return symmetric([Math.abs(size[0]) / 2, Math.abs(size[1]) / 2, Math.abs(size[2]) / 2]);
    }
    case "csg": {
      const a = placedBounds(spec.base);
      const b = placedBounds(spec.tool);
      if (spec.operation === "subtract") return a;
      if (spec.operation === "union") {
        return {
          min: [Math.min(a.min[0], b.min[0]), Math.min(a.min[1], b.min[1]), Math.min(a.min[2], b.min[2])],
          max: [Math.max(a.max[0], b.max[0]), Math.max(a.max[1], b.max[1]), Math.max(a.max[2], b.max[2])],
        };
      }
      const min: Vec3 = [Math.max(a.min[0], b.min[0]), Math.max(a.min[1], b.min[1]), Math.max(a.min[2], b.min[2])];
      const max: Vec3 = [Math.min(a.max[0], b.max[0]), Math.min(a.max[1], b.max[1]), Math.min(a.max[2], b.max[2])];
      for (let i = 0; i < 3; i++) {
        if ((min[i] ?? 0) > (max[i] ?? 0)) return { min: [0, 0, 0], max: [0, 0, 0] };
      }
      return { min, max };
    }
  }
}

/** Bounds of a CSG operand in its parent frame (placement + ramp tilt applied). */
export function placedBounds(spec: GeometrySpec): Aabb {
  const position = spec.position ?? [0, 0, 0];
  if (spec.kind === "sphere") {
    return {
      min: [position[0] - spec.radius, position[1] - spec.radius, position[2] - spec.radius],
      max: [position[0] + spec.radius, position[1] + spec.radius, position[2] + spec.radius],
    };
  }
  return transformAabb(shapeLocalBounds(spec), shapeQuaternion(spec), position);
}

/**
 * Local half size used by the snapTo resolver. The node origin is the centre of this box,
 * so off-centre CSG results are symmetrised around the origin (max |extent| per axis).
 */
export function shapeHalfSize(spec: ShapeSpec): Vec3 {
  const b = shapeLocalBounds(spec);
  return [
    Math.max(Math.abs(b.min[0]), Math.abs(b.max[0])),
    Math.max(Math.abs(b.min[1]), Math.abs(b.max[1])),
    Math.max(Math.abs(b.min[2]), Math.abs(b.max[2])),
  ];
}
