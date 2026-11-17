import type { CameraNode, ResolvedScene, SceneAST, Vec3 } from "@hyperstage/core";

export type CameraMode = "hero" | "top" | "iso";

export interface CameraPose {
  mode: CameraMode;
  position: Vec3;
  target: Vec3;
  /** Vertical field of view for perspective poses. */
  fov: number;
  /** Half-height of the orthographic frustum for orthographic poses (0 for perspective). */
  orthoHalfHeight: number;
}

export interface SceneBounds {
  center: Vec3;
  min: Vec3;
  max: Vec3;
  radius: number;
}

/** Bounds of every solid; falls back to a 10 m box around the origin for an empty scene. */
export function sceneBounds(resolved: ResolvedScene): SceneBounds {
  if (resolved.geometry.length === 0) return { center: [0, 0, 0], min: [-5, -5, -5], max: [5, 5, 5], radius: 8.66 };
  const min: Vec3 = [Infinity, Infinity, Infinity];
  const max: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (const g of resolved.geometry) {
    for (let i = 0; i < 3; i++) {
      min[i] = Math.min(min[i] ?? Infinity, g.min[i] ?? 0);
      max[i] = Math.max(max[i] ?? -Infinity, g.max[i] ?? 0);
    }
  }
  const center: Vec3 = [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2];
  const radius = Math.max(0.5, Math.hypot(max[0] - min[0], max[1] - min[1], max[2] - min[2]) / 2);
  return { center, min, max, radius };
}

export function heroCamera(scene: SceneAST): CameraNode | undefined {
  return (
    scene.nodes.find((n): n is CameraNode => n.kind === "camera" && n.isHero === true) ??
    scene.nodes.find((n): n is CameraNode => n.kind === "camera")
  );
}

/** Pose for each camera-switcher mode. Hero uses the scene's hero camera when it has one. */
export function cameraPose(mode: CameraMode, scene: SceneAST, resolved: ResolvedScene): CameraPose {
  const b = sceneBounds(resolved);
  if (mode === "hero") {
    const hero = heroCamera(scene);
    if (hero !== undefined) return { mode, position: hero.position, target: hero.target, fov: hero.fov ?? 50, orthoHalfHeight: 0 };
    const d = b.radius * 2.4;
    return { mode, position: [b.center[0] + d * 0.62, b.center[1] + d * 0.5, b.center[2] + d * 0.62], target: b.center, fov: 50, orthoHalfHeight: 0 };
  }
  const distance = b.radius * 4 + 10;
  if (mode === "top") {
    // A hair of +Z keeps OrbitControls' spherical basis away from the pole singularity.
    return { mode, position: [b.center[0], b.max[1] + distance, b.center[2] + 1e-3], target: [b.center[0], b.center[1], b.center[2]], fov: 50, orthoHalfHeight: b.radius * 1.08 };
  }
  // True isometric: 45° azimuth, arctan(1/√2) ≈ 35.264° elevation.
  const k = distance / Math.sqrt(3);
  return { mode, position: [b.center[0] + k, b.center[1] + k, b.center[2] + k], target: b.center, fov: 50, orthoHalfHeight: b.radius * 0.95 };
}

/** Distance that frames a sphere of `radius` in a perspective camera with vertical `fovDeg`. */
export function focusDistance(radius: number, fovDeg: number): number {
  const half = (Math.max(10, Math.min(120, fovDeg)) * Math.PI) / 360;
  return Math.max(1.5, (radius * 1.6) / Math.sin(half));
}

export function easeInOutCubic(t: number): number {
  const x = Math.min(1, Math.max(0, t));
  return x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2;
}
