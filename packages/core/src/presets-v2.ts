import type { GeometrySpec, SceneAST, SceneNode, Vec3 } from "./schema.js";

/** v2 showcase presets: joints + motors + triggers, CSG architecture and a printable CAD part. */

const fixed = { body: "static" as const };
const round = (value: number): number => Number(value.toFixed(6));

/** 2. Motorized rover drives onto a pressure plate that lowers a hinged drawbridge over a moat. */
export function motorizedRover(): SceneAST {
  const deckLength = 3;
  const deckThickness = 0.2;
  // Near bank ends at z = -4, far bank starts at z = -7: a 3 m moat with a floor 1.5 m down.
  return {
    name: "Motorized Rover & Drawbridge",
    gravity: [0, -9.81, 0],
    skyColor: "#08090A",
    nodes: [
      { id: "near-bank", kind: "box", size: [8, 0.5, 10], position: [0, -0.25, 1], material: "matte-concrete", physics: fixed },
      { id: "far-bank", kind: "box", size: [8, 0.5, 6], position: [0, -0.25, -10], material: "matte-concrete", physics: fixed },
      { id: "moat-floor", kind: "box", size: [8, 0.5, 3], position: [0, -1.75, -5.5], material: { color: "#0b3a4a", roughness: 0.15, metalness: 0.1 }, physics: fixed },
      { id: "tower-left", kind: "box", size: [0.8, 3.2, 0.8], snapTo: { target: "far-bank", face: "top", offset: [-2.4, 0, 2.6] }, material: "anodized-dark", physics: fixed },
      { id: "tower-right", kind: "box", size: [0.8, 3.2, 0.8], snapTo: { target: "far-bank", face: "top", offset: [2.4, 0, 2.6] }, material: "anodized-dark", physics: fixed },
      { id: "beacon-left", kind: "sphere", radius: 0.2, snapTo: { target: "tower-left", face: "top" }, material: "emissive-amber", physics: fixed },
      { id: "beacon-right", kind: "sphere", radius: 0.2, snapTo: { target: "tower-right", face: "top" }, material: "emissive-amber", physics: fixed },
      // Raised deck: stands on the far bank, hinged at its moat-side foot; its weight leans it back onto the 0 deg limit.
      {
        id: "drawbridge",
        kind: "box",
        size: [3, deckLength, deckThickness],
        position: [0, deckLength / 2 + 0.001, -7 - deckThickness / 2],
        material: "warm-oak",
        physics: { body: "dynamic", mass: 8, friction: 0.9 },
      },
      { id: "pressure-plate", kind: "box", size: [2.4, 0.04, 1.2], snapTo: { target: "near-bank", face: "top", offset: [0, 0, -1.6] }, material: "emissive-cyan", physics: fixed },
      { id: "chassis", kind: "box", size: [1, 0.3, 1.4], position: [0, 0.5, 1.5], material: "anodized-dark", physics: { body: "dynamic", mass: 6 } },
      { id: "wheel-left", kind: "cylinder", radiusTop: 0.35, radiusBottom: 0.35, height: 0.15, position: [-0.6, 0.35, 1.5], rotationDeg: [0, 0, 90], material: "brushed-metal", physics: { body: "dynamic", mass: 1, friction: 1.2 } },
      { id: "wheel-right", kind: "cylinder", radiusTop: 0.35, radiusBottom: 0.35, height: 0.15, position: [0.6, 0.35, 1.5], rotationDeg: [0, 0, 90], material: "brushed-metal", physics: { body: "dynamic", mass: 1, friction: 1.2 } },
      { id: "caster", kind: "sphere", radius: 0.1, position: [0, 0.1, 2.05], material: "ceramic-white", physics: { body: "dynamic", mass: 0.2, friction: 0.1 } },
      { id: "mast", kind: "capsule", radius: 0.06, height: 0.5, position: [0, 0.9, 1.8], material: "emissive-cyan", physics: { body: "dynamic", mass: 0.2 } },
      { id: "sun", kind: "light", position: [6, 12, 6], intensity: 2.4, castShadow: true },
      { id: "hero-cam", kind: "camera", position: [9, 6, 6], target: [0, 0.8, -1.5], fov: 50, isHero: true },
    ],
    joints: [
      { id: "axle-left", type: "revolute", bodyA: "chassis", bodyB: "wheel-left", anchorA: [-0.6, -0.15, 0], anchorB: [0, 0, 0], axis: [1, 0, 0], motorVelocity: -5, motorMaxForce: 40 },
      { id: "axle-right", type: "revolute", bodyA: "chassis", bodyB: "wheel-right", anchorA: [0.6, -0.15, 0], anchorB: [0, 0, 0], axis: [1, 0, 0], motorVelocity: -5, motorMaxForce: 40 },
      { id: "caster-mount", type: "spherical", bodyA: "chassis", bodyB: "caster", anchorA: [0, -0.4, 0.55], anchorB: [0, 0, 0] },
      { id: "mast-mount", type: "fixed", bodyA: "chassis", bodyB: "mast", anchorA: [0, 0.15, 0.3], anchorB: [0, -0.25, 0] },
      {
        id: "bridge-hinge",
        type: "revolute",
        bodyA: "far-bank",
        bodyB: "drawbridge",
        anchorA: [0, 0.25, 3],
        anchorB: [0, -deckLength / 2 - 0.001, deckThickness / 2],
        axis: [1, 0, 0],
        limitsDeg: [0, 90],
        motorVelocity: 1.6,
        motorMaxForce: 400,
      },
    ],
    triggers: [{ id: "plate-lowers-bridge", onEnterNodeId: "pressure-plate", action: "enable_motor", targetId: "bridge-hinge" }],
  };
}

