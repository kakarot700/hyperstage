import { describe, expect, it } from "vitest";
import {
  GLB_CHUNK_BIN,
  GLB_CHUNK_JSON,
  GLB_MAGIC,
  MATERIAL_PRESET_NAMES,
  LEGACY_PRESETS,
  PRESETS,
  getPreset,
  SceneValidationError,
  buildGeometryMesh,
  buildNodeMesh,
  buildSceneMeshes,
  buildShapeMesh,
  checkManifold,
  compileJsx,
  exportGlb,
  exportStl,
  jsx,
  meshBounds,
  meshTriangleCount,
  meshVolume,
  parseGlb,
  parseScene,
  resolveMaterial,
  resolveScene,
} from "@hyperstage/core";
import type { GeometrySpec, GltfDocument, SceneAST, SceneNode, ShapeSpec } from "@hyperstage/core";

const scene = (nodes: SceneNode[], extra: Partial<SceneAST> = {}): SceneAST => ({
  name: "v2",
  gravity: [0, -9.81, 0],
  skyColor: "#08090A",
  nodes,
  ...extra,
});

/** 4 m x 3 m x 0.3 m wall with a 1 m x 2.2 m doorway cut through its bottom edge. */
const doorwayWall: SceneNode = {
  id: "wall",
  kind: "csg",
  operation: "subtract",
  position: [0, 1.5, 0],
  base: { kind: "box", size: [4, 3, 0.3] },
  tool: { kind: "box", size: [1, 2.4, 1], position: [0, -1.5 + 1.0, 0] },
  material: "matte-concrete",
};

const mechanism = (): SceneAST =>
  scene(
    [
      { id: "ground", kind: "box", size: [10, 0.5, 10], position: [0, -0.25, 0], physics: { body: "static" } },
      { id: "plate", kind: "box", size: [1, 0.1, 1], position: [-3, 0.05, 0], physics: { body: "static" } },
      { id: "bridge", kind: "box", size: [4, 0.2, 1], position: [1, 0.5, 0], physics: { body: "dynamic", mass: 5 } },
      { id: "weight", kind: "sphere", radius: 0.3, position: [-3, 2, 0], physics: { body: "dynamic", mass: 2 } },
      { id: "goal", kind: "goal", position: [4, 0.5, 0], radius: 0.5 },
    ],
    {
      joints: [
        {
          id: "hinge",
          type: "revolute",
          bodyA: "ground",
          bodyB: "bridge",
          anchorA: [-1, 0.25, 0],
          anchorB: [-2, 0, 0],
          axis: [0, 0, 1],
          limitsDeg: [0, 90],
          motorMaxForce: 200,
        },
      ],
      triggers: [
        { id: "press", onEnterNodeId: "plate", action: "enable_motor", targetId: "hinge", value: 1.5 },
        { id: "open", onEnterNodeId: "plate", action: "unlock_goal", targetId: "goal" },
        { id: "kick", onEnterNodeId: "plate", action: "impulse", targetId: "weight", value: [0, 4, 0] },
      ],
    },
  );

function errorText(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    if (error instanceof SceneValidationError) return error.message;
    throw error;
  }
  throw new Error("expected SceneValidationError");
}

