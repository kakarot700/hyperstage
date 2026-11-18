import { z } from "zod";
import { MATERIAL_PRESET_NAMES } from "./materials.js";
import type { MaterialInput, MaterialPresetName } from "./materials.js";

export type { MaterialInput, MaterialPresetName } from "./materials.js";

export type Vec3 = [number, number, number];
export type Quat = [number, number, number, number];
export type AnchorFace = "top" | "bottom" | "north" | "south" | "east" | "west";
export type BodyKind = "static" | "dynamic" | "kinematic";

export interface SnapRule {
  target: string;
  face: AnchorFace;
  align?: "center" | "min" | "max";
  offset?: Vec3;
}

export interface MaterialSpec {
  color: string;
  metalness?: number;
  roughness?: number;
  opacity?: number;
  /** Emissive colour (#rgb / #rrggbb). */
  emissive?: string;
  /** Emissive strength multiplier (>= 0); defaults to 1 when `emissive` is set. */
  emissiveIntensity?: number;
}

export interface PhysicsSpec {
  body: BodyKind;
  mass?: number;
  restitution?: number;
  friction?: number;
  allowTip?: boolean;
}

export interface SceneNodeBase {
  id: string;
  position?: Vec3;
  rotationDeg?: Vec3;
  snapTo?: SnapRule;
  /** Preset name (e.g. "brushed-metal") or a custom PBR object. */
  material?: MaterialInput;
  physics?: PhysicsSpec;
}

export type BoxShape = { kind: "box"; size: Vec3 };
export type SphereShape = { kind: "sphere"; radius: number };
export type CylinderShape = { kind: "cylinder"; radiusTop: number; radiusBottom: number; height: number };
export type RampShape = { kind: "ramp"; size: Vec3; angleDeg: number };
/** Capsule along local Y. `height` is the total tip-to-tip extent and must be >= 2 * radius. */
export type CapsuleShape = { kind: "capsule"; radius: number; height: number };
/** Torus lying in the local XZ plane (axis = local Y). `radius` is ring centre radius, `tube` the tube radius (< radius). */
export type TorusShape = { kind: "torus"; radius: number; tube: number };
/** External glTF model. Bounds always come from `fallbackSize * scale`; nothing is fetched. */
export type GltfShape = { kind: "gltf"; url: string; scale?: Vec3; fallbackSize: Vec3 };
export type CsgOperation = "union" | "subtract" | "intersect";
/** Constructive solid geometry: `base` (op) `tool`, both placed in the CSG node's local frame. */
export type CsgShape = { kind: "csg"; operation: CsgOperation; base: GeometrySpec; tool: GeometrySpec };

export type ShapeSpec = BoxShape | SphereShape | CylinderShape | RampShape | CapsuleShape | TorusShape | GltfShape | CsgShape;

/** Local placement of a CSG operand inside its parent CSG frame. */
export interface PlacementSpec {
  position?: Vec3;
  rotationDeg?: Vec3;
}

/** A solid shape (any geometry kind) with optional local placement; used for CSG operands. */
export type GeometrySpec = ShapeSpec & PlacementSpec;

export type BoxNode = SceneNodeBase & BoxShape;
export type SphereNode = SceneNodeBase & SphereShape;
export type CylinderNode = SceneNodeBase & CylinderShape;
export type RampNode = SceneNodeBase & RampShape;
export type CapsuleNode = SceneNodeBase & CapsuleShape;
export type TorusNode = SceneNodeBase & TorusShape;
export type GltfNode = SceneNodeBase & GltfShape;
export type CsgNode = SceneNodeBase & CsgShape;
export type CameraNode = {
  kind: "camera";
  id: string;
  position: Vec3;
  target: Vec3;
  fov?: number;
  isHero?: boolean;
};
export type LightNode = {
  kind: "light";
  id: string;
  position: Vec3;
  intensity: number;
  color?: string;
  castShadow?: boolean;
};
export type SpawnNode = { kind: "spawn"; id: string; position: Vec3 };
export type GoalNode = { kind: "goal"; id: string; position: Vec3; radius: number };

