import type { ResolvedScene, SceneAST, SceneNode, Vec3 } from "@hyperstage/core";
import type { LintReport } from "@hyperstage/spatial-linter";

export type TreeIcon = "box" | "sphere" | "cylinder" | "ramp" | "camera" | "light" | "spawn" | "goal";

export interface TreeRow {
  id: string;
  kind: SceneNode["kind"];
  icon: TreeIcon;
  /** Nesting depth along the snapTo chain (roots are 0). */
  depth: number;
  /** The node this one is snapped to, if any. */
  snapTarget: string | null;
  snapFace: string | null;
  /** Number of nodes snapped directly onto this one. */
  childCount: number;
  /** Diagnostic codes (E01..E04) that name this node. */
  errors: string[];
}

/**
 * Flattens the scene into an outliner: geometry is nested under its snapTo target
 * (depth-first, authored order among siblings); cameras, lights, spawns and goals follow.
 */
export function buildSceneTree(scene: SceneAST, report: LintReport | null): TreeRow[] {
  const errors = new Map<string, string[]>();
  for (const d of report?.diagnostics ?? []) {
    const code = d.code.slice(0, 3);
    for (const id of [d.nodeId, d.relatedNodeId]) {
      if (id === undefined) continue;
      if (id === d.relatedNodeId && d.code !== "E01_INTERPENETRATION") continue;
      const list = errors.get(id) ?? [];
      if (!list.includes(code)) list.push(code);
      errors.set(id, list);
    }
  }
  const ids = new Set(scene.nodes.map((n) => n.id));
  const children = new Map<string, SceneNode[]>();
  const roots: SceneNode[] = [];
  for (const node of scene.nodes) {
    const target = "snapTo" in node ? node.snapTo?.target : undefined;
    if (target !== undefined && ids.has(target) && target !== node.id) {
      const list = children.get(target) ?? [];
      list.push(node);
      children.set(target, list);
    } else roots.push(node);
  }
  const rows: TreeRow[] = [];
  const visited = new Set<string>();
  const visit = (node: SceneNode, depth: number) => {
    if (visited.has(node.id)) return;
    visited.add(node.id);
    const snap = "snapTo" in node ? node.snapTo : undefined;
    rows.push({
      id: node.id,
      kind: node.kind,
      icon: node.kind,
      depth,
      snapTarget: snap?.target ?? null,
      snapFace: snap?.face ?? null,
      childCount: children.get(node.id)?.length ?? 0,
      errors: errors.get(node.id) ?? [],
    });
    for (const child of children.get(node.id) ?? []) visit(child, depth + 1);
  };
  const geometryFirst = [...roots].sort((a, b) => rank(a) - rank(b));
  for (const root of geometryFirst) visit(root, 0);
  // Nodes inside a snapTo cycle are never reached from a root; list them flat so nothing hides.
  for (const node of scene.nodes) visit(node, 0);
  return rows;
}

function rank(node: SceneNode): number {
  switch (node.kind) {
    case "box":
    case "sphere":
    case "cylinder":
    case "ramp":
      return 0;
    case "spawn":
    case "goal":
      return 1;
    case "camera":
      return 2;
    case "light":
      return 3;
  }
}

export interface NodeInspection {
  id: string;
  kind: SceneNode["kind"];
  center: Vec3 | null;
  min: Vec3 | null;
  max: Vec3 | null;
  size: Vec3 | null;
  body: "static" | "dynamic" | "kinematic" | "none";
  mass: number | null;
  snap: string | null;
  /** Position at the current timeline frame (dynamic bodies only). */
  framePosition: Vec3 | null;
  /** Displacement of the body from its authored rest pose at the current frame. */
  displacement: number | null;
  /** Speed at the current frame in m/s, from the neighbouring frames. */
  speed: number | null;
  diagnostics: string[];
}

const round3 = (v: number): number => Math.round(v * 1000) / 1000;
const r3 = (v: Vec3): Vec3 => [round3(v[0]), round3(v[1]), round3(v[2])];

/** Resolved world bounds plus live physics state for the Properties Inspector. */
export function inspectNode(
  scene: SceneAST,
  resolved: ResolvedScene,
  report: LintReport | null,
  nodeId: string,
  frameIndex: number,
): NodeInspection | null {
  const node = scene.nodes.find((n) => n.id === nodeId);
  if (node === undefined) return null;
  const geometry = resolved.byId.get(nodeId);
  const physics = "physics" in node ? node.physics : undefined;
  const isGeometry = geometry !== undefined;
  const body = isGeometry ? (physics?.body ?? "static") : "none";
  const frames = report?.frames ?? [];
  const at = frames[Math.min(Math.max(0, frameIndex), Math.max(0, frames.length - 1))]?.transforms[nodeId];
  let speed: number | null = null;
  if (at !== undefined) {
    const prevIndex = Math.max(0, frameIndex - 1);
    const prev = frames[prevIndex]?.transforms[nodeId];
    if (prev !== undefined && prevIndex !== frameIndex) {
      speed = round3(Math.hypot(at.position[0] - prev.position[0], at.position[1] - prev.position[1], at.position[2] - prev.position[2]) * 60);
    } else speed = 0;
  }
  const snap = "snapTo" in node && node.snapTo !== undefined ? `${node.snapTo.target}.${node.snapTo.face}` : null;
  return {
    id: node.id,
    kind: node.kind,
    center: geometry !== undefined ? r3(geometry.center) : "position" in node && node.position !== undefined ? r3(node.position) : null,
    min: geometry !== undefined ? r3(geometry.min) : null,
    max: geometry !== undefined ? r3(geometry.max) : null,
    size: geometry !== undefined ? r3([geometry.max[0] - geometry.min[0], geometry.max[1] - geometry.min[1], geometry.max[2] - geometry.min[2]]) : null,
    body,
    mass: physics?.mass ?? null,
    snap,
    framePosition: at !== undefined ? r3(at.position) : null,
    displacement:
      at !== undefined && geometry !== undefined
        ? round3(Math.hypot(at.position[0] - geometry.center[0], at.position[1] - geometry.center[1], at.position[2] - geometry.center[2]))
        : null,
    speed,
    diagnostics: (report?.diagnostics ?? []).filter((d) => d.nodeId === nodeId || (d.code === "E01_INTERPENETRATION" && d.relatedNodeId === nodeId)).map((d) => d.code),
  };
}
