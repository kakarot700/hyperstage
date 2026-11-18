import { aabbClearance, bodyKindOf, exportGlb, exportStl, parseSceneJson, resolveScene, round6 } from "@hyperstage/core";
import type { SceneAST, Vec3 } from "@hyperstage/core";
import { computeNavigation, findSpawnGoal, lintScene, simulateScene } from "@hyperstage/spatial-linter";
import type { LintReport, SpatialDiagnostic } from "@hyperstage/spatial-linter";
import { listExamples } from "./examples.js";
import type { ExampleCategory, SceneExample } from "./examples.js";
import { bytesToBase64, exportSceneHtml } from "./html-exporter.js";
import type { ThreeSources } from "./html-exporter.js";

export interface CompileAndLintResult {
  [key: string]: unknown;
  summary: {
    scene: string;
    valid: boolean;
    elapsedMs: number;
    errorCount: number;
    warningCount: number;
    frameCount: number;
    navPathLength: number;
    codes: string[];
  };
  diagnostics: SpatialDiagnostic[];
  navPath: Vec3[];
  telemetry: LintReport["telemetry"];
}

export async function compileAndLint(sceneJson: string): Promise<CompileAndLintResult> {
  const scene = parseSceneJson(sceneJson);
  const report = await lintScene(scene);
  return {
    summary: {
      scene: scene.name,
      valid: report.valid,
      elapsedMs: report.elapsedMs,
      errorCount: report.diagnostics.filter((d) => d.severity === "error").length,
      warningCount: report.diagnostics.filter((d) => d.severity === "warning").length,
      frameCount: report.frames.length,
      navPathLength: report.navPath.length,
      codes: [...new Set(report.diagnostics.map((d) => d.code))],
    },
    diagnostics: report.diagnostics,
    navPath: report.navPath,
    telemetry: report.telemetry,
  };
}

export interface BoundsEntry {
  id: string;
  kind: string;
  body: string;
  center: Vec3;
  halfExtents: Vec3;
  min: Vec3;
  max: Vec3;
}

export interface ClearanceEntry {
  a: string;
  b: string;
  /** Surface clearance in metres; negative values are penetration depth. */
  clearanceMeters: number;
  touching: boolean;
}

export interface InspectBoundsResult {
  [key: string]: unknown;
  scene: string;
  bounds: BoundsEntry[];
  clearances: ClearanceEntry[];
  topologicalOrder: string[];
}

export function inspectBounds(sceneJson: string, maxPairs = 2000): InspectBoundsResult {
  const scene = parseSceneJson(sceneJson);
  const resolved = resolveScene(scene);
  const r = (v: Vec3): Vec3 => [round6(v[0]), round6(v[1]), round6(v[2])];
  const bounds = resolved.geometry.map((g) => ({
    id: g.id,
    kind: g.node.kind,
    body: bodyKindOf(g.node),
    center: r(g.center),
    halfExtents: r(g.halfExtents),
    min: r(g.min),
    max: r(g.max),
  }));
  const clearances: ClearanceEntry[] = [];
  const geometry = resolved.geometry;
  for (let i = 0; i < geometry.length && clearances.length < maxPairs; i++) {
    for (let j = i + 1; j < geometry.length && clearances.length < maxPairs; j++) {
      const a = geometry[i];
      const b = geometry[j];
      if (a === undefined || b === undefined) continue;
      const clearance = round6(aabbClearance(a, b));
      clearances.push({ a: a.id, b: b.id, clearanceMeters: clearance, touching: Math.abs(clearance) <= 0.002 });
    }
  }
  clearances.sort((x, y) => x.clearanceMeters - y.clearanceMeters);
  return { scene: scene.name, bounds, clearances, topologicalOrder: resolved.topologicalOrder };
}

export interface SimulatePhysicsResult {
  [key: string]: unknown;
  ticks: number;
  timeSec: number;
  elapsedMs: number;
  finalTransforms: Record<string, { position: Vec3; quaternion: [number, number, number, number] }>;
  peakVelocities: Record<string, { linear: number; angular: number }>;
}

