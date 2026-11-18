import { csgVilla, motorizedRover, planetaryGearset } from "./presets-v2.js";
import type { SceneAST, SceneNode, Vec3 } from "./schema.js";

export interface ScenePreset {
  id: string;
  index: number;
  title: string;
  description: string;
  playable: boolean;
  /** v2: showcase category used by `hyperstage_get_examples` (game, robotics, architecture, cad). */
  category?: "game" | "robotics" | "architecture" | "cad";
  scene: SceneAST;
}

const STONE = { color: "#8a8f98", roughness: 0.9, metalness: 0.05 };
const STONE_DARK = { color: "#5b6170", roughness: 0.95, metalness: 0.05 };
const GROUND = { color: "#1b1f27", roughness: 1, metalness: 0 };
const INDIGO = { color: "#6366f1", roughness: 0.4, metalness: 0.2 };
const CYAN = { color: "#22d3ee", roughness: 0.3, metalness: 0.3 };
const AMBER = { color: "#f59e0b", roughness: 0.5, metalness: 0.1 };
const CHROME = { color: "#d4d8e0", roughness: 0.15, metalness: 0.9 };
const WOOD = { color: "#8b5a2b", roughness: 0.7, metalness: 0 };
const PLASTER = { color: "#d9d4c7", roughness: 0.95, metalness: 0 };

const dynamic = (mass?: number) => (mass === undefined ? { body: "dynamic" as const } : { body: "dynamic" as const, mass });
const fixed = { body: "static" as const };

/** 1. Broken Tower: three deliberate spatial bugs (2x E01, 1x E02) that autoFixScene repairs into a castle. */
function brokenTower(): SceneAST {
  const towers: SceneNode[] = (
    [
      ["tower-nw", -5, -5],
      ["tower-ne", 5, -5],
      ["tower-sw", -5, 5],
      ["tower-se", 5, 5],
    ] as const
  ).map(([id, x, z]) => ({
    id,
    kind: "cylinder",
    radiusTop: 1,
    radiusBottom: 1,
    height: 4,
    snapTo: { target: "ground", face: "top", offset: [x, 0, z] },
    material: STONE_DARK,
    physics: fixed,
  }));
  const merlons: SceneNode[] = (
    [
      ["merlon-a", -0.6, -0.6],
      ["merlon-b", 0.6, -0.6],
      ["merlon-c", -0.6, 0.6],
      ["merlon-d", 0.6, 0.6],
    ] as const
  ).map(([id, x, z]) => ({
    id,
    kind: "box",
    size: [0.4, 0.4, 0.4],
    snapTo: { target: "block-4", face: "top", offset: [x, 0, z] },
    material: INDIGO,
    physics: dynamic(0.2),
  }));
  return {
    name: "Broken Tower -> Auto-Fixed Castle",
    gravity: [0, -9.81, 0],
    skyColor: "#08090A",
    nodes: [
      { id: "ground", kind: "box", size: [20, 0.5, 20], position: [0, -0.25, 0], material: GROUND, physics: fixed },
      ...towers,
      { id: "wall-north", kind: "box", size: [8, 2.5, 0.8], snapTo: { target: "ground", face: "top", offset: [0, 0, -5] }, material: STONE, physics: fixed },
      { id: "wall-south", kind: "box", size: [8, 2.5, 0.8], snapTo: { target: "ground", face: "top", offset: [0, 0, 5] }, material: STONE, physics: fixed },
      { id: "wall-west", kind: "box", size: [0.8, 2.5, 8], snapTo: { target: "ground", face: "top", offset: [-5, 0, 0] }, material: STONE, physics: fixed },
      { id: "wall-east", kind: "box", size: [0.8, 2.5, 8], snapTo: { target: "ground", face: "top", offset: [5, 0, 0] }, material: STONE, physics: fixed },
      // BUG 1 (E01): gatehouse sunk 0.30 m into the ground slab.
      { id: "gatehouse", kind: "box", size: [3, 3, 2], position: [0, 1.2, 7], material: STONE, physics: fixed },
      { id: "plinth", kind: "box", size: [3, 0.5, 3], snapTo: { target: "ground", face: "top" }, material: STONE_DARK, physics: fixed },
      { id: "block-1", kind: "box", size: [2, 1, 2], snapTo: { target: "plinth", face: "top" }, material: STONE, physics: dynamic(4) },
      // BUG 2 (E01): block-2 overlaps block-1 by 0.30 m.
      { id: "block-2", kind: "box", size: [2, 1, 2], position: [0, 1.7, 0], material: STONE, physics: dynamic(4) },
      { id: "block-3", kind: "box", size: [2, 1, 2], snapTo: { target: "block-2", face: "top" }, material: STONE, physics: dynamic(4) },
      // BUG 3 (E02): block-4 floats ~1 m above the stack and drops during the rollout.
      { id: "block-4", kind: "box", size: [1.6, 0.8, 1.6], position: [0, 5.0, 0], material: STONE_DARK, physics: dynamic(2) },
      ...merlons,
      { id: "sun", kind: "light", position: [10, 18, 8], intensity: 2.4, color: "#ffffff", castShadow: true },
      { id: "hero-cam", kind: "camera", position: [14, 10, 16], target: [0, 4.5, 0], fov: 45, isHero: true },
    ],
  };
}

