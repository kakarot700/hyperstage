import { bodyKindOf, parseScene, resolveScene } from "@hyperstage/core";
import type { ResolvedScene, SceneAST } from "@hyperstage/core";
import { passCamera } from "./pass-camera.js";
import { passNavmesh } from "./pass-navmesh.js";
import { passOverlap } from "./pass-overlap.js";
import { DEFAULT_TICKS, passPhysics, rollout } from "./pass-physics.js";
import type { RolloutResult } from "./pass-physics.js";
import { getRapier } from "./rapier-loader.js";
import type { LintOptions, LintReport, SpatialDiagnostic } from "./types.js";

const now = (): number => performance.now();
const ms = (value: number): number => Number(value.toFixed(3));

/**
 * Runs the four deterministic passes (E01 overlap, E02 physics rollout,
 * E03 camera occlusion, E04 navigation) and returns a LintReport with telemetry.
 * `elapsedMs` excludes the one-time Rapier WASM initialisation.
 */
export async function lintScene(input: SceneAST | unknown, options: LintOptions = {}): Promise<LintReport> {
  const rapier = await getRapier();
  const ticks = Math.max(1, Math.min(3600, Math.floor(options.ticks ?? DEFAULT_TICKS)));
  const t0 = now();
  const scene = parseScene(input);
  const resolved: ResolvedScene = resolveScene(scene);
  const t1 = now();
  const overlap = passOverlap(resolved);
  const t2 = now();
  const physicsRun: RolloutResult = rollout(rapier, scene, resolved, ticks);
  const physics = passPhysics(resolved, physicsRun);
  const t3 = now();
  const camera = passCamera(resolved);
  const t4 = now();
  const nav = passNavmesh(resolved);
  const t5 = now();
  const diagnostics: SpatialDiagnostic[] = [...overlap, ...physics, ...camera, ...nav.diagnostics];
  return {
    valid: !diagnostics.some((d) => d.severity === "error"),
    elapsedMs: ms(t5 - t0),
    diagnostics,
    frames: physicsRun.frames,
    navPath: nav.navPath,
    telemetry: {
      passMs: { resolve: ms(t1 - t0), overlap: ms(t2 - t1), physics: ms(t3 - t2), camera: ms(t4 - t3), navmesh: ms(t5 - t4) },
      nodeCount: scene.nodes.length,
      geometryCount: resolved.geometry.length,
      dynamicBodyCount: resolved.geometry.filter((g) => bodyKindOf(g.node) === "dynamic").length,
      ticks,
      navCells: nav.cells,
    },
  };
}

export interface SimulationResult {
  ticks: number;
  elapsedMs: number;
  finalTransforms: RolloutResult["finalTransforms"];
  peakSpeeds: Record<string, number>;
  peakAngularSpeeds: Record<string, number>;
  frames: RolloutResult["frames"];
}

/** Runs only the Rapier rollout. */
export async function simulateScene(input: SceneAST | unknown, ticks: number = DEFAULT_TICKS): Promise<SimulationResult> {
  const rapier = await getRapier();
  const t0 = now();
  const scene = parseScene(input);
  const resolved = resolveScene(scene);
  const clamped = Math.max(1, Math.min(3600, Math.floor(ticks)));
  const result = rollout(rapier, scene, resolved, clamped);
  return {
    ticks: clamped,
    elapsedMs: ms(now() - t0),
    finalTransforms: result.finalTransforms,
    peakSpeeds: result.peakSpeeds,
    peakAngularSpeeds: result.peakAngularSpeeds,
    frames: result.frames,
  };
}
