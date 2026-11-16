import { describe, expect, it } from "vitest";
import {
  AnchorCycleError,
  FACE_AXIS,
  PRESETS,
  SceneValidationError,
  aabbClearance,
  compileJsx,
  jsx,
  parseScene,
  parseSceneJson,
  resolveScene,
} from "@hyperstage/core";
import type { AnchorFace, SceneAST, SceneNode } from "@hyperstage/core";

const scene = (nodes: SceneNode[]): SceneAST => ({ name: "test", gravity: [0, -9.81, 0], skyColor: "#08090A", nodes });

const base: SceneNode = { id: "base", kind: "box", size: [4, 2, 6], position: [1, 2, 3] };

describe("schema", () => {
  it("accepts every preset", () => {
    expect(PRESETS).toHaveLength(5);
    for (const preset of PRESETS) expect(() => parseScene(preset.scene)).not.toThrow();
  });

  it("rejects duplicate ids, unknown snap targets and malformed vectors", () => {
    expect(() => parseScene(scene([base, { ...base }]))).toThrow(/duplicate node id/);
    expect(() =>
      parseScene(scene([{ id: "a", kind: "box", size: [1, 1, 1], snapTo: { target: "ghost", face: "top" } }])),
    ).toThrow(SceneValidationError);
    expect(() => parseSceneJson('{"name":"x","gravity":[0,1],"skyColor":"#000","nodes":[]}')).toThrow(SceneValidationError);
    expect(() => parseSceneJson("{nope")).toThrow(/not valid JSON/);
  });
});