/** 2. Rube Goldberg marble cascade: zig-zag ramps feeding a marble chain into a cup. */
function marbleCascade(): SceneAST {
  const ramps: SceneNode[] = [];
  const marbles: SceneNode[] = [];
  const levels = 4;
  const halfLength = 2.2;
  const halfThickness = 0.1;
  const angle = 16;
  const rad = (angle * Math.PI) / 180;
  const marbleRadius = 0.22;
  /** World point on a ramp's local frame (local x along the slab, local y along its normal). */
  const onRamp = (cx: number, cy: number, dir: number, xl: number, yl: number): Vec3 => {
    const a = dir * rad;
    return [cx + xl * Math.cos(a) - yl * Math.sin(a), cy + xl * Math.sin(a) + yl * Math.cos(a), 0];
  };
  for (let i = 0; i < levels; i++) {
    const dir = i % 2 === 0 ? 1 : -1; // +1: high end at +X, marbles roll towards -X
    const y = 7.5 - i * 1.7;
    const x = dir * 0.6;
    ramps.push({
      id: `ramp-${i + 1}`,
      kind: "ramp",
      size: [halfLength * 2, halfThickness * 2, 1.4],
      angleDeg: dir * angle,
      position: [x, y, 0],
      material: i % 2 === 0 ? INDIGO : CYAN,
      physics: { body: "static", friction: 0.4 },
    });
    // Back-stop beyond the low end: marbles bounce off it and drop through the gap to the next level.
    const lowEnd = onRamp(x, y, dir, -dir * halfLength, halfThickness);
    ramps.push({
      id: `bumper-${i + 1}`,
      kind: "box",
      size: [0.2, 1.2, 1.4],
      position: [Number((lowEnd[0] - dir * 0.75).toFixed(4)), Number((lowEnd[1] + 0.2).toFixed(4)), 0],
      material: STONE_DARK,
      physics: fixed,
    });
  }
  [1.9, 1.35, 0.8].forEach((xl, m) => {
    const p = onRamp(0.6, 7.5, 1, xl, halfThickness + marbleRadius + 0.001);
    marbles.push({
      id: `marble-${m + 1}`,
      kind: "sphere",
      radius: marbleRadius,
      position: [Number(p[0].toFixed(4)), Number(p[1].toFixed(4)), 0],
      material: m === 0 ? AMBER : CHROME,
      physics: { body: "dynamic", mass: 0.5, restitution: 0.3, friction: 0.5 },
    });
  });
  return {
    name: "Rube Goldberg Marble Cascade",
    gravity: [0, -9.81, 0],
    skyColor: "#08090A",
    nodes: [
      { id: "floor", kind: "box", size: [24, 0.5, 16], position: [0, -0.25, 0], material: GROUND, physics: fixed },
      ...ramps,
      ...marbles,
      { id: "key-light", kind: "light", position: [6, 14, 10], intensity: 2.2, castShadow: true },
      { id: "hero-cam", kind: "camera", position: [3, 6, 18], target: [0, 4, 0], fov: 50, isHero: true },
    ],
  };
}