describe("v2 geometry kinds", () => {
  it("keeps every v1 preset valid and unchanged, and v2 presets round-trip", () => {
    const v1 = new Set(["broken-tower", "parkour-arena", "rube-goldberg-cascade"]);
    for (const preset of [...PRESETS, ...LEGACY_PRESETS]) {
      const parsed = parseScene(preset.scene);
      expect(parsed).toEqual(preset.scene);
      if (v1.has(preset.id) || preset.index > 100) expect(parsed.joints).toBeUndefined();
    }
    expect(getPreset("motorized-rover")?.scene.joints?.length).toBe(5);
  });

  it("parses capsule, torus, gltf and csg and resolves their bounds", () => {
    const resolved = resolveScene(
      parseScene(
        scene([
          { id: "cap", kind: "capsule", radius: 0.5, height: 2, position: [0, 1, 0] },
          { id: "ring", kind: "torus", radius: 1, tube: 0.25, position: [5, 0, 0] },
          { id: "model", kind: "gltf", url: "https://example.com/robot.glb", fallbackSize: [1, 2, 0.5], scale: [2, 1, 1], position: [0, 0, 5] },
          { ...doorwayWall, snapTo: { target: "cap", face: "east" } },
        ]),
      ),
    );
    expect(resolved.byId.get("cap")?.localHalf).toEqual([0.5, 1, 0.5]);
    expect(resolved.byId.get("ring")?.localHalf).toEqual([1.25, 0.25, 1.25]);
    expect(resolved.byId.get("model")?.localHalf).toEqual([1, 1, 0.25]);
    const wall = resolved.byId.get("wall");
    expect(wall?.localHalf).toEqual([2, 1.5, 0.15]);
    expect(wall?.center).toEqual([0.5 + 2, 1, 0]);
  });

  it("rejects invalid capsule/torus proportions and unknown kinds", () => {
    expect(errorText(() => parseScene(scene([{ id: "c", kind: "capsule", radius: 1, height: 1 }])))).toMatch(/capsule height/);
    expect(errorText(() => parseScene(scene([{ id: "t", kind: "torus", radius: 1, tube: 1 }])))).toMatch(/torus tube/);
    expect(() => parseScene({ ...scene([]), nodes: [{ id: "x", kind: "cone", radius: 1 }] })).toThrow(SceneValidationError);
  });

  it("compiles new kinds, joints and triggers from JSX", () => {
    const ast = compileJsx(
      jsx("scene", {
        name: "jsx-v2",
        joints: [{ id: "j", type: "fixed", bodyA: "a", bodyB: "b", anchorA: [0, 0, 0], anchorB: [0, 0, 0] }],
        children: [
          jsx("capsule", { id: "a", radius: 0.2, height: 1, physics: { body: "dynamic" } }),
          jsx("torus", { id: "b", radius: 1, tube: 0.1, position: [0, 3, 0] }),
          jsx("gltf", { id: "g", url: "m.glb", fallbackSize: [1, 1, 1], position: [3, 0, 0] }),
          jsx("csg", { id: "w", operation: "subtract", base: { kind: "box", size: [4, 3, 0.3] }, tool: { kind: "box", size: [1, 2, 1] }, position: [0, 0, 6] }),
        ],
      }),
    );
    expect(ast.nodes.map((n) => n.kind)).toEqual(["capsule", "torus", "gltf", "csg"]);
    expect(ast.joints).toHaveLength(1);
  });
});