describe("snapTo resolver", () => {
  const expected: Record<AnchorFace, [number, number, number]> = {
    // base center [1,2,3], half [2,1,3]; child half [0.5,0.25,0.75]
    top: [1, 2 + 1 + 0.25, 3],
    bottom: [1, 2 - 1 - 0.25, 3],
    north: [1, 2, 3 - 3 - 0.75],
    south: [1, 2, 3 + 3 + 0.75],
    east: [1 + 2 + 0.5, 2, 3],
    west: [1 - 2 - 0.5, 2, 3],
  };

  for (const face of Object.keys(FACE_AXIS) as AnchorFace[]) {
    it(`snaps flush onto the ${face} face with 0.000 m contact`, () => {
      const resolved = resolveScene(
        scene([base, { id: "child", kind: "box", size: [1, 0.5, 1.5], snapTo: { target: "base", face } }]),
      );
      const child = resolved.byId.get("child");
      const parent = resolved.byId.get("base");
      expect(child?.center).toEqual(expected[face]);
      if (child === undefined || parent === undefined) throw new Error("missing nodes");
      expect(aabbClearance(child, parent)).toBeCloseTo(0, 9);
    });
  }

  it("applies min/max alignment on orthogonal axes and offsets", () => {
    const resolved = resolveScene(
      scene([
        base,
        { id: "lo", kind: "box", size: [1, 1, 1], snapTo: { target: "base", face: "top", align: "min" } },
        { id: "hi", kind: "box", size: [1, 1, 1], snapTo: { target: "base", face: "top", align: "max", offset: [0, 0.5, -1] } },
      ]),
    );
    expect(resolved.byId.get("lo")?.center).toEqual([-0.5, 3.5, 0.5]);
    expect(resolved.byId.get("hi")?.center).toEqual([2.5, 4, 4.5]);
  });

  it("resolves nested chains regardless of declaration order", () => {
    const resolved = resolveScene(
      scene([
        { id: "c", kind: "sphere", radius: 0.5, snapTo: { target: "b", face: "top" } },
        { id: "b", kind: "cylinder", radiusTop: 0.5, radiusBottom: 0.5, height: 2, snapTo: { target: "a", face: "top" } },
        { id: "a", kind: "box", size: [2, 1, 2], position: [0, 0.5, 0] },
      ]),
    );
    expect(resolved.topologicalOrder).toEqual(["a", "b", "c"]);
    expect(resolved.byId.get("b")?.center).toEqual([0, 2, 0]);
    expect(resolved.byId.get("c")?.center).toEqual([0, 3.5, 0]);
  });

  it("accounts for rotation and ramp tilt in half extents", () => {
    const resolved = resolveScene(
      scene([
        { id: "rot", kind: "box", size: [2, 1, 1], rotationDeg: [0, 0, 90], position: [0, 0, 0] },
        { id: "ramp", kind: "ramp", size: [2, 0.2, 1], angleDeg: 30, position: [0, 0, 5] },
      ]),
    );
    const rot = resolved.byId.get("rot");
    expect(rot?.halfExtents[0]).toBeCloseTo(0.5, 9);
    expect(rot?.halfExtents[1]).toBeCloseTo(1, 9);
    const ramp = resolved.byId.get("ramp");
    expect(ramp?.halfExtents[1]).toBeCloseTo(Math.sin(Math.PI / 6) + 0.1 * Math.cos(Math.PI / 6), 9);
  });

  it("throws AnchorCycleError naming the exact cycle path", () => {
    const cyclic = scene([
      { id: "root", kind: "box", size: [1, 1, 1], position: [0, 0, 0] },
      { id: "A", kind: "box", size: [1, 1, 1], snapTo: { target: "B", face: "top" } },
      { id: "B", kind: "box", size: [1, 1, 1], snapTo: { target: "A", face: "top" } },
    ]);
    let caught: unknown;
    try {
      resolveScene(cyclic);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(AnchorCycleError);
    expect((caught as AnchorCycleError).cycle).toEqual(["A", "B", "A"]);
    expect((caught as AnchorCycleError).message).toContain("A -> B -> A");
  });

  it("detects longer cycles", () => {
    expect(() =>
      resolveScene(
        scene([
          { id: "x", kind: "box", size: [1, 1, 1], snapTo: { target: "z", face: "top" } },
          { id: "y", kind: "box", size: [1, 1, 1], snapTo: { target: "x", face: "top" } },
          { id: "z", kind: "box", size: [1, 1, 1], snapTo: { target: "y", face: "top" } },
        ]),
      ),
    ).toThrow(/x -> z -> y -> x/);
  });

  it("is deterministic", () => {
    const a = resolveScene(PRESETS[3]?.scene ?? scene([]));
    const b = resolveScene(PRESETS[3]?.scene ?? scene([]));
    expect(a.bakedScene).toEqual(b.bakedScene);
  });
});

describe("zero-DOM JSX runtime", () => {
  it("compiles a <scene> tree into a validated SceneAST", () => {
    const tree = jsx("scene", {
      name: "jsx",
      children: [
        jsx("box", { id: "floor", size: [10, 1, 10], position: [0, -0.5, 0] }),
        jsx("group", {
          children: [
            jsx("sphere", { id: "ball", radius: 0.5, snapTo: { target: "floor", face: "top" }, physics: { body: "dynamic" } }),
            false,
            null,
          ],
        }),
        jsx("camera", { id: "cam", position: [5, 5, 5], target: [0, 0, 0], isHero: true }),
      ],
    });
    const ast = compileJsx(tree);
    expect(ast.nodes.map((n) => n.kind)).toEqual(["box", "sphere", "camera"]);
    expect(resolveScene(ast).byId.get("ball")?.center).toEqual([0, 0.5, 0]);
  });

  it("supports function components and rejects unknown intrinsics", () => {
    const Pillar = (props: Record<string, unknown>) =>
      jsx("cylinder", { id: String(props.id), radiusTop: 0.2, radiusBottom: 0.2, height: 2, position: [0, 1, 0] });
    const ast = compileJsx(jsx("scene", { name: "c", children: [jsx(Pillar, { id: "p1" })] }));
    expect(ast.nodes[0]?.id).toBe("p1");
    expect(() => compileJsx(jsx("scene", { name: "bad", children: [jsx("teapot", {})] }))).toThrow(/Unknown HyperStage element/);
  });
});