/** 3. Playable parkour arena: floating platforms with step-ups and gap jumps from spawn to goal. */
function parkourArena(): SceneAST {
  const platforms: SceneNode[] = [];
  const steps: [number, number, number, number, number][] = [
    // x, z, top height, width, depth
    [-3.25, 0, 0.4, 2.5, 2.5],
    [0.25, 0.5, 0.8, 2.5, 2.5],
    [3.75, 0, 1.2, 2.5, 2.5],
    [3.75, -3.5, 1.6, 2.5, 2.5],
    [3.75, -7, 2.0, 2.5, 2.5],
    [0.25, -7.5, 2.4, 2.5, 2.5],
    [-3.25, -7, 2.8, 2.5, 2.5],
  ];
  steps.forEach(([x, z, top, w, d], i) => {
    const thickness = 0.4;
    platforms.push({
      id: `platform-${i + 1}`,
      kind: "box",
      size: [w, thickness, d],
      position: [x, top - thickness / 2, z],
      material: i % 2 === 0 ? INDIGO : CYAN,
      physics: fixed,
    });
  });
  return {
    name: "Playable Parkour Arena",
    gravity: [0, -9.81, 0],
    skyColor: "#08090A",
    nodes: [
      { id: "start-pad", kind: "box", size: [4, 1, 4], position: [-8, -0.5, 0], material: STONE_DARK, physics: fixed },
      ...platforms,
      { id: "goal-tower", kind: "box", size: [3, 3.6, 3], position: [-7, 1.4, -7], material: STONE, physics: fixed },
      { id: "pillar-a", kind: "cylinder", radiusTop: 0.35, radiusBottom: 0.35, height: 1.2, snapTo: { target: "platform-4", face: "top", offset: [0.8, 0, 0.8] }, material: STONE_DARK, physics: fixed },
      { id: "crate", kind: "box", size: [0.6, 0.6, 0.6], snapTo: { target: "platform-6", face: "top", offset: [0.7, 0, -0.7] }, material: AMBER, physics: dynamic(1) },
      { id: "spawn", kind: "spawn", position: [-8, 0.1, 0] },
      { id: "goal", kind: "goal", position: [-7, 4.2, -7], radius: 0.8 },
      { id: "arena-light", kind: "light", position: [0, 16, 6], intensity: 2.4, castShadow: true },
      { id: "hero-cam", kind: "camera", position: [10, 11, 12], target: [-1, 1.5, -3.5], fov: 50, isHero: true },
    ],
  };
}

