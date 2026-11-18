import { beforeAll, describe, expect, it } from "vitest";
import type { JointSpec, SceneAST, SceneNode, TriggerSpec } from "@hyperstage/core";
import { autoFixScene, getRapier, lintScene } from "@hyperstage/spatial-linter";
import type { LintReport } from "@hyperstage/spatial-linter";

const ground: SceneNode = { id: "ground", kind: "box", size: [20, 0.5, 20], position: [0, -0.25, 0] };
const scene = (name: string, nodes: SceneNode[], joints?: JointSpec[], triggers?: TriggerSpec[]): SceneAST => {
  const ast: SceneAST = { name, gravity: [0, -9.81, 0], skyColor: "#08090A", nodes };
  if (joints !== undefined) ast.joints = joints;
  if (triggers !== undefined) ast.triggers = triggers;
  return ast;
};
const codes = (report: LintReport): string[] => report.diagnostics.map((d) => d.code);

const post: SceneNode = { id: "post", kind: "box", size: [0.2, 2, 0.2], position: [0, 1, 0] };
const door: SceneNode = { id: "door", kind: "box", size: [1, 1.8, 0.1], position: [0.6, 1, 0], physics: { body: "dynamic", mass: 5 } };
const hinge = (anchorB: [number, number, number], motorVelocity?: number): JointSpec => {
  const joint: JointSpec = { id: "hinge", type: "revolute", bodyA: "post", bodyB: "door", anchorA: [0.1, 0, 0], anchorB, axis: [0, 1, 0] };
  if (motorVelocity !== undefined) joint.motorVelocity = motorVelocity;
  return joint;
};

beforeAll(async () => {
  await getRapier();
});

describe("v2 joints", () => {
  it("a motorised hinge rotates the door about its axis", async () => {
    const report = await lintScene(scene("hinge", [ground, post, door], [hinge([-0.5, 0, 0], 1)]));
    expect(codes(report)).not.toContain("E05_BROKEN_JOINT");
    const last = report.frames[report.frames.length - 1];
    const angle = last?.joints?.hinge?.angleRad ?? 0;
    expect(Math.abs(angle)).toBeGreaterThan(0.5);
    expect(last?.joints?.hinge?.separation ?? 1).toBeLessThan(0.15);
  });

  it("a motorised prismatic joint slides along its axis within limits", async () => {
    const rail: SceneNode = { id: "rail", kind: "box", size: [4, 0.2, 0.2], position: [0, 2, 0] };
    const carriage: SceneNode = { id: "carriage", kind: "box", size: [0.4, 0.4, 0.4], position: [0, 1.7, 0], physics: { body: "dynamic", mass: 1 } };
    const slide: JointSpec = {
      id: "slide",
      type: "prismatic",
      bodyA: "rail",
      bodyB: "carriage",
      anchorA: [0, -0.1, 0],
      anchorB: [0, 0.2, 0],
      axis: [1, 0, 0],
      limits: [0, 1],
      motorVelocity: 0.5,
    };
    const report = await lintScene(scene("slide", [ground, rail, carriage], [slide]));
    expect(codes(report)).not.toContain("E05_BROKEN_JOINT");
    const last = report.frames[report.frames.length - 1];
    const translation = last?.joints?.slide?.translation ?? 0;
    expect(translation).toBeGreaterThan(0.3);
    expect(translation).toBeLessThanOrEqual(1.05);
  });

  it("E05 flags separated anchors, suggests an aligned anchorB and auto-fixes it", async () => {
    const broken = scene("e05", [ground, post, door], [hinge([-0.8, 0, 0])]);
    const report = await lintScene(broken);
    expect(report.valid).toBe(false);
    const d = report.diagnostics.find((x) => x.code === "E05_BROKEN_JOINT");
    expect(d?.jointId).toBe("hinge");
    expect(d?.metrics.initialSeparation).toBeCloseTo(0.3, 4);
    expect(d?.suggestedJointFix?.patch.anchorB).toEqual([-0.5, 0, 0]);
    const fixed = await autoFixScene(broken);
    expect(codes(fixed.report)).not.toContain("E05_BROKEN_JOINT");
    expect(fixed.applied.some((a) => a.code === "E05_BROKEN_JOINT" && a.nodeId === "hinge")).toBe(true);
    expect(fixed.scene.joints?.[0]?.anchorB).toEqual([-0.5, 0, 0]);
  });
});

