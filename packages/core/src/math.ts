import type { Quat, Vec3 } from "./schema.js";

export const DEG2RAD = Math.PI / 180;

export function add(a: Vec3, b: Vec3): Vec3 {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}

export function sub(a: Vec3, b: Vec3): Vec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

export function scale(a: Vec3, s: number): Vec3 {
  return [a[0] * s, a[1] * s, a[2] * s];
}

export function dot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

export function cross(a: Vec3, b: Vec3): Vec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

export function length(a: Vec3): number {
  return Math.sqrt(dot(a, a));
}

export function distance(a: Vec3, b: Vec3): number {
  return length(sub(a, b));
}

export function normalize(a: Vec3): Vec3 {
  const len = length(a);
  return len > 1e-12 ? scale(a, 1 / len) : [0, 0, 0];
}

export function component(v: Vec3, axis: number): number {
  return axis === 0 ? v[0] : axis === 1 ? v[1] : v[2];
}

export function withComponent(v: Vec3, axis: number, value: number): Vec3 {
  return axis === 0 ? [value, v[1], v[2]] : axis === 1 ? [v[0], value, v[2]] : [v[0], v[1], value];
}

/** Rounds to micrometre precision so resolved coordinates are stable across platforms. */
export function round6(value: number): number {
  const rounded = Math.round(value * 1e6) / 1e6;
  return Object.is(rounded, -0) ? 0 : rounded;
}

export function roundVec(v: Vec3): Vec3 {
  return [round6(v[0]), round6(v[1]), round6(v[2])];
}

export const IDENTITY_QUAT: Quat = [0, 0, 0, 1];

/** Euler (degrees, intrinsic XYZ order, matching three.js) to quaternion [x, y, z, w]. */
export function quatFromEulerDeg(euler: Vec3): Quat {
  const hx = (euler[0] * DEG2RAD) / 2;
  const hy = (euler[1] * DEG2RAD) / 2;
  const hz = (euler[2] * DEG2RAD) / 2;
  const c1 = Math.cos(hx);
  const c2 = Math.cos(hy);
  const c3 = Math.cos(hz);
  const s1 = Math.sin(hx);
  const s2 = Math.sin(hy);
  const s3 = Math.sin(hz);
  return [
    s1 * c2 * c3 + c1 * s2 * s3,
    c1 * s2 * c3 - s1 * c2 * s3,
    c1 * c2 * s3 + s1 * s2 * c3,
    c1 * c2 * c3 - s1 * s2 * s3,
  ];
}

export function quatMultiply(a: Quat, b: Quat): Quat {
  const [ax, ay, az, aw] = a;
  const [bx, by, bz, bw] = b;
  return [
    ax * bw + aw * bx + ay * bz - az * by,
    ay * bw + aw * by + az * bx - ax * bz,
    az * bw + aw * bz + ax * by - ay * bx,
    aw * bw - ax * bx - ay * by - az * bz,
  ];
}

/** Columns of the rotation matrix: the body's local X, Y and Z axes in world space. */
export function quatAxes(q: Quat): [Vec3, Vec3, Vec3] {
  const [x, y, z, w] = q;
  const x2 = x + x;
  const y2 = y + y;
  const z2 = z + z;
  const xx = x * x2;
  const xy = x * y2;
  const xz = x * z2;
  const yy = y * y2;
  const yz = y * z2;
  const zz = z * z2;
  const wx = w * x2;
  const wy = w * y2;
  const wz = w * z2;
  return [
    [1 - (yy + zz), xy + wz, xz - wy],
    [xy - wz, 1 - (xx + zz), yz + wx],
    [xz + wy, yz - wx, 1 - (xx + yy)],
  ];
}

export function rotateVec(q: Quat, v: Vec3): Vec3 {
  const [ax, ay, az] = quatAxes(q);
  return [
    ax[0] * v[0] + ay[0] * v[1] + az[0] * v[2],
    ax[1] * v[0] + ay[1] * v[1] + az[1] * v[2],
    ax[2] * v[0] + ay[2] * v[1] + az[2] * v[2],
  ];
}

/** World-space AABB half extents of an oriented box with local half sizes `half`. */
export function orientedHalfExtents(q: Quat, half: Vec3): Vec3 {
  const [ax, ay, az] = quatAxes(q);
  return [
    Math.abs(ax[0]) * half[0] + Math.abs(ay[0]) * half[1] + Math.abs(az[0]) * half[2],
    Math.abs(ax[1]) * half[0] + Math.abs(ay[1]) * half[1] + Math.abs(az[1]) * half[2],
    Math.abs(ax[2]) * half[0] + Math.abs(ay[2]) * half[1] + Math.abs(az[2]) * half[2],
  ];
}

/** Angle in degrees between the body's local up axis and world +Y. */
export function tiltDegrees(q: Quat): number {
  const up = quatAxes(q)[1];
  const cos = Math.min(1, Math.max(-1, up[1]));
  return Math.acos(cos) / DEG2RAD;
}
