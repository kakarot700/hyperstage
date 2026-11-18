import { PRESETS } from "@hyperstage/core";
import type { GeometrySpec, SceneAST, ScenePreset } from "@hyperstage/core";

export const EXAMPLE_CATEGORIES = ["game", "robotics", "architecture", "cad"] as const;
export type ExampleCategory = (typeof EXAMPLE_CATEGORIES)[number];

export interface SceneExample {
  id: string;
  category: ExampleCategory;
  title: string;
  description: string;
  /** "preset" = one of the built-in showcase presets; "template" = a small hand-written reference scene. */
  source: "preset" | "template";
  /** Feature tags an agent can scan for (joints, csg, snapTo, triggers, ...). */
  features: string[];
  scene: SceneAST;
}

export function isExampleCategory(value: unknown): value is ExampleCategory {
  return typeof value === "string" && (EXAMPLE_CATEGORIES as readonly string[]).includes(value);
}

/** Categories for presets whose id is known; anything else is classified by `categoryOfPreset`. */
const KNOWN_PRESET_CATEGORIES: Readonly<Record<string, ExampleCategory>> = {
  "broken-tower": "architecture",
  "marble-cascade": "game",
  "parkour-arena": "game",
  "arch-interior": "architecture",
  "cradle-dominoes": "game",
};

/**
 * Category of a preset, in order: an explicit `category` field on the preset (lets later
 * presets tag themselves), the known-id table, keywords in id/title/description, then scene structure.
 */
export function categoryOfPreset(preset: ScenePreset): ExampleCategory {
  if (preset.category !== undefined) return preset.category;
  const known = KNOWN_PRESET_CATEGORIES[preset.id];
  if (known !== undefined) return known;
  const text = `${preset.id} ${preset.title} ${preset.description}`.toLowerCase();
  if (/\b(cad|stl|print|printable|bracket|gear|gearset|planetary|mechanical part|enclosure)\b/.test(text)) return "cad";
  if (/\b(robot|robotics|rover|motor|motorized|arm|gripper|drawbridge|actuator)\b/.test(text)) return "robotics";
  if (/\b(villa|house|building|interior|architect|architectural|room|castle|tower|wall|doorway)\b/.test(text)) return "architecture";
  const scene = preset.scene;
  if (preset.playable || scene.nodes.some((n) => n.kind === "spawn")) return "game";
  if ((scene.joints ?? []).some((j) => (j.type === "revolute" || j.type === "prismatic") && j.motorVelocity !== undefined)) return "robotics";
  if (scene.nodes.some((n) => n.kind === "csg")) return "cad";
  return "game";
}

function addCsgFeatures(spec: GeometrySpec, features: Set<string>): void {
  if (spec.kind !== "csg") return;
  features.add(`csg-${spec.operation}`);
  addCsgFeatures(spec.base, features);
  addCsgFeatures(spec.tool, features);
}

function featuresOf(scene: SceneAST): string[] {
  const features = new Set<string>();
  for (const node of scene.nodes) {
    if (node.kind === "csg") addCsgFeatures(node, features);
    if (node.kind === "spawn" || node.kind === "goal") features.add("spawn-goal");
    if ("snapTo" in node && node.snapTo !== undefined) features.add("snapTo");
    if ("physics" in node && node.physics?.body === "dynamic") features.add("dynamic-bodies");
    if ("material" in node && typeof node.material === "string") features.add("material-presets");
    if (node.kind === "capsule" || node.kind === "torus" || node.kind === "gltf") features.add(node.kind);
  }
  for (const joint of scene.joints ?? []) {
    features.add(`joint-${joint.type}`);
    if ((joint.type === "revolute" || joint.type === "prismatic") && joint.motorVelocity !== undefined) features.add("motor");
  }
  if ((scene.triggers ?? []).length > 0) features.add("triggers");
  return [...features].sort();
}

const VIEW = { id: "hero-cam", kind: "camera", isHero: true } as const;