describe("materials", () => {
  it("resolves every preset and custom objects", () => {
    expect(MATERIAL_PRESET_NAMES).toHaveLength(8);
    for (const name of MATERIAL_PRESET_NAMES) {
      const m = resolveMaterial(name);
      expect(m.name).toBe(name);
      expect(m.color).toMatch(/^#[0-9a-f]{6}$/);
    }
    expect(resolveMaterial("frosted-glass").transparent).toBe(true);
    expect(resolveMaterial("emissive-cyan").emissiveIntensity).toBeGreaterThan(1);
    expect(resolveMaterial(undefined)).toMatchObject({ name: "default", color: "#8a8f98", metalness: 0.1, roughness: 0.8, opacity: 1 });
    expect(resolveMaterial({ color: "#F00", emissive: "#0f0" })).toMatchObject({
      name: "custom",
      color: "#ff0000",
      emissive: "#00ff00",
      emissiveIntensity: 1,
      metalness: 0.1,
    });
  });

  it("accepts preset names and v1 material objects on nodes, rejects unknown presets", () => {
    expect(() => parseScene(scene([{ id: "a", kind: "box", size: [1, 1, 1], material: "warm-oak" }]))).not.toThrow();
    expect(() =>
      parseScene(scene([{ id: "a", kind: "box", size: [1, 1, 1], material: { color: "#123456", metalness: 0.5, roughness: 0.2, opacity: 0.9 } }])),
    ).not.toThrow();
    expect(() => parseScene({ ...scene([]), nodes: [{ id: "a", kind: "box", size: [1, 1, 1], material: "gold-leaf" }] })).toThrow(
      SceneValidationError,
    );
  });
});

describe("joints and triggers", () => {
  it("accepts a valid pressure-plate drawbridge mechanism", () => {
    const parsed = parseScene(mechanism());
    expect(parsed.joints?.[0]?.type).toBe("revolute");
    expect(parsed.triggers).toHaveLength(3);
  });

  it("reports unknown bodies, self joints, static pairs and bad axes", () => {
    const base = mechanism();
    const withJoint = (joint: object): unknown => ({ ...base, joints: [joint], triggers: [] });
    const hinge = base.joints?.[0];
    expect(errorText(() => parseScene(withJoint({ ...hinge, bodyB: "ghost" })))).toMatch(/joints\.0\.bodyB: joint "hinge" bodyB "ghost" does not exist/);
    expect(errorText(() => parseScene(withJoint({ ...hinge, bodyB: "goal" })))).toMatch(/is a goal node, not a geometry body/);
    expect(errorText(() => parseScene(withJoint({ ...hinge, bodyB: "ground" })))).toMatch(/cannot connect body "ground" to itself/);
    expect(errorText(() => parseScene(withJoint({ ...hinge, bodyB: "plate" })))).toMatch(/connects two static bodies/);
    expect(errorText(() => parseScene(withJoint({ ...hinge, axis: [0, 0, 0] })))).toMatch(/axis must be a non-zero vector/);
    expect(errorText(() => parseScene(withJoint({ ...hinge, limitsDeg: [90, 0] })))).toMatch(/min <= max/);
    expect(errorText(() => parseScene(withJoint({ ...hinge, id: "bridge" })))).toMatch(/duplicate id "bridge"/);
  });

  it("reports trigger targets of the wrong type", () => {
    const base = mechanism();
    const withTrigger = (trigger: object): unknown => ({ ...base, triggers: [trigger] });
    expect(errorText(() => parseScene(withTrigger({ id: "t", onEnterNodeId: "nowhere", action: "unlock_goal", targetId: "goal" })))).toMatch(
      /onEnterNodeId "nowhere" does not exist/,
    );
    expect(errorText(() => parseScene(withTrigger({ id: "t", onEnterNodeId: "plate", action: "enable_motor", targetId: "bridge", value: 1 })))).toMatch(
      /is not a joint id/,
    );
    expect(errorText(() => parseScene(withTrigger({ id: "t", onEnterNodeId: "plate", action: "unlock_goal", targetId: "bridge" })))).toMatch(
      /is not a goal node/,
    );
    expect(errorText(() => parseScene(withTrigger({ id: "t", onEnterNodeId: "plate", action: "impulse", targetId: "ground", value: [0, 1, 0] })))).toMatch(
      /must have a dynamic physics body/,
    );
    expect(errorText(() => parseScene(withTrigger({ id: "t", onEnterNodeId: "plate", action: "impulse", targetId: "weight", value: 3 })))).toMatch(
      /impulse value must be a Vec3/,
    );
    expect(errorText(() => parseScene(withTrigger({ id: "t", onEnterNodeId: "plate", action: "enable_motor", targetId: "hinge" })))).toMatch(
      /needs a numeric value/,
    );
  });
});

describe("triangle meshes and CSG", () => {
  const shapes: ShapeSpec[] = [
    { kind: "box", size: [1, 2, 3] },
    { kind: "sphere", radius: 0.7 },
    { kind: "cylinder", radiusTop: 0.3, radiusBottom: 0.6, height: 1.2 },
    { kind: "ramp", size: [3, 0.2, 1], angleDeg: 20 },
    { kind: "capsule", radius: 0.4, height: 2 },
    { kind: "capsule", radius: 0.5, height: 1 },
    { kind: "torus", radius: 1, tube: 0.3 },
    { kind: "gltf", url: "x.glb", fallbackSize: [1, 1, 2], scale: [2, 2, 2] },
  ];

  for (const shape of shapes) {
    it(`builds a closed, outward-wound ${shape.kind} mesh`, () => {
      const mesh = buildShapeMesh(shape, { segments: 24 });
      const report = checkManifold(mesh);
      expect(report).toMatchObject({ closed: true, boundaryEdges: 0, nonManifoldEdges: 0 });
      expect(meshVolume(mesh)).toBeGreaterThan(0);
      expect(mesh.normals.length).toBe(mesh.positions.length);
    });
  }

  it("matches analytic bounds and volume for primitives", () => {
    const box = buildShapeMesh({ kind: "box", size: [1, 2, 3] });
    expect(meshVolume(box)).toBeCloseTo(6, 5);
    expect(meshBounds(box)).toEqual({ min: [-0.5, -1, -1.5], max: [0.5, 1, 1.5] });
    const torus = meshBounds(buildShapeMesh({ kind: "torus", radius: 1, tube: 0.3 }, { segments: 64 }));
    expect(torus.max[1]).toBeCloseTo(0.3, 5);
    expect(torus.max[2]).toBeCloseTo(1.3, 5);
    const capsule = meshBounds(buildShapeMesh({ kind: "capsule", radius: 0.4, height: 2 }));
    expect(capsule.max[1]).toBeCloseTo(1, 5);
    expect(capsule.min[1]).toBeCloseTo(-1, 5);
  });

  it("carves a doorway: closed manifold with exact bounds and volume", () => {
    const resolved = resolveScene(parseScene(scene([doorwayWall])));
    const geometry = resolved.byId.get("wall");
    if (geometry === undefined) throw new Error("wall missing");
    const mesh = buildNodeMesh(geometry);
    const report = checkManifold(mesh);
    expect(report).toMatchObject({ closed: true, boundaryEdges: 0, nonManifoldEdges: 0, inconsistentEdges: 0, degenerateTriangles: 0 });
    const bounds = meshBounds(mesh);
    expect(bounds.min.map((v) => Number(v.toFixed(5)))).toEqual([-2, 0, -0.15]);
    expect(bounds.max.map((v) => Number(v.toFixed(5)))).toEqual([2, 3, 0.15]);
    // wall 4*3*0.3 minus opening 1 * 2.2 (from y=0 to y=2.2 in world) * 0.3
    expect(meshVolume(mesh)).toBeCloseTo(4 * 3 * 0.3 - 1 * 2.2 * 0.3, 4);
  });

  it("carves a window fully inside a wall (genus-1 solid) and supports nested CSG", () => {
    const mesh = buildGeometryMesh({
      kind: "csg",
      operation: "subtract",
      base: {
        kind: "csg",
        operation: "subtract",
        base: { kind: "box", size: [4, 3, 0.3] },
        tool: { kind: "box", size: [1, 1, 1], position: [1, 0.3, 0] },
      },
      tool: { kind: "cylinder", radiusTop: 0.4, radiusBottom: 0.4, height: 1, rotationDeg: [90, 0, 0], position: [-1, 0, 0] },
    });
    expect(checkManifold(mesh).closed).toBe(true);
    expect(meshVolume(mesh)).toBeCloseTo(3.6 - 0.3 - Math.PI * 0.16 * 0.3, 1);
  });

  it("supports union and intersect", () => {
    const a: GeometrySpec = { kind: "box", size: [2, 2, 2] };
    const union = buildGeometryMesh({ kind: "csg", operation: "union", base: a, tool: { kind: "box", size: [2, 2, 2], position: [1, 0.5, 0.25] } });
    expect(checkManifold(union).closed).toBe(true);
    expect(meshVolume(union)).toBeCloseTo(8 + 8 - 1 * 1.5 * 1.75, 4);
    const inter = buildGeometryMesh({ kind: "csg", operation: "intersect", base: a, tool: { kind: "sphere", radius: 1.2 } });
    expect(checkManifold(inter).closed).toBe(true);
    const b = meshBounds(inter);
    expect(b.max[0]).toBeCloseTo(1, 5);
  });

  it("keeps curved boolean results closed (tilted bore through a sphere, torus + capsule union)", () => {
    const bored = buildGeometryMesh({
      kind: "csg",
      operation: "subtract",
      base: { kind: "sphere", radius: 1 },
      tool: { kind: "cylinder", radiusTop: 0.3, radiusBottom: 0.3, height: 3, rotationDeg: [20, 0, 10] },
    });
    expect(checkManifold(bored).closed).toBe(true);
    const fused = buildGeometryMesh({
      kind: "csg",
      operation: "union",
      base: { kind: "torus", radius: 1, tube: 0.3 },
      tool: { kind: "capsule", radius: 0.2, height: 3, rotationDeg: [0, 0, 90] },
    });
    expect(checkManifold(fused).closed).toBe(true);
  });

  it("builds scene meshes with resolved materials in world space", () => {
    const meshes = buildSceneMeshes(parseScene(scene([doorwayWall, { id: "orb", kind: "sphere", radius: 0.5, position: [0, 4, 0] }])));
    expect(meshes.map((m) => m.id)).toEqual(["wall", "orb"]);
    expect(meshes[0]?.material.name).toBe("matte-concrete");
    expect(meshes[1]?.bounds.max[1]).toBeCloseTo(4.5, 5);
  });
});

function readGlb(bytes: Uint8Array): { gltf: GltfDocument; bin: Uint8Array | null } {
  const { json, bin } = parseGlb(bytes);
  return { gltf: json as GltfDocument, bin };
}

describe("exporters", () => {
  const exportScene = (): SceneAST =>
    parseScene(
      scene([
        doorwayWall,
        { id: "orb", kind: "sphere", radius: 0.5, position: [0, 4, 0], material: "emissive-cyan" },
        { id: "ramp", kind: "ramp", size: [2, 0.2, 1], angleDeg: 15, position: [3, 0.5, 0], material: { color: "#ff8800", opacity: 0.5 } },
        { id: "cam", kind: "camera", position: [5, 5, 5], target: [0, 0, 0] },
      ]),
    );

  it("writes a structurally valid GLB with matching accessors", () => {
    const { bytes, stats, gltf } = exportGlb(exportScene());
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    expect(view.getUint32(0, true)).toBe(GLB_MAGIC);
    expect(view.getUint32(4, true)).toBe(2);
    expect(view.getUint32(8, true)).toBe(bytes.byteLength);
    const jsonLength = view.getUint32(12, true);
    expect(jsonLength % 4).toBe(0);
    expect(view.getUint32(16, true)).toBe(GLB_CHUNK_JSON);
    expect(view.getUint32(20 + jsonLength + 4, true)).toBe(GLB_CHUNK_BIN);
    expect([0x20, 0x7d]).toContain(bytes[20 + jsonLength - 1]);

    const parsed = readGlb(bytes);
    expect(parsed.gltf).toEqual(gltf);
    expect(parsed.gltf.asset.version).toBe("2.0");
    expect(parsed.gltf.nodes.map((n) => n.name)).toEqual(["wall", "orb", "ramp"]);
    expect(parsed.gltf.meshes).toHaveLength(3);
    expect(parsed.gltf.materials).toHaveLength(3);
    expect(parsed.gltf.extensionsUsed).toEqual(["KHR_materials_emissive_strength"]);
    expect(parsed.gltf.materials.some((m) => m.alphaMode === "BLEND")).toBe(true);
    expect(parsed.bin?.byteLength).toBe(parsed.gltf.buffers[0]?.byteLength);

    let triangles = 0;
    for (const mesh of parsed.gltf.meshes) {
      const prim = mesh.primitives[0];
      if (prim === undefined || parsed.bin === null) throw new Error("missing primitive");
      const pos = parsed.gltf.accessors[prim.attributes.POSITION];
      const nrm = parsed.gltf.accessors[prim.attributes.NORMAL];
      const idx = parsed.gltf.accessors[prim.indices];
      if (pos === undefined || nrm === undefined || idx === undefined) throw new Error("missing accessor");
      expect(pos.count).toBe(nrm.count);
      expect(idx.count % 3).toBe(0);
      expect(pos.min).toHaveLength(3);
      const posView = parsed.gltf.bufferViews[pos.bufferView];
      const idxView = parsed.gltf.bufferViews[idx.bufferView];
      if (posView === undefined || idxView === undefined) throw new Error("missing view");
      expect(posView.byteLength).toBe(pos.count * 12);
      expect(idxView.byteLength).toBe(idx.count * 4);
      expect(posView.byteOffset % 4).toBe(0);
      const indices = new Uint32Array(parsed.bin.slice(idxView.byteOffset, idxView.byteOffset + idxView.byteLength).buffer);
      expect(Math.max(...indices)).toBeLessThan(pos.count);
      const positions = new Float32Array(parsed.bin.slice(posView.byteOffset, posView.byteOffset + posView.byteLength).buffer);
      for (let a = 0; a < 3; a++) {
        let mn = Infinity;
        let mx = -Infinity;
        for (let i = a; i < positions.length; i += 3) {
          mn = Math.min(mn, positions[i] ?? 0);
          mx = Math.max(mx, positions[i] ?? 0);
        }
        expect(mn).toBe(pos.min?.[a]);
        expect(mx).toBe(pos.max?.[a]);
      }
      triangles += idx.count / 3;
    }
    expect(stats.triangles).toBe(triangles);
    expect(stats.meshes).toBe(3);
    expect(stats.boundsMm[1]).toBeGreaterThan(4400);
  });

  it("writes an empty but valid GLB for a scene without solids", () => {
    const { bytes, stats } = exportGlb(parseScene(scene([{ id: "spawn", kind: "spawn", position: [0, 0, 0] }])));
    const parsed = readGlb(bytes);
    expect(parsed.bin).toBeNull();
    expect(parsed.gltf.meshes).toHaveLength(0);
    expect(stats).toEqual({ triangles: 0, vertices: 0, meshes: 0, boundsMm: [0, 0, 0] });
  });

  it("writes binary STL with 84 + 50n bytes and watertight mm geometry", () => {
    const { bytes, stats } = exportStl(parseScene(scene([doorwayWall])));
    expect(bytes.byteLength).toBe(84 + 50 * stats.triangles);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    expect(view.getUint32(80, true)).toBe(stats.triangles);
    expect(new TextDecoder().decode(bytes.subarray(0, 5))).not.toBe("solid");
    // Y-up metres -> Z-up millimetres: x 4000, y (depth) 300, z (height) 3000.
    expect(stats.boundsMm).toEqual([4000, 300, 3000]);

    const positions = new Float32Array(stats.triangles * 9);
    const indices = new Uint32Array(stats.triangles * 3);
    for (let t = 0; t < stats.triangles; t++) {
      const base = 84 + t * 50;
      for (let k = 0; k < 9; k++) positions[t * 9 + k] = view.getFloat32(base + 12 + k * 4, true) / 1000;
      indices.set([t * 3, t * 3 + 1, t * 3 + 2], t * 3);
    }
    const report = checkManifold({ positions, normals: new Float32Array(positions.length), indices });
    expect(report.closed).toBe(true);
  });

  it("filters by node id and rejects unknown ids", () => {
    const { stats } = exportStl(exportScene(), { nodeIds: ["orb"], unitScale: 1, zUp: false });
    expect(stats.meshes).toBe(1);
    expect(stats.boundsMm[0]).toBeCloseTo(1000, 0);
    expect(() => exportStl(exportScene(), { nodeIds: ["cam"] })).toThrow(/unknown geometry node/);
  });
});

describe("CSG precision is scale-relative", () => {
  const bracket = (r: number, z: number): GeometrySpec => ({
    kind: "csg",
    operation: "subtract",
    base: {
      kind: "csg",
      operation: "union",
      base: { kind: "box", size: [0.06, 0.005, 0.04] },
      tool: { kind: "box", size: [0.06, 0.04, 0.005], position: [0, 0.0175, -0.0175] },
    },
    tool: { kind: "cylinder", radiusTop: r, radiusBottom: r, height: 0.012, position: [0, 0, z] },
  });
  for (const [r, z] of [
    [0.0032, 0.006],
    [0.0035, 0.006],
    [0.003, 0.008],
    [0.0025, -0.01],
  ] as const) {
    it(`mm-scale bracket with an r=${r * 1000} mm hole at z=${z * 1000} mm is closed`, () => {
      const mesh = buildGeometryMesh(bracket(r, z));
      const report = checkManifold(mesh, 1e-9);
      expect(report.degenerateTriangles).toBe(0);
      expect(report.closed).toBe(true);
    });
  }

  it("the same bracket scaled to metres has the same triangle count", () => {
    const scaleSpec = (spec: GeometrySpec, k: number): GeometrySpec => JSON.parse(JSON.stringify(spec), (key, value: unknown) =>
      (key === "size" || key === "position") && Array.isArray(value) ? value.map((v: number) => v * k) : ["radiusTop", "radiusBottom", "height"].includes(key) && typeof value === "number" ? value * k : value,
    ) as GeometrySpec;
    const small = buildGeometryMesh(bracket(0.0032, 0.006));
    const large = buildGeometryMesh(scaleSpec(bracket(0.0032, 0.006), 1000));
    expect(meshTriangleCount(small)).toBe(meshTriangleCount(large));
    expect(checkManifold(large, 1e-6).closed).toBe(true);
  });
});