/** 4. Precision arch interior: every object placed relationally with 0.000 m contacts. */
function archInterior(): SceneAST {
  const floor: Vec3 = [10, 0.3, 8];
  const wallH = 3.2;
  const t = 0.25;
  const fx = floor[0] / 2;
  const fz = floor[2] / 2;
  return {
    name: "Precision Arch Interior",
    gravity: [0, -9.81, 0],
    skyColor: "#08090A",
    nodes: [
      { id: "floor", kind: "box", size: floor, position: [0, -0.15, 0], material: WOOD, physics: fixed },
      { id: "wall-north", kind: "box", size: [floor[0], wallH, t], snapTo: { target: "floor", face: "top", offset: [0, 0, -(fz - t / 2)] }, material: PLASTER, physics: fixed },
      { id: "wall-west", kind: "box", size: [t, wallH, floor[2] - 2 * t], snapTo: { target: "floor", face: "top", offset: [-(fx - t / 2), 0, 0] }, material: PLASTER, physics: fixed },
      { id: "wall-east", kind: "box", size: [t, wallH, floor[2] - 2 * t], snapTo: { target: "floor", face: "top", offset: [fx - t / 2, 0, 0] }, material: PLASTER, physics: fixed },
      { id: "arch-left", kind: "box", size: [0.5, 2.6, 0.5], snapTo: { target: "floor", face: "top", offset: [-1.4, 0, fz - 0.25] }, material: STONE, physics: fixed },
      { id: "arch-right", kind: "box", size: [0.5, 2.6, 0.5], snapTo: { target: "floor", face: "top", offset: [1.4, 0, fz - 0.25] }, material: STONE, physics: fixed },
      { id: "arch-lintel", kind: "box", size: [3.3, 0.4, 0.5], snapTo: { target: "arch-left", face: "top", align: "min", offset: [0, 0, 0] }, material: STONE, physics: fixed },
      { id: "rug", kind: "box", size: [4, 0.02, 3], snapTo: { target: "floor", face: "top", offset: [0, 0, 0.6] }, material: { color: "#3730a3", roughness: 1 }, physics: fixed },
      { id: "desk-leg-l", kind: "box", size: [0.08, 0.72, 0.6], snapTo: { target: "floor", face: "top", offset: [-0.86, 0, -(fz - t) + 0.45] }, material: CHROME, physics: fixed },
      { id: "desk-leg-r", kind: "box", size: [0.08, 0.72, 0.6], snapTo: { target: "floor", face: "top", offset: [0.86, 0, -(fz - t) + 0.45] }, material: CHROME, physics: fixed },
      { id: "desk-top", kind: "box", size: [1.8, 0.05, 0.8], snapTo: { target: "desk-leg-l", face: "top", align: "min", offset: [0, 0, -0.1] }, material: WOOD, physics: fixed },
      { id: "monitor-stand", kind: "box", size: [0.25, 0.02, 0.2], snapTo: { target: "desk-top", face: "top", offset: [0, 0, -0.15] }, material: CHROME, physics: dynamic(1.5) },
      { id: "monitor-neck", kind: "box", size: [0.05, 0.3, 0.05], snapTo: { target: "monitor-stand", face: "top" }, material: CHROME, physics: dynamic(0.5) },
      { id: "monitor", kind: "box", size: [0.9, 0.5, 0.04], snapTo: { target: "monitor-neck", face: "top" }, material: { color: "#0e1013", roughness: 0.2, metalness: 0.6 }, physics: fixed },
      { id: "keyboard", kind: "box", size: [0.45, 0.02, 0.15], snapTo: { target: "desk-top", face: "top", offset: [0, 0, 0.2] }, material: { color: "#2a2f3a", roughness: 0.6 }, physics: dynamic(0.6) },
      { id: "lamp-base", kind: "cylinder", radiusTop: 0.1, radiusBottom: 0.12, height: 0.03, snapTo: { target: "desk-top", face: "top", align: "max", offset: [-0.1, 0, -0.45] }, material: AMBER, physics: dynamic(0.8) },
      { id: "lamp-pole", kind: "cylinder", radiusTop: 0.012, radiusBottom: 0.012, height: 0.45, snapTo: { target: "lamp-base", face: "top" }, material: CHROME, physics: fixed },
      { id: "lamp-shade", kind: "cylinder", radiusTop: 0.06, radiusBottom: 0.14, height: 0.16, snapTo: { target: "lamp-pole", face: "top" }, material: AMBER, physics: fixed },
      { id: "floor-lamp-base", kind: "cylinder", radiusTop: 0.18, radiusBottom: 0.18, height: 0.04, snapTo: { target: "floor", face: "top", offset: [-(fx - 0.6), 0, -(fz - 0.6)] }, material: CHROME, physics: fixed },
      { id: "floor-lamp-pole", kind: "cylinder", radiusTop: 0.02, radiusBottom: 0.02, height: 1.5, snapTo: { target: "floor-lamp-base", face: "top" }, material: CHROME, physics: fixed },
      { id: "floor-lamp-shade", kind: "cylinder", radiusTop: 0.15, radiusBottom: 0.25, height: 0.3, snapTo: { target: "floor-lamp-pole", face: "top" }, material: AMBER, physics: fixed },
      { id: "book-1", kind: "box", size: [0.22, 0.04, 0.3], snapTo: { target: "desk-top", face: "top", align: "min", offset: [0.12, 0, 0.12] }, material: INDIGO, physics: dynamic(0.4) },
      { id: "book-2", kind: "box", size: [0.2, 0.035, 0.28], snapTo: { target: "book-1", face: "top" }, material: CYAN, physics: dynamic(0.35) },
      { id: "ceiling-light", kind: "light", position: [0, 2.9, 0], intensity: 1.6, color: "#fff4e0", castShadow: true },
      { id: "desk-light", kind: "light", position: [0.7, 1.4, -2.9], intensity: 0.8, color: "#ffb35c" },
      { id: "hero-cam", kind: "camera", position: [3.2, 2.1, 2.8], target: [0, 0.9, -3.2], fov: 55, isHero: true },
    ],
  };
}

/** 5. Newton's cradle & dominoes: a striker rolls down a ramp into a high-restitution line and a domino run. */
function cradleAndDominoes(): SceneAST {
  const cradle: SceneNode[] = [];
  const r = 0.25;
  for (let i = 0; i < 5; i++) {
    cradle.push({
      id: `cradle-${i + 1}`,
      kind: "sphere",
      radius: r,
      position: [-1 + i * 2 * r, r, 0],
      material: CHROME,
      physics: { body: "dynamic", mass: 1, restitution: 0.95, friction: 0.05 },
    });
  }
  const rampAngle = 30;
  const a = (rampAngle * Math.PI) / 180;
  const rampX = -3.42;
  // Rest the ramp's lowest corner exactly on the floor (y = 0).
  const rampY = Number((2 * Math.sin(a) + 0.1 * Math.cos(a)).toFixed(6));
  // Striker sits on the slab surface 1.6 m up-slope from the centre (local -X is uphill).
  const xl = -1.6;
  const yl = 0.1 + r + 0.001;
  const striker: Vec3 = [
    Number((rampX + xl * Math.cos(-a) - yl * Math.sin(-a)).toFixed(6)),
    Number((rampY + xl * Math.sin(-a) + yl * Math.cos(-a)).toFixed(6)),
    0,
  ];
  const dominoes: SceneNode[] = [];
  for (let i = 0; i < 10; i++) {
    dominoes.push({
      id: `domino-${i + 1}`,
      kind: "box",
      size: [0.12, 1, 0.5],
      position: [1.6 + i * 0.45, 0.5, 0],
      material: i % 2 === 0 ? INDIGO : CYAN,
      physics: { body: "dynamic", mass: 0.3, friction: 1.0, allowTip: true },
    });
  }
  return {
    name: "Newton's Cradle & Dominoes",
    gravity: [0, -9.81, 0],
    skyColor: "#08090A",
    nodes: [
      { id: "floor", kind: "box", size: [20, 0.5, 8], position: [0, -0.25, 0], material: GROUND, physics: { body: "static", friction: 1.0 } },
      { id: "launch-ramp", kind: "ramp", size: [4, 0.2, 1], angleDeg: -rampAngle, position: [rampX, rampY, 0], material: STONE_DARK, physics: { body: "static", friction: 0.2 } },
      { id: "striker", kind: "sphere", radius: r, position: striker, material: AMBER, physics: { body: "dynamic", mass: 1.2, restitution: 0.9, friction: 0.2 } },
      ...cradle,
      ...dominoes,
      { id: "studio-light", kind: "light", position: [2, 10, 6], intensity: 2.2, castShadow: true },
      { id: "hero-cam", kind: "camera", position: [1.5, 3.5, 9], target: [1.5, 0.5, 0], fov: 50, isHero: true },
    ],
  };
}

