export * from "./types.js";
export { getRapier } from "./rapier-loader.js";
export type { RapierModule } from "./rapier-loader.js";
export { passOverlap, translatePatch, OVERLAP_TOLERANCE_M } from "./pass-overlap.js";
export {
  passPhysics,
  rollout,
  nearestSurfaceBelow,
  snapOntoPatch,
  PHYSICS_DT,
  DEFAULT_TICKS,
  VOID_Y,
  DRIFT_LIMIT_M,
  TIP_LIMIT_DEG,
  passJoints,
  worldAnchors,
  measureJoint,
  alignedAnchorB,
  JOINT_SEPARATION_LIMIT_M,
  TRIGGER_TOLERANCE_M,
} from "./pass-physics.js";
export type { RolloutResult, JointStats } from "./pass-physics.js";
export { passCamera, measureOcclusion, CAMERA_GRID, OCCLUSION_LIMIT } from "./pass-camera.js";
export type { OcclusionResult } from "./pass-camera.js";
export {
  passNavmesh,
  computeNavigation,
  findSpawnGoal,
  NAV_CELL_M,
  NAV_CLEARANCE_M,
  NAV_STEP_M,
  NAV_JUMP_M,
  JUMP_TORSO_M,
} from "./pass-navmesh.js";
export type { NavResult } from "./pass-navmesh.js";
export {
  contact,
  shapeOf,
  segmentAabb,
  meshesIntersect,
  meshContact,
  segmentMesh,
  meshColumnSpans,
  meshFallbackNotes,
} from "./geometry.js";
export type { Shape, Contact } from "./geometry.js";
export { lintScene, simulateScene } from "./linter.js";
export type { SimulationResult } from "./linter.js";
export { autoFixScene, MAX_FIX_PASSES } from "./auto-fixer.js";
export type { AutoFixResult, AppliedFix } from "./auto-fixer.js";