export type GeometryNode =
  | BoxNode
  | SphereNode
  | CylinderNode
  | RampNode
  | CapsuleNode
  | TorusNode
  | GltfNode
  | CsgNode;

export type SceneNode = GeometryNode | CameraNode | LightNode | SpawnNode | GoalNode;

export type JointType = "fixed" | "revolute" | "prismatic" | "spherical";

interface JointBase {
  id: string;
  bodyA: string;
  bodyB: string;
  /** Anchor in bodyA's local frame (metres). */
  anchorA: Vec3;
  /** Anchor in bodyB's local frame (metres). */
  anchorB: Vec3;
}

export type FixedJoint = JointBase & { type: "fixed" };
export type RevoluteJoint = JointBase & {
  type: "revolute";
  /** Hinge axis in bodyA's local frame (non-zero). */
  axis: Vec3;
  limitsDeg?: [number, number];
  /** Target angular velocity (rad/s) of the motor. */
  motorVelocity?: number;
  motorMaxForce?: number;
};
export type PrismaticJoint = JointBase & {
  type: "prismatic";
  /** Slide axis in bodyA's local frame (non-zero). */
  axis: Vec3;
  /** Translation limits in metres. */
  limits?: [number, number];
  /** Target linear velocity (m/s) of the motor. */
  motorVelocity?: number;
  motorMaxForce?: number;
};
export type SphericalJoint = JointBase & { type: "spherical" };
export type JointSpec = FixedJoint | RevoluteJoint | PrismaticJoint | SphericalJoint;

export type TriggerAction = "enable_motor" | "unlock_goal" | "impulse";

export interface TriggerSpec {
  id: string;
  /** Geometry or goal node whose volume fires the trigger when a dynamic body enters it. */
  onEnterNodeId: string;
  action: TriggerAction;
  /** enable_motor: a revolute/prismatic joint id; unlock_goal: a goal node id; impulse: a dynamic geometry node id. */
  targetId: string;
  /** enable_motor: motor velocity override (number); impulse: impulse vector in N*s (Vec3); unlock_goal: unused. */
  value?: number | Vec3;
}

export interface SceneAST {
  name: string;
  gravity: Vec3;
  skyColor: string;
  nodes: SceneNode[];
  joints?: JointSpec[];
  triggers?: TriggerSpec[];
}

export const GEOMETRY_KINDS = ["box", "sphere", "cylinder", "ramp", "capsule", "torus", "gltf", "csg"] as const;
export type GeometryKind = (typeof GEOMETRY_KINDS)[number];

const finite = z.number().finite();
const positive = z.number().finite().positive();
const nodeId = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9_.:-]+$/, "node ids may only contain letters, digits, '_', '.', ':' and '-'");
const colorString = z
  .string()
  .regex(/^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/, "colors must be #rgb or #rrggbb hex strings");

export const Vec3Schema: z.ZodType<Vec3> = z.tuple([finite, finite, finite]);
export const AnchorFaceSchema: z.ZodType<AnchorFace> = z.enum([
  "top",
  "bottom",
  "north",
  "south",
  "east",
  "west",
]);
export const BodyKindSchema: z.ZodType<BodyKind> = z.enum(["static", "dynamic", "kinematic"]);

export const SnapRuleSchema: z.ZodType<SnapRule> = z.strictObject({
  target: nodeId,
  face: AnchorFaceSchema,
  align: z.enum(["center", "min", "max"]).optional(),
  offset: Vec3Schema.optional(),
});

export const MaterialSpecSchema: z.ZodType<MaterialSpec> = z.strictObject({
  color: colorString,
  metalness: z.number().min(0).max(1).optional(),
  roughness: z.number().min(0).max(1).optional(),
  opacity: z.number().min(0).max(1).optional(),
  emissive: colorString.optional(),
  emissiveIntensity: z.number().finite().min(0).max(100).optional(),
});