export async function simulatePhysics(sceneJson: string, ticks: number): Promise<SimulatePhysicsResult> {
  const scene = parseSceneJson(sceneJson);
  const sim = await simulateScene(scene, ticks);
  const peakVelocities: SimulatePhysicsResult["peakVelocities"] = {};
  for (const id of Object.keys(sim.peakSpeeds)) {
    peakVelocities[id] = {
      linear: round6(sim.peakSpeeds[id] ?? 0),
      angular: round6(sim.peakAngularSpeeds[id] ?? 0),
    };
  }
  return {
    ticks: sim.ticks,
    timeSec: round6(sim.ticks / 60),
    elapsedMs: sim.elapsedMs,
    finalTransforms: sim.finalTransforms,
    peakVelocities,
  };
}

export interface PlayabilityResult {
  [key: string]: unknown;
  reachable: boolean;
  pathLengthMeters: number;
  waypoints: Vec3[];
  closestReachable: Vec3 | null;
}

export class MissingSpawnGoalError extends Error {
  constructor() {
    super("Scene needs exactly one spawn node and one goal node to test playability");
    this.name = "MissingSpawnGoalError";
  }
}

export function testPlayability(sceneJson: string): PlayabilityResult {
  const scene = parseSceneJson(sceneJson);
  const resolved = resolveScene(scene);
  const pair = findSpawnGoal(resolved);
  if (pair === null) throw new MissingSpawnGoalError();
  const nav = computeNavigation(resolved, pair.spawn, pair.goal);
  return {
    reachable: nav.reachable,
    pathLengthMeters: nav.pathLengthMeters,
    waypoints: nav.waypoints,
    closestReachable: nav.closestReachable,
  };
}

export interface ExportHtmlResult {
  [key: string]: unknown;
  title: string;
  bytes: number;
  frameCount: number;
  html: string;
}

export async function exportHtml(sceneJson: string, three: ThreeSources, title?: string): Promise<ExportHtmlResult> {
  const scene: SceneAST = parseSceneJson(sceneJson);
  const report = await lintScene(scene);
  const finalTitle = title ?? scene.name;
  const html = exportSceneHtml({ scene, frames: report.frames, navPath: report.navPath, title: finalTitle, three });
  return { title: finalTitle, bytes: new TextEncoder().encode(html).length, frameCount: report.frames.length, html };
}

export const CAD_FORMATS = ["glb", "stl"] as const;
export type CadFormat = (typeof CAD_FORMATS)[number];

export const CAD_MIME_TYPES: Readonly<Record<CadFormat, string>> = {
  glb: "model/gltf-binary",
  stl: "model/stl",
};

export interface ExportCadResult {
  [key: string]: unknown;
  scene: string;
  format: CadFormat;
  mimeType: string;
  encoding: "base64";
  /** The binary file, base64-encoded. */
  data: string;
  bytes: number;
  triangles: number;
  vertices: number;
  meshes: number;
  /** Overall extents in millimetres, in the file's axis order (GLB: Y-up; STL: Z-up). */
  boundsMm: Vec3;
}

/** Exports every geometry node as a binary glTF 2.0 (.glb, Y-up, metres) or binary STL (Z-up, millimetres). */
export function exportCad(sceneJson: string, format: CadFormat): ExportCadResult {
  const scene = parseSceneJson(sceneJson);
  const result = format === "glb" ? exportGlb(scene) : exportStl(scene);
  return {
    scene: scene.name,
    format,
    mimeType: CAD_MIME_TYPES[format],
    encoding: "base64",
    data: bytesToBase64(result.bytes),
    bytes: result.bytes.length,
    triangles: result.stats.triangles,
    vertices: result.stats.vertices,
    meshes: result.stats.meshes,
    boundsMm: result.stats.boundsMm,
  };
}

export interface GetExamplesResult {
  [key: string]: unknown;
  category: ExampleCategory | null;
  count: number;
  examples: SceneExample[];
}

/** Canonical SceneAST templates: every built-in preset (auto-categorised) plus one hand-written template per category. */
export function getExamples(category?: ExampleCategory): GetExamplesResult {
  const examples = listExamples(category);
  return { category: category ?? null, count: examples.length, examples };
}
