import { add, roundVec, scale, sub } from "@hyperstage/core";
import type { CameraNode, ResolvedGeometry, ResolvedScene, Vec3 } from "@hyperstage/core";
import { lookBasis, pointAabbDistance, segmentAabb } from "./geometry.js";
import type { SpatialDiagnostic } from "./types.js";

export const CAMERA_GRID = 5;
export const OCCLUSION_LIMIT = 0.4;

export interface OcclusionResult {
  subjectId: string | null;
  blockedRays: number;
  totalRays: number;
  /** Occluder id -> number of rays it blocked first. */
  occluders: Map<string, number>;
}

function nearestSubject(geometry: ResolvedGeometry[], target: Vec3): ResolvedGeometry | null {
  let best: ResolvedGeometry | null = null;
  let bestDist = Infinity;
  let bestVolume = Infinity;
  for (const g of geometry) {
    const d = pointAabbDistance(target, g.min, g.max);
    const volume = g.halfExtents[0] * g.halfExtents[1] * g.halfExtents[2];
    if (d < bestDist - 1e-9 || (Math.abs(d - bestDist) <= 1e-9 && volume < bestVolume)) {
      best = g;
      bestDist = d;
      bestVolume = volume;
    }
  }
  return best;
}

/** Casts a 5x5 grid of rays from `eye` across the subject's bounding box and counts AABB-occluded rays. */
export function measureOcclusion(geometry: ResolvedGeometry[], eye: Vec3, target: Vec3): OcclusionResult {
  const subject = nearestSubject(geometry, target);
  const occluders = new Map<string, number>();
  if (subject === null) return { subjectId: null, blockedRays: 0, totalRays: 0, occluders };
  const { right, up } = lookBasis(eye, subject.center);
  const h = subject.halfExtents;
  const extentRight = Math.abs(right[0]) * h[0] + Math.abs(right[1]) * h[1] + Math.abs(right[2]) * h[2];
  const extentUp = Math.abs(up[0]) * h[0] + Math.abs(up[1]) * h[1] + Math.abs(up[2]) * h[2];
  const inset: Vec3 = scale(h, 0.98);
  const lo = sub(subject.center, inset);
  const hi = add(subject.center, inset);
  let blocked = 0;
  for (let i = 0; i < CAMERA_GRID; i++) {
    for (let j = 0; j < CAMERA_GRID; j++) {
      const u = (i / (CAMERA_GRID - 1) - 0.5) * 2 * 0.9;
      const v = (j / (CAMERA_GRID - 1) - 0.5) * 2 * 0.9;
      const raw = add(subject.center, add(scale(right, u * extentRight), scale(up, v * extentUp)));
      const sample: Vec3 = [
        Math.min(hi[0], Math.max(lo[0], raw[0])),
        Math.min(hi[1], Math.max(lo[1], raw[1])),
        Math.min(hi[2], Math.max(lo[2], raw[2])),
      ];
      const delta = sub(sample, eye);
      let firstT = Infinity;
      let firstId: string | null = null;
      for (const g of geometry) {
        if (g.id === subject.id) continue;
        const shrinkMin = add(g.min, [1e-4, 1e-4, 1e-4]);
        const shrinkMax = sub(g.max, [1e-4, 1e-4, 1e-4]);
        const t = segmentAabb(eye, delta, shrinkMin, shrinkMax);
        if (t !== null && t < 0.999 && t < firstT) {
          firstT = t;
          firstId = g.id;
        }
      }
      if (firstId !== null) {
        blocked++;
        occluders.set(firstId, (occluders.get(firstId) ?? 0) + 1);
      }
    }
  }
  return { subjectId: subject.id, blockedRays: blocked, totalRays: CAMERA_GRID * CAMERA_GRID, occluders };
}

/** Pass 3 (E03_CAMERA_OCCLUSION). */
export function passCamera(resolved: ResolvedScene): SpatialDiagnostic[] {
  const diagnostics: SpatialDiagnostic[] = [];
  const cameras = resolved.scene.nodes.filter((n): n is CameraNode => n.kind === "camera");
  for (const camera of cameras) {
    const result = measureOcclusion(resolved.geometry, camera.position, camera.target);
    if (result.totalRays === 0 || result.subjectId === null) continue;
    const ratio = result.blockedRays / result.totalRays;
    if (ratio <= OCCLUSION_LIMIT) continue;
    let occluder = "";
    let occluderCount = -1;
    for (const [id, count] of result.occluders) {
      if (count > occluderCount) {
        occluder = id;
        occluderCount = count;
      }
    }
    let fixPosition: Vec3 | null = null;
    let fixRatio = ratio;
    for (let dy = 1; dy <= 60; dy++) {
      const candidate: Vec3 = roundVec([camera.position[0], camera.position[1] + dy, camera.position[2]]);
      const probe = measureOcclusion(resolved.geometry, candidate, camera.target);
      const r = probe.totalRays === 0 ? 0 : probe.blockedRays / probe.totalRays;
      if (r <= OCCLUSION_LIMIT) {
        fixPosition = candidate;
        fixRatio = r;
        break;
      }
    }
    const diagnostic: SpatialDiagnostic = {
      code: "E03_CAMERA_OCCLUSION",
      severity: "error",
      nodeId: camera.id,
      relatedNodeId: occluder,
      message: `Camera "${camera.id}" has ${result.blockedRays}/${result.totalRays} rays to "${result.subjectId}" blocked (mostly by "${occluder}")`,
      metrics: {
        blockedRays: result.blockedRays,
        totalRays: result.totalRays,
        occlusionRatio: Number(ratio.toFixed(4)),
      },
    };
    if (fixPosition !== null) {
      diagnostic.metrics.fixedOcclusionRatio = Number(fixRatio.toFixed(4));
      diagnostic.suggestedFix = {
        nodeId: camera.id,
        patch: { position: fixPosition },
        rationale: `Elevate camera "${camera.id}" by ${(fixPosition[1] - camera.position[1]).toFixed(0)} m so at most 40% of rays to "${result.subjectId}" are occluded.`,
      };
    }
    diagnostics.push(diagnostic);
  }
  return diagnostics;
}