export const MaterialPresetNameSchema: z.ZodType<MaterialPresetName> = z.enum(MATERIAL_PRESET_NAMES);
export const MaterialInputSchema: z.ZodType<MaterialInput> = z.union([MaterialPresetNameSchema, MaterialSpecSchema]);

export const PhysicsSpecSchema: z.ZodType<PhysicsSpec> = z.strictObject({
  body: BodyKindSchema,
  mass: positive.optional(),
  restitution: z.number().min(0).max(2).optional(),
  friction: z.number().min(0).max(10).optional(),
  allowTip: z.boolean().optional(),
});

const baseShape = {
  id: nodeId,
  position: Vec3Schema.optional(),
  rotationDeg: Vec3Schema.optional(),
  snapTo: SnapRuleSchema.optional(),
  material: MaterialInputSchema.optional(),
  physics: PhysicsSpecSchema.optional(),
};

const positiveVec3 = z.tuple([positive, positive, positive]);
const boxFields = { kind: z.literal("box"), size: positiveVec3 };
const sphereFields = { kind: z.literal("sphere"), radius: positive };
const cylinderFields = { kind: z.literal("cylinder"), radiusTop: positive, radiusBottom: positive, height: positive };
const rampFields = { kind: z.literal("ramp"), size: positiveVec3, angleDeg: z.number().min(-89).max(89) };
const capsuleFields = { kind: z.literal("capsule"), radius: positive, height: positive };
const torusFields = { kind: z.literal("torus"), radius: positive, tube: positive };
const gltfFields = {
  kind: z.literal("gltf"),
  url: z.string().min(1).max(2048),
  scale: positiveVec3.optional(),
  fallbackSize: positiveVec3,
};
export const CsgOperationSchema: z.ZodType<CsgOperation> = z.enum(["union", "subtract", "intersect"]);
const placementShape = { position: Vec3Schema.optional(), rotationDeg: Vec3Schema.optional() };

export const GeometrySpecSchema: z.ZodType<GeometrySpec> = z.lazy(() =>
  z.discriminatedUnion("kind", [
    z.strictObject({ ...placementShape, ...boxFields }),
    z.strictObject({ ...placementShape, ...sphereFields }),
    z.strictObject({ ...placementShape, ...cylinderFields }),
    z.strictObject({ ...placementShape, ...rampFields }),
    z.strictObject({ ...placementShape, ...capsuleFields }),
    z.strictObject({ ...placementShape, ...torusFields }),
    z.strictObject({ ...placementShape, ...gltfFields }),
    z.strictObject({
      ...placementShape,
      kind: z.literal("csg"),
      operation: CsgOperationSchema,
      base: GeometrySpecSchema,
      tool: GeometrySpecSchema,
    }),
  ]),
);

export const BoxNodeSchema = z.strictObject({ ...baseShape, ...boxFields });
export const SphereNodeSchema = z.strictObject({ ...baseShape, ...sphereFields });
export const CylinderNodeSchema = z.strictObject({ ...baseShape, ...cylinderFields });
export const RampNodeSchema = z.strictObject({ ...baseShape, ...rampFields });
export const CapsuleNodeSchema = z.strictObject({ ...baseShape, ...capsuleFields });
export const TorusNodeSchema = z.strictObject({ ...baseShape, ...torusFields });
export const GltfNodeSchema = z.strictObject({ ...baseShape, ...gltfFields });
export const CsgNodeSchema = z.strictObject({
  ...baseShape,
  kind: z.literal("csg"),
  operation: CsgOperationSchema,
  base: GeometrySpecSchema,
  tool: GeometrySpecSchema,
});
export const CameraNodeSchema = z.strictObject({
  kind: z.literal("camera"),
  id: nodeId,
  position: Vec3Schema,
  target: Vec3Schema,
  fov: z.number().min(5).max(170).optional(),
  isHero: z.boolean().optional(),
});
export const LightNodeSchema = z.strictObject({
  kind: z.literal("light"),
  id: nodeId,
  position: Vec3Schema,
  intensity: z.number().min(0),
  color: colorString.optional(),
  castShadow: z.boolean().optional(),
});
export const SpawnNodeSchema = z.strictObject({
  kind: z.literal("spawn"),
  id: nodeId,
  position: Vec3Schema,
});
export const GoalNodeSchema = z.strictObject({
  kind: z.literal("goal"),
  id: nodeId,
  position: Vec3Schema,
  radius: positive,
});