/** Nested CSG subtract of several openings from one wall slab. */
function carve(base: GeometrySpec, openings: GeometrySpec[]): GeometrySpec {
  return openings.reduce<GeometrySpec>((acc, tool) => ({ kind: "csg", operation: "subtract", base: acc, tool }), base);
}

/** 4. CSG villa: walls carved with a doorway and windows, glass panes, a roof slab and a walk-through spawn/goal. */
export function csgVilla(): SceneAST {
  const w = 10;
  const d = 8;
  const h = 3.2;
  const t = 0.3;
  const hole = (x: number, y: number, sx: number, sy: number): GeometrySpec => ({ kind: "box", size: [sx, sy, t + 0.4], position: [x, y, 0] });
  const sideHole = (z: number, y: number, sz: number, sy: number): GeometrySpec => ({ kind: "box", size: [t + 0.4, sy, sz], position: [0, y, z] });
  const front = carve({ kind: "box", size: [w, h, t] }, [hole(0, -0.35, 1.6, 2.5), hole(-3, 0.2, 1.8, 1.3), hole(3, 0.2, 1.8, 1.3)]);
  const side = carve({ kind: "box", size: [t, h, d - 2 * t] }, [sideHole(-1.4, 0.2, 1.6, 1.3), sideHole(1.4, 0.2, 1.6, 1.3)]);
  const nodes: SceneNode[] = [
    { id: "lawn", kind: "box", size: [30, 0.5, 30], position: [0, -0.25, 0], material: { color: "#1f3a2a", roughness: 1, metalness: 0 }, physics: fixed },
    { id: "plinth", kind: "box", size: [w + 1, 0.3, d + 1], snapTo: { target: "lawn", face: "top" }, material: "matte-concrete", physics: fixed },
    { id: "wall-front", ...(front as Extract<GeometrySpec, { kind: "csg" }>), snapTo: { target: "plinth", face: "top", offset: [0, 0, d / 2 - t / 2] }, material: "matte-concrete", physics: fixed },
    { id: "wall-back", kind: "box", size: [w, h, t], snapTo: { target: "plinth", face: "top", offset: [0, 0, -(d / 2 - t / 2)] }, material: "ceramic-white", physics: fixed },
    { id: "wall-west", ...(side as Extract<GeometrySpec, { kind: "csg" }>), snapTo: { target: "plinth", face: "top", offset: [-(w / 2 - t / 2), 0, 0] }, material: "matte-concrete", physics: fixed },
    { id: "wall-east", ...(side as Extract<GeometrySpec, { kind: "csg" }>), snapTo: { target: "plinth", face: "top", offset: [w / 2 - t / 2, 0, 0] }, material: "matte-concrete", physics: fixed },
    { id: "roof", kind: "box", size: [w + 0.8, 0.25, d + 0.8], snapTo: { target: "wall-back", face: "top", offset: [0, 0, d / 2 - t / 2] }, material: "anodized-dark", physics: fixed },
    { id: "glass-left", kind: "box", size: [1.76, 1.26, 0.04], position: [-3, 0.3 + h / 2 + 0.2, d / 2 - t / 2], material: "frosted-glass", physics: fixed },
    { id: "glass-right", kind: "box", size: [1.76, 1.26, 0.04], position: [3, 0.3 + h / 2 + 0.2, d / 2 - t / 2], material: "frosted-glass", physics: fixed },
    { id: "rug", kind: "box", size: [4, 0.02, 3], snapTo: { target: "plinth", face: "top", offset: [0, 0, -0.5] }, material: "warm-oak", physics: fixed },
    { id: "table", kind: "cylinder", radiusTop: 0.7, radiusBottom: 0.7, height: 0.06, position: [0, 1.06, -0.5], material: "warm-oak", physics: fixed },
    { id: "table-leg", kind: "cylinder", radiusTop: 0.06, radiusBottom: 0.12, height: 0.71, snapTo: { target: "rug", face: "top" }, material: "brushed-metal", physics: fixed },
    { id: "pendant", kind: "torus", radius: 0.45, tube: 0.04, position: [0, 2.7, -0.5], material: "emissive-amber", physics: fixed },
    { id: "spawn", kind: "spawn", position: [0, 0.1, 9] },
    { id: "goal", kind: "goal", position: [0, 0.8, -2.6], radius: 0.6 },
    { id: "sun", kind: "light", position: [-8, 14, 12], intensity: 1.8, castShadow: true },
    { id: "interior", kind: "light", position: [0, 2.6, -0.5], intensity: 0.45, color: "#ffd59a" },
    { id: "hero-cam", kind: "camera", position: [9, 5, 17], target: [0, 1.6, 3.85], fov: 50, isHero: true },
  ];
  return { name: "CSG Villa", gravity: [0, -9.81, 0], skyColor: "#08090A", nodes };
}