/** Spawn -> goal obstacle course with 0.4 m step-ups, 0.5 m gaps and a goal-unlock trigger. */
function gameCourse(): SceneAST {
  return {
    name: "Template: Spawn to Goal Course",
    gravity: [0, -9.81, 0],
    skyColor: "#08090A",
    nodes: [
      { id: "ground", kind: "box", size: [24, 0.5, 12], position: [2, -0.25, 0], material: "matte-concrete", physics: { body: "static" } },
      { id: "step-1", kind: "box", size: [2, 0.4, 2], snapTo: { target: "ground", face: "top", offset: [0, 0, 0] }, material: { color: "#6366f1", roughness: 0.4, metalness: 0.2 }, physics: { body: "static" } },
      { id: "step-2", kind: "box", size: [2, 0.8, 2], snapTo: { target: "ground", face: "top", offset: [2.5, 0, 0] }, material: { color: "#22d3ee", roughness: 0.3, metalness: 0.3 }, physics: { body: "static" } },
      { id: "step-3", kind: "box", size: [2, 1.2, 2], snapTo: { target: "ground", face: "top", offset: [5, 0, 0] }, material: { color: "#6366f1", roughness: 0.4, metalness: 0.2 }, physics: { body: "static" } },
      { id: "goal-beacon", kind: "cylinder", radiusTop: 0.15, radiusBottom: 0.15, height: 0.1, snapTo: { target: "step-3", face: "top" }, material: "emissive-cyan", physics: { body: "static" } },
      { id: "crate", kind: "box", size: [0.5, 0.5, 0.5], snapTo: { target: "ground", face: "top", offset: [1, 0, 3] }, material: "warm-oak", physics: { body: "dynamic", mass: 1 } },
      { id: "spawn", kind: "spawn", position: [-6, 0.1, 0] },
      { id: "goal", kind: "goal", position: [5.5, 1.6, 0], radius: 0.6 },
      { id: "sun", kind: "light", position: [4, 14, 8], intensity: 2.4, castShadow: true },
      { ...VIEW, position: [-4, 7, 12], target: [3, 0.8, 0], fov: 50 },
    ],
    triggers: [{ id: "unlock-on-step-2", onEnterNodeId: "step-2", action: "unlock_goal", targetId: "goal" }],
  };
}

/** Two-wheel rover: motorised revolute wheel joints plus a limited revolute hinge for a front scoop. */
function roboticsRover(): SceneAST {
  return {
    name: "Template: Motorized Rover with Hinged Scoop",
    gravity: [0, -9.81, 0],
    skyColor: "#08090A",
    nodes: [
      { id: "ground", kind: "box", size: [20, 0.5, 20], position: [0, -0.25, 0], material: "matte-concrete", physics: { body: "static" } },
      { id: "chassis", kind: "box", size: [1, 0.3, 1.4], position: [0, 0.5, 0], material: "anodized-dark", physics: { body: "dynamic", mass: 6 } },
      { id: "wheel-left", kind: "cylinder", radiusTop: 0.35, radiusBottom: 0.35, height: 0.15, position: [-0.6, 0.35, 0], rotationDeg: [0, 0, 90], material: "brushed-metal", physics: { body: "dynamic", mass: 1, friction: 1.2 } },
      { id: "wheel-right", kind: "cylinder", radiusTop: 0.35, radiusBottom: 0.35, height: 0.15, position: [0.6, 0.35, 0], rotationDeg: [0, 0, 90], material: "brushed-metal", physics: { body: "dynamic", mass: 1, friction: 1.2 } },
      { id: "caster", kind: "sphere", radius: 0.1, position: [0, 0.1, 0.55], material: "ceramic-white", physics: { body: "dynamic", mass: 0.2 } },
      { id: "scoop", kind: "box", size: [0.8, 0.06, 0.5], position: [0, 0.5, -0.96], material: "emissive-amber", physics: { body: "dynamic", mass: 0.5 } },
      { id: "sun", kind: "light", position: [4, 10, 6], intensity: 2.2, castShadow: true },
      { ...VIEW, position: [3.5, 2.5, 4], target: [0, 0.4, 0], fov: 45 },
    ],
    joints: [
      { id: "axle-left", type: "revolute", bodyA: "chassis", bodyB: "wheel-left", anchorA: [-0.6, -0.15, 0], anchorB: [0, 0, 0], axis: [1, 0, 0], motorVelocity: 4, motorMaxForce: 30 },
      { id: "axle-right", type: "revolute", bodyA: "chassis", bodyB: "wheel-right", anchorA: [0.6, -0.15, 0], anchorB: [0, 0, 0], axis: [1, 0, 0], motorVelocity: 4, motorMaxForce: 30 },
      { id: "caster-mount", type: "spherical", bodyA: "chassis", bodyB: "caster", anchorA: [0, -0.4, 0.55], anchorB: [0, 0, 0] },
      { id: "scoop-hinge", type: "revolute", bodyA: "chassis", bodyB: "scoop", anchorA: [0, 0, -0.71], anchorB: [0, 0, 0.25], axis: [1, 0, 0], limitsDeg: [-30, 60] },
    ],
  };
}