export const SceneNodeSchema: z.ZodType<SceneNode> = z.discriminatedUnion("kind", [
  BoxNodeSchema,
  SphereNodeSchema,
  CylinderNodeSchema,
  RampNodeSchema,
  CapsuleNodeSchema,
  TorusNodeSchema,
  GltfNodeSchema,
  CsgNodeSchema,
  CameraNodeSchema,
  LightNodeSchema,
  SpawnNodeSchema,
  GoalNodeSchema,
]);

const jointBaseShape = { id: nodeId, bodyA: nodeId, bodyB: nodeId, anchorA: Vec3Schema, anchorB: Vec3Schema };
const range = z.tuple([finite, finite]);
const motorShape = { motorVelocity: finite.optional(), motorMaxForce: z.number().finite().min(0).optional() };

export const JointSpecSchema: z.ZodType<JointSpec> = z.discriminatedUnion("type", [
  z.strictObject({ ...jointBaseShape, type: z.literal("fixed") }),
  z.strictObject({
    ...jointBaseShape,
    type: z.literal("revolute"),
    axis: Vec3Schema,
    limitsDeg: z.tuple([z.number().min(-360).max(360), z.number().min(-360).max(360)]).optional(),
    ...motorShape,
  }),
  z.strictObject({ ...jointBaseShape, type: z.literal("prismatic"), axis: Vec3Schema, limits: range.optional(), ...motorShape }),
  z.strictObject({ ...jointBaseShape, type: z.literal("spherical") }),
]);

export const TriggerSpecSchema: z.ZodType<TriggerSpec> = z.strictObject({
  id: nodeId,
  onEnterNodeId: nodeId,
  action: z.enum(["enable_motor", "unlock_goal", "impulse"]),
  targetId: nodeId,
  value: z.union([finite, Vec3Schema]).optional(),
});

/** Maximum nesting depth of CSG operands (keeps mesh builds bounded). */
export const MAX_CSG_DEPTH = 6;

type IssueSink = (path: (string | number)[], message: string) => void;

function checkShape(spec: ShapeSpec, path: (string | number)[], depth: number, report: IssueSink): void {
  switch (spec.kind) {
    case "capsule":
      if (spec.height < 2 * spec.radius) {
        report([...path, "height"], `capsule height ${spec.height} must be >= 2 * radius (${2 * spec.radius})`);
      }
      return;
    case "torus":
      if (spec.tube >= spec.radius) {
        report([...path, "tube"], `torus tube ${spec.tube} must be smaller than radius ${spec.radius}`);
      }
      return;
    case "csg":
      if (depth >= MAX_CSG_DEPTH) {
        report(path, `csg nesting deeper than ${MAX_CSG_DEPTH} levels`);
        return;
      }
      checkShape(spec.base, [...path, "base"], depth + 1, report);
      checkShape(spec.tool, [...path, "tool"], depth + 1, report);
      return;
    default:
      return;
  }
}

function isZeroVec(v: Vec3): boolean {
  return Math.hypot(v[0], v[1], v[2]) < 1e-9;
}