/** Gear blank: hub cylinder unioned with `bars` tooth bars through the centre (2 teeth per bar), with a bore. */
function gear(radius: number, thickness: number, bars: number, toothDepth: number, bore: number): GeometrySpec {
  let body: GeometrySpec = { kind: "cylinder", radiusTop: radius, radiusBottom: radius, height: thickness };
  const toothWidth = round(((2 * Math.PI * radius) / (bars * 2)) * 0.45);
  for (let i = 0; i < bars; i++) {
    body = {
      kind: "csg",
      operation: "union",
      base: body,
      tool: { kind: "box", size: [round(2 * (radius + toothDepth)), thickness, toothWidth], rotationDeg: [0, round((180 / bars) * i), 0] },
    };
  }
  return { kind: "csg", operation: "subtract", base: body, tool: { kind: "cylinder", radiusTop: bore, radiusBottom: bore, height: thickness * 2 } };
}

/** 6. 3D-printable planetary gearset (millimetre scale): sun, three planets, ring and carrier laid out on a print bed. */
export function planetaryGearset(): SceneAST {
  const mm = (value: number): number => round(value / 1000);
  const thickness = mm(6);
  const sun = gear(mm(8), thickness, 4, mm(2), mm(2.5));
  const planet = gear(mm(7), thickness, 4, mm(2), mm(2));
  // Tip-to-tip clearance of 0.6 mm between sun and planets so the set prints in place.
  const orbit = mm(19.6);
  const ring: GeometrySpec = {
    kind: "csg",
    operation: "subtract",
    base: { kind: "cylinder", radiusTop: mm(35), radiusBottom: mm(35), height: thickness },
    tool: { kind: "cylinder", radiusTop: mm(28), radiusBottom: mm(28), height: thickness * 2 },
  };
  const carrier: GeometrySpec = {
    kind: "csg",
    operation: "subtract",
    base: { kind: "cylinder", radiusTop: mm(24), radiusBottom: mm(24), height: mm(3) },
    tool: { kind: "cylinder", radiusTop: mm(3), radiusBottom: mm(3), height: mm(8) },
  };
  const csg = (spec: GeometrySpec): Extract<GeometrySpec, { kind: "csg" }> => spec as Extract<GeometrySpec, { kind: "csg" }>;
  const planets: SceneNode[] = [0, 120, 240].map((deg, i) => {
    const a = (deg * Math.PI) / 180;
    const center: Vec3 = [round(Math.cos(a) * orbit), 0, round(Math.sin(a) * orbit)];
    return {
      id: `planet-${i + 1}`,
      ...csg(planet),
      rotationDeg: [0, 22.5 + deg, 0],
      snapTo: { target: "carrier", face: "top", offset: center },
      material: "anodized-dark",
      physics: fixed,
    };
  });
  return {
    name: "3D-Printable Planetary Gearset",
    gravity: [0, -9.81, 0],
    skyColor: "#08090A",
    nodes: [
      { id: "print-bed", kind: "box", size: [mm(160), mm(4), mm(110)], position: [0, -mm(2), 0], material: "matte-concrete", physics: fixed },
      { id: "carrier", ...csg(carrier), snapTo: { target: "print-bed", face: "top", offset: [-mm(38), 0, 0] }, material: "brushed-metal", physics: fixed },
      { id: "sun-gear", ...csg(sun), snapTo: { target: "carrier", face: "top" }, material: "emissive-cyan", physics: fixed },
      ...planets,
      { id: "ring-gear", ...csg(ring), snapTo: { target: "print-bed", face: "top", offset: [mm(42), 0, 0] }, material: "brushed-metal", physics: fixed },
      { id: "key-light", kind: "light", position: [mm(120), mm(220), mm(160)], intensity: 2.2, castShadow: true },
      { id: "hero-cam", kind: "camera", position: [mm(40), mm(120), mm(150)], target: [0, mm(4), 0], fov: 45, isHero: true },
    ],
  };
}
