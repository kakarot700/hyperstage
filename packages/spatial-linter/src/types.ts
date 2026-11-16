import type { SceneNodeBase, Vec3 } from "@hyperstage/core";

export type DiagnosticCode =
  | "E01_INTERPENETRATION"
  | "E02_UNSTABLE_PHYSICS"
  | "E03_CAMERA_OCCLUSION"
  | "E04_UNREACHABLE_GOAL";

export interface SpatialDiagnostic {
  code: DiagnosticCode;
  severity: "error" | "warning";
  nodeId: string;
  relatedNodeId?: string;
  message: string;
  metrics: Record<string, number>;
  suggestedFix?: {
    nodeId: string;
    patch: Partial<SceneNodeBase>;
    rationale: string;
  };
}

export interface FrameSnapshot {
  tick: number;
  timeSec: number;
  transforms: Record<string, { position: Vec3; quaternion: [number, number, number, number] }>;
}

export interface LintTelemetry {
  /** Wall-clock milliseconds per pass, measured with performance.now(). */
  passMs: { resolve: number; overlap: number; physics: number; camera: number; navmesh: number };
  nodeCount: number;
  geometryCount: number;
  dynamicBodyCount: number;
  ticks: number;
  navCells: number;
}

export interface LintReport {
  valid: boolean;
  elapsedMs: number;
  diagnostics: SpatialDiagnostic[];
  frames: FrameSnapshot[];
  navPath: Vec3[];
  /** Additive extension: per-pass timing and scene statistics. */
  telemetry: LintTelemetry;
}

export interface LintOptions {
  /** Physics rollout length; defaults to 180 ticks (3.0 s at 60 Hz). */
  ticks?: number;
}