export const SceneASTSchema: z.ZodType<SceneAST> = z
  .strictObject({
    name: z.string().min(1).max(200),
    gravity: Vec3Schema,
    skyColor: colorString,
    nodes: z.array(SceneNodeSchema).max(2000),
    joints: z.array(JointSpecSchema).max(500).optional(),
    triggers: z.array(TriggerSpecSchema).max(500).optional(),
  })
  .superRefine((scene, ctx) => {
    const report: IssueSink = (path, message) => ctx.addIssue({ code: "custom", path, message });
    const seen = new Set<string>();
    const nodesById = new Map<string, SceneNode>();
    scene.nodes.forEach((node, index) => {
      if (seen.has(node.id)) {
        ctx.addIssue({
          code: "custom",
          path: ["nodes", index, "id"],
          message: `duplicate node id "${node.id}"`,
        });
      }
      seen.add(node.id);
      nodesById.set(node.id, node);
    });
    scene.nodes.forEach((node, index) => {
      if (isGeometryNode(node) && node.snapTo !== undefined) {
        if (!seen.has(node.snapTo.target)) {
          ctx.addIssue({
            code: "custom",
            path: ["nodes", index, "snapTo", "target"],
            message: `snapTo target "${node.snapTo.target}" does not exist`,
          });
        } else if (node.snapTo.target === node.id) {
          ctx.addIssue({
            code: "custom",
            path: ["nodes", index, "snapTo", "target"],
            message: `node "${node.id}" cannot snap to itself`,
          });
        }
      }
      if (isGeometryNode(node)) checkShape(node, ["nodes", index], 0, report);
    });

    const jointsById = new Map<string, JointSpec>();
    (scene.joints ?? []).forEach((joint, index) => {
      const path = ["joints", index];
      if (seen.has(joint.id)) report([...path, "id"], `duplicate id "${joint.id}" (joint ids share the node/trigger id namespace)`);
      seen.add(joint.id);
      jointsById.set(joint.id, joint);
      const bodies: ["bodyA" | "bodyB", string][] = [
        ["bodyA", joint.bodyA],
        ["bodyB", joint.bodyB],
      ];
      let validBodies = 0;
      for (const [key, ref] of bodies) {
        const body = nodesById.get(ref);
        if (body === undefined) {
          report([...path, key], `joint "${joint.id}" ${key} "${ref}" does not exist`);
        } else if (!isGeometryNode(body)) {
          report([...path, key], `joint "${joint.id}" ${key} "${ref}" is a ${body.kind} node, not a geometry body`);
        } else {
          validBodies++;
        }
      }
      if (joint.bodyA === joint.bodyB) {
        report([...path, "bodyB"], `joint "${joint.id}" cannot connect body "${joint.bodyA}" to itself`);
      } else if (validBodies === 2) {
        const a = nodesById.get(joint.bodyA);
        const b = nodesById.get(joint.bodyB);
        if (a !== undefined && b !== undefined && isGeometryNode(a) && isGeometryNode(b) && bodyKindOf(a) === "static" && bodyKindOf(b) === "static") {
          report(path, `joint "${joint.id}" connects two static bodies ("${joint.bodyA}", "${joint.bodyB}"); at least one must be dynamic or kinematic`);
        }
      }
      if (joint.type === "revolute" || joint.type === "prismatic") {
        if (isZeroVec(joint.axis)) report([...path, "axis"], `joint "${joint.id}" axis must be a non-zero vector`);
        const limits = joint.type === "revolute" ? joint.limitsDeg : joint.limits;
        if (limits !== undefined && limits[0] > limits[1]) {
          report([...path, joint.type === "revolute" ? "limitsDeg" : "limits"], `joint "${joint.id}" limits must be [min, max] with min <= max`);
        }
      }
    });

    (scene.triggers ?? []).forEach((trigger, index) => {
      const path = ["triggers", index];
      if (seen.has(trigger.id)) report([...path, "id"], `duplicate id "${trigger.id}" (trigger ids share the node/joint id namespace)`);
      seen.add(trigger.id);
      const zone = nodesById.get(trigger.onEnterNodeId);
      if (zone === undefined) {
        report([...path, "onEnterNodeId"], `trigger "${trigger.id}" onEnterNodeId "${trigger.onEnterNodeId}" does not exist`);
      } else if (!isGeometryNode(zone) && zone.kind !== "goal") {
        report([...path, "onEnterNodeId"], `trigger "${trigger.id}" onEnterNodeId "${trigger.onEnterNodeId}" is a ${zone.kind} node; expected a geometry or goal node`);
      }
      switch (trigger.action) {
        case "enable_motor": {
          const joint = jointsById.get(trigger.targetId);
          if (joint === undefined) {
            report([...path, "targetId"], `trigger "${trigger.id}" enable_motor target "${trigger.targetId}" is not a joint id`);
          } else if (joint.type !== "revolute" && joint.type !== "prismatic") {
            report([...path, "targetId"], `trigger "${trigger.id}" enable_motor target "${trigger.targetId}" is a ${joint.type} joint; only revolute and prismatic joints have motors`);
          } else if (trigger.value === undefined && joint.motorVelocity === undefined) {
            report([...path, "value"], `trigger "${trigger.id}" enable_motor needs a numeric value or joint "${joint.id}".motorVelocity`);
          }
          if (Array.isArray(trigger.value)) report([...path, "value"], `trigger "${trigger.id}" enable_motor value must be a number (motor velocity)`);
          break;
        }
        case "unlock_goal": {
          const goal = nodesById.get(trigger.targetId);
          if (goal === undefined || goal.kind !== "goal") {
            report([...path, "targetId"], `trigger "${trigger.id}" unlock_goal target "${trigger.targetId}" is not a goal node`);
          }
          break;
        }
        case "impulse": {
          const target = nodesById.get(trigger.targetId);
          if (target === undefined || !isGeometryNode(target)) {
            report([...path, "targetId"], `trigger "${trigger.id}" impulse target "${trigger.targetId}" is not a geometry node`);
          } else if (bodyKindOf(target) !== "dynamic") {
            report([...path, "targetId"], `trigger "${trigger.id}" impulse target "${trigger.targetId}" must have a dynamic physics body`);
          }
          if (!Array.isArray(trigger.value)) report([...path, "value"], `trigger "${trigger.id}" impulse value must be a Vec3 impulse [x, y, z] in N*s`);
          break;
        }
      }
    });
  });

