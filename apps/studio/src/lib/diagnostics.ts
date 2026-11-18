import type { SpatialDiagnostic } from "@hyperstage/spatial-linter";

export interface MetricReadout {
  label: string;
  value: string;
}

const m = (value: number): string => `${value.toFixed(3)}m`;

/** The one headline metric per diagnostic class, e.g. `overlap: 0.340m` or `occluded: 82%`. */
export function primaryMetric(d: SpatialDiagnostic): MetricReadout | null {
  const x = d.metrics;
  switch (d.code) {
    case "E01_INTERPENETRATION":
      return x.penetrationMeters !== undefined ? { label: "overlap", value: m(x.penetrationMeters) } : null;
    case "E02_UNSTABLE_PHYSICS":
      if (x.minY !== undefined && x.minY < -15) return { label: "fell to", value: `${x.minY.toFixed(2)}m` };
      if (x.driftMeters !== undefined && x.driftMeters > 0.5) return { label: "drift", value: m(x.driftMeters) };
      if (x.maxTiltDeg !== undefined) return { label: "tilt", value: `${x.maxTiltDeg.toFixed(1)}°` };
      return null;
    case "E03_CAMERA_OCCLUSION":
      return x.occlusionRatio !== undefined ? { label: "occluded", value: `${Math.round(x.occlusionRatio * 100)}%` } : null;
    case "E04_UNREACHABLE_GOAL":
      if (x.distanceToGoal !== undefined) return { label: "gap", value: m(x.distanceToGoal) };
      return x.navCells !== undefined ? { label: "nav cells", value: String(x.navCells) } : null;
    case "E05_BROKEN_JOINT":
      return x.maxSeparation !== undefined ? { label: "anchor gap", value: m(x.maxSeparation) } : null;
  }
}

/** Remaining metrics as compact chips (the headline metric is excluded). */
export function secondaryMetrics(d: SpatialDiagnostic): MetricReadout[] {
  const headline: Record<SpatialDiagnostic["code"], string[]> = {
    E01_INTERPENETRATION: ["penetrationMeters"],
    E02_UNSTABLE_PHYSICS: [],
    E03_CAMERA_OCCLUSION: ["occlusionRatio"],
    E04_UNREACHABLE_GOAL: ["distanceToGoal"],
    E05_BROKEN_JOINT: ["maxSeparation"],
  };
  const skip = new Set(headline[d.code]);
  return Object.entries(d.metrics)
    .filter(([key]) => !skip.has(key))
    .map(([key, value]) => ({
      label: key,
      value: Math.abs(value) >= 100 ? value.toFixed(0) : Math.abs(value) >= 1 ? value.toFixed(2) : value.toFixed(3),
    }));
}

/** Node ids a diagnostic is about: the subject, plus the related node for overlaps and supports. */
export function diagnosticNodes(d: SpatialDiagnostic): string[] {
  const ids = [d.nodeId];
  if (d.relatedNodeId !== undefined && d.relatedNodeId !== d.nodeId) ids.push(d.relatedNodeId);
  return ids;
}

export const SHORT_TITLE: Record<SpatialDiagnostic["code"], string> = {
  E01_INTERPENETRATION: "Interpenetration",
  E02_UNSTABLE_PHYSICS: "Unstable physics",
  E03_CAMERA_OCCLUSION: "Camera occlusion",
  E04_UNREACHABLE_GOAL: "Unreachable goal",
  E05_BROKEN_JOINT: "Broken joint",
};