/** Exterior wall with a CSG-carved doorway and window, snapped onto a floor slab. */
function architectureWall(): SceneAST {
  return {
    name: "Template: Wall with CSG Doorway",
    gravity: [0, -9.81, 0],
    skyColor: "#08090A",
    nodes: [
      { id: "slab", kind: "box", size: [10, 0.3, 8], position: [0, -0.15, 0], material: "matte-concrete", physics: { body: "static" } },
      {
        id: "front-wall",
        kind: "csg",
        operation: "subtract",
        base: {
          kind: "csg",
          operation: "subtract",
          base: { kind: "box", size: [6, 3, 0.3] },
          tool: { kind: "box", size: [1.2, 2.3, 0.5], position: [-1, -0.45, 0] },
        },
        tool: { kind: "box", size: [1.4, 1, 0.5], position: [1.5, 0.3, 0] },
        snapTo: { target: "slab", face: "top", offset: [0, 0, 2] },
        material: "ceramic-white",
        physics: { body: "static" },
      },
      { id: "back-wall", kind: "box", size: [6, 3, 0.3], snapTo: { target: "slab", face: "top", offset: [0, 0, -2] }, material: "ceramic-white", physics: { body: "static" } },
      { id: "bench", kind: "box", size: [1.6, 0.45, 0.4], snapTo: { target: "slab", face: "top", offset: [0, 0, -1.5] }, material: "warm-oak", physics: { body: "static" } },
      { id: "lamp", kind: "sphere", radius: 0.15, snapTo: { target: "bench", face: "top", offset: [0.5, 0, 0] }, material: "frosted-glass", physics: { body: "static" } },
      { id: "sun", kind: "light", position: [6, 12, 10], intensity: 2.4, castShadow: true },
      { ...VIEW, position: [7, 4.5, 10], target: [0, 1.4, 1], fov: 45 },
    ],
  };
}

/** 60 x 40 x 40 mm L-bracket: union of plate and upright, minus two M6 clearance holes. */
function cadBracket(): SceneAST {
  return {
    name: "Template: CAD L-Bracket",
    gravity: [0, -9.81, 0],
    skyColor: "#08090A",
    nodes: [
      {
        id: "bracket",
        kind: "csg",
        operation: "subtract",
        base: {
          kind: "csg",
          operation: "subtract",
          base: {
            kind: "csg",
            operation: "union",
            base: { kind: "box", size: [0.06, 0.005, 0.04] },
            tool: { kind: "box", size: [0.06, 0.04, 0.005], position: [0, 0.0175, -0.0175] },
          },
          tool: { kind: "cylinder", radiusTop: 0.0032, radiusBottom: 0.0032, height: 0.012, position: [0, 0, 0.006] },
        },
        tool: { kind: "cylinder", radiusTop: 0.0032, radiusBottom: 0.0032, height: 0.012, position: [0, 0.022, -0.0175], rotationDeg: [90, 0, 0] },
        position: [0, 0.0025, 0],
        material: "brushed-metal",
        physics: { body: "static" },
      },
      { id: "key-light", kind: "light", position: [0.2, 0.3, 0.25], intensity: 2, castShadow: true },
      { ...VIEW, position: [0.09, 0.07, 0.1], target: [0, 0.015, 0], fov: 40 },
    ],
  };
}

const TEMPLATES: SceneExample[] = [
  { id: "template-game-course", category: "game", title: "Spawn to goal course", description: "Stepped platforms snapped to the ground, a spawn, a goal and an unlock_goal trigger. Every step-up is 0.4 m and every gap 0.5 m, so E04 finds a path.", source: "template", features: [], scene: gameCourse() },
  { id: "template-robotics-rover", category: "robotics", title: "Motorized rover with hinged scoop", description: "Revolute wheel joints with motorVelocity/motorMaxForce, a spherical caster mount and a revolute hinge with limitsDeg. Anchors are body-local; axis is in bodyA's frame.", source: "template", features: [], scene: roboticsRover() },
  { id: "template-architecture-doorway", category: "architecture", title: "Wall with CSG doorway", description: "A front wall carved by nested csg subtract (doorway + window), snapped to a floor slab, with ceramic, oak, glass and concrete material presets.", source: "template", features: [], scene: architectureWall() },
  { id: "template-cad-bracket", category: "cad", title: "CAD L-bracket", description: "Millimetre-scale bracket: csg union of plate + upright, then two csg subtract clearance holes. Exports watertight to .stl via hyperstage_export_cad.", source: "template", features: [], scene: cadBracket() },
];

/** Every built-in preset (categorised automatically) followed by the hand-written templates. */
export function listExamples(category?: ExampleCategory): SceneExample[] {
  const fromPresets: SceneExample[] = PRESETS.map((preset) => ({
    id: preset.id,
    category: categoryOfPreset(preset),
    title: preset.title,
    description: preset.description,
    source: "preset",
    features: [],
    scene: preset.scene,
  }));
  return [...fromPresets, ...TEMPLATES]
    .filter((example) => category === undefined || example.category === category)
    .map((example) => ({ ...example, features: featuresOf(example.scene), scene: structuredClone(example.scene) }));
}