describe("v2 triggers", () => {
  it("a pressure plate fires unlock_goal and enable_motor once", async () => {
    const plate: SceneNode = { id: "plate", kind: "box", size: [1, 0.1, 1], position: [3, 0.05, 0] };
    const ball: SceneNode = { id: "ball", kind: "sphere", radius: 0.25, position: [3, 0.35, 0], physics: { body: "dynamic", mass: 1 } };
    const goal: SceneNode = { id: "goal", kind: "goal", position: [-3, 1, 0], radius: 0.6 };
    const triggers: TriggerSpec[] = [
      { id: "plate-unlock", onEnterNodeId: "plate", action: "unlock_goal", targetId: "goal" },
      { id: "plate-motor", onEnterNodeId: "plate", action: "enable_motor", targetId: "hinge", value: 1.5 },
    ];
    const report = await lintScene(scene("plate", [ground, post, door, plate, ball, goal], [hinge([-0.5, 0, 0])], triggers));
    expect(report.unlockedGoals).toEqual(["goal"]);
    const events = report.triggerEvents ?? [];
    expect(events.map((e) => e.triggerId).sort()).toEqual(["plate-motor", "plate-unlock"]);
    expect(events.every((e) => e.bodyId === "ball")).toBe(true);
    const last = report.frames[report.frames.length - 1];
    expect(Math.abs(last?.joints?.hinge?.angleRad ?? 0)).toBeGreaterThan(0.5);
  });

  it("an impulse trigger launches its target", async () => {
    const plate: SceneNode = { id: "plate", kind: "box", size: [1, 0.1, 1], position: [0, 0.05, 0] };
    const ball: SceneNode = { id: "ball", kind: "sphere", radius: 0.25, position: [0, 0.35, 0], physics: { body: "dynamic", mass: 1 } };
    const crate: SceneNode = { id: "crate", kind: "box", size: [0.5, 0.5, 0.5], position: [4, 0.25, 0], physics: { body: "dynamic", mass: 1 } };
    const report = await lintScene(
      scene("impulse", [ground, plate, ball, crate], undefined, [{ id: "kick", onEnterNodeId: "plate", action: "impulse", targetId: "crate", value: [0, 4, 0] }]),
    );
    expect(report.triggerEvents?.[0]?.targetId).toBe("crate");
    const peakY = Math.max(...report.frames.map((f) => f.transforms.crate?.position[1] ?? 0));
    expect(peakY).toBeGreaterThan(0.4);
    expect(codes(report)).not.toContain("E02_UNSTABLE_PHYSICS");
  });
});

describe("v2 mesh-aware passes", () => {
  const statue: SceneNode = { id: "statue", kind: "box", size: [1, 2, 1], snapTo: { target: "ground", face: "top" } };
  const cam: SceneNode = { id: "cam", kind: "camera", position: [0, 1.5, 8], target: [0, 1, 0], isHero: true };

  it("a camera looks through a CSG window without E03", async () => {
    const wall: SceneNode = {
      id: "wall",
      kind: "csg",
      operation: "subtract",
      base: { kind: "box", size: [6, 4, 0.5] },
      tool: { kind: "box", size: [3, 3, 1] },
      position: [0, 2, 3],
    };
    const report = await lintScene(scene("window", [ground, statue, wall, cam]));
    expect(codes(report)).not.toContain("E03_CAMERA_OCCLUSION");
    expect(codes(report)).not.toContain("E01_INTERPENETRATION");
  });

  it("the same wall without its window occludes the camera", async () => {
    const wall: SceneNode = { id: "wall", kind: "box", size: [6, 4, 0.5], position: [0, 2, 3] };
    const report = await lintScene(scene("solid", [ground, statue, wall, cam]));
    expect(codes(report)).toContain("E03_CAMERA_OCCLUSION");
  });

  it("the navigator walks through a CSG doorway", async () => {
    const floor: SceneNode = { id: "floor", kind: "box", size: [6, 0.5, 12], position: [0, -0.25, 0] };
    const wall: SceneNode = {
      id: "wall",
      kind: "csg",
      operation: "subtract",
      base: { kind: "box", size: [6, 3, 0.3] },
      tool: { kind: "box", size: [1.4, 2.4, 1], position: [0, -0.3, 0] },
      position: [0, 1.5, 0],
    };
    const spawn: SceneNode = { id: "spawn", kind: "spawn", position: [0, 0.1, -4] };
    const goal: SceneNode = { id: "goal", kind: "goal", position: [0, 1, 4], radius: 0.6 };
    const report = await lintScene(scene("doorway", [floor, wall, spawn, goal]));
    expect(codes(report)).not.toContain("E04_UNREACHABLE_GOAL");
    expect(report.navPath.length).toBeGreaterThan(1);

    const solid: SceneNode = { id: "wall", kind: "box", size: [6, 3, 0.3], position: [0, 1.5, 0] };
    const blocked = await lintScene(scene("closed", [floor, solid, spawn, goal]));
    expect(codes(blocked)).toContain("E04_UNREACHABLE_GOAL");
  });
});
