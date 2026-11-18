import type { SceneNodeBase, TriggerAction, Vec3 } from "@hyperstage/core";

export type DiagnosticCode =
  | "E01_INTERPENETRATION"
  | "E02_UNSTABLE_PHYSICS"
  | "E03_CAMERA_OCCLUSION"
  | "E04_UNREACHABLE_GOAL"
  | "E05_BROKEN_JOINT";

/** Suggested joint repair (E05): replaces the listed body-local anchors of `jointId`. */
export interface SuggestedJointFix {
  jointId: string;
  patch: { anchorA?: Vec3; anchorB?: Vec3 };
  rationale: string;
}

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
  /** v2: the joint a diagnostic is about (E05). */
  jointId?: string;
  /** v2: joint-anchor repair for E05 (joints are not nodes, so this is separate from suggestedFix). */
  suggestedJointFix?: SuggestedJointFix;
}

/** Per-tick joint measurement (only present on frames of scenes that declare joints). */
export interface JointFrame {
  /** World-space anchor separation in metres (prismatic: the component off the slide axis). */
  separation: number;
  /** Revolute: hinge angle in radians relative to the initial pose. */
  angleRad?: number;
  /** Prismatic: slide translation in metres along the world axis relative to anchor A. */
  translation?: number;
}

export interface TriggerEvent {
  tick: number;
  triggerId: string;
  action: TriggerAction;
  targetId: string;
  /** The dynamic body whose entry fired the trigger. */
  bodyId: string;
}

export interface FrameSnapshot {
  tick: number;
  timeSec: number;
  transforms: Record<string, { position: Vec3; quaternion: [number, number, number, number] }>;
  /** v2: joint id -> measurement this tick (only for scenes with joints). */
  joints?: Record<string, JointFrame>;
  /** v2: ids of triggers that fired this tick (only on ticks where one fired). */
  triggers?: string[];
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
  /** v2: every trigger firing in tick order (present when the scene declares triggers). */
  triggerEvents?: TriggerEvent[];
  /** v2: goal ids unlocked by unlock_goal triggers during the rollout (present when the scene declares triggers). */
  unlockedGoals?: string[];
  /** v2: non-fatal notes, e.g. a CSG mesh that failed checkManifold and was linted by its bounds. */
  notes?: string[];
}

export interface LintOptions {
  /** Physics rollout length; defaults to 180 ticks (3.0 s at 60 Hz). */
  ticks?: number;
}