export class SceneValidationError extends Error {
  readonly issues: { path: string; message: string }[];
  constructor(issues: { path: string; message: string }[]) {
    super(
      `Invalid SceneAST: ${issues
        .slice(0, 8)
        .map((issue) => `${issue.path || "<root>"}: ${issue.message}`)
        .join("; ")}`,
    );
    this.name = "SceneValidationError";
    this.issues = issues;
  }
}

/** Validates an unknown value and returns a canonical SceneAST or throws SceneValidationError. */
export function parseScene(input: unknown): SceneAST {
  const result = SceneASTSchema.safeParse(input);
  if (!result.success) {
    throw new SceneValidationError(
      result.error.issues.map((issue) => ({
        path: issue.path.map((part) => String(part)).join("."),
        message: issue.message,
      })),
    );
  }
  return result.data;
}

/** Parses a JSON string into a validated SceneAST. */
export function parseSceneJson(json: string): SceneAST {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new SceneValidationError([{ path: "", message: `sceneJson is not valid JSON (${reason})` }]);
  }
  return parseScene(raw);
}

const GEOMETRY_KIND_SET: ReadonlySet<string> = new Set<string>(GEOMETRY_KINDS);

export function isGeometryNode(node: SceneNode): node is GeometryNode {
  return GEOMETRY_KIND_SET.has(node.kind);
}

export function bodyKindOf(node: GeometryNode): BodyKind {
  return node.physics?.body ?? "static";
}

/** Deep clones a scene through structured JSON (scenes are pure data). */
export function cloneScene(scene: SceneAST): SceneAST {
  return JSON.parse(JSON.stringify(scene)) as SceneAST;
}