/**
 * The 6 v2 showcase presets (Studio tabs 1-6, `hyperstage init --preset 1..6`).
 * Presets 2, 4 and 6 are new in v2; 1, 3 and 5 keep their v1 scenes.
 */
export const PRESETS: ScenePreset[] = [
  {
    id: "broken-tower",
    index: 1,
    title: "Broken Tower -> Auto-Fixed Castle",
    description: "Loads with 3 deliberate spatial bugs (2x E01, 1x E02). Auto-Fix snaps every block into place.",
    playable: false,
    category: "architecture",
    scene: brokenTower(),
  },
  {
    id: "motorized-rover",
    index: 2,
    title: "Motorized Rover & Drawbridge",
    description: "Revolute wheel motors drive a rover onto a pressure plate whose enable_motor trigger lowers a hinged drawbridge.",
    playable: false,
    category: "robotics",
    scene: motorizedRover(),
  },
  {
    id: "parkour-arena",
    index: 3,
    title: "Playable Parkour Arena",
    description: "WASD + Space character controller with a glowing navPath from spawn to goal.",
    playable: true,
    category: "game",
    scene: parkourArena(),
  },
  {
    id: "csg-villa",
    index: 4,
    title: "CSG Villa",
    description: "Walls carved by CSG subtract (doorway + windows) with frosted glass; the navigator walks in through the doorway.",
    playable: true,
    category: "architecture",
    scene: csgVilla(),
  },
  {
    id: "rube-goldberg-cascade",
    index: 5,
    title: "Rube Goldberg Cascade",
    description: "Zig-zag ramps feed a marble chain reaction down four levels.",
    playable: false,
    category: "game",
    scene: marbleCascade(),
  },
  {
    id: "planetary-gearset",
    index: 6,
    title: "3D-Printable Planetary Gearset",
    description: "Millimetre-scale CSG sun, planets, carrier and ring with 0.6 mm print-in-place clearance; exports watertight .stl.",
    playable: false,
    category: "cad",
    scene: planetaryGearset(),
  },
];

/** v1 presets kept addressable by id for backward compatibility (`getPreset("arch-interior")`). */
export const LEGACY_PRESETS: ScenePreset[] = [
  {
    id: "marble-cascade",
    index: 102,
    title: "Rube Goldberg Marble Cascade",
    description: "Multi-ramp dynamic sphere chain reaction (v1 id of preset 5).",
    playable: false,
    category: "game",
    scene: marbleCascade(),
  },
  {
    id: "arch-interior",
    index: 104,
    title: "Precision Arch Interior",
    description: "Relational snapTo room, desk, monitor and lamps with 0.000 m contact tolerance.",
    playable: false,
    category: "architecture",
    scene: archInterior(),
  },
  {
    id: "cradle-dominoes",
    index: 105,
    title: "Newton's Cradle & Dominoes",
    description: "High-restitution rigid-body collision chain.",
    playable: false,
    category: "game",
    scene: cradleAndDominoes(),
  },
];

/** Looks a preset up by its 1-based index or id (v2 presets first, then v1 legacy ids). */
export function getPreset(idOrIndex: string | number): ScenePreset | undefined {
  return (
    PRESETS.find((p) => p.id === idOrIndex || p.index === Number(idOrIndex)) ??
    LEGACY_PRESETS.find((p) => p.id === idOrIndex)
  );
}
