import { z } from "zod";

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
  material?: MaterialSpec;
  physics?: PhysicsSpec;
}

export type BoxNode = SceneNodeBase & { kind: "box"; size: Vec3 };
export type SphereNode = SceneNodeBase & { kind: "sphere"; radius: number };
export type CylinderNode = SceneNodeBase & {
  kind: "cylinder";
  radiusTop: number;
  radiusBottom: number;
  height: number;
};
export type RampNode = SceneNodeBase & { kind: "ramp"; size: Vec3; angleDeg: number };
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

export type GeometryNode = BoxNode | SphereNode | CylinderNode | RampNode;

export type SceneNode =
  | BoxNode
  | SphereNode
  | CylinderNode
  | RampNode
  | CameraNode
  | LightNode
  | SpawnNode
  | GoalNode;

export interface SceneAST {
  name: string;
  gravity: Vec3;
  skyColor: string;
  nodes: SceneNode[];
}

export const GEOMETRY_KINDS = ["box", "sphere", "cylinder", "ramp"] as const;
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
});

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
  material: MaterialSpecSchema.optional(),
  physics: PhysicsSpecSchema.optional(),
};

export const BoxNodeSchema = z.strictObject({
  ...baseShape,
  kind: z.literal("box"),
  size: z.tuple([positive, positive, positive]),
});
export const SphereNodeSchema = z.strictObject({
  ...baseShape,
  kind: z.literal("sphere"),
  radius: positive,
});
export const CylinderNodeSchema = z.strictObject({
  ...baseShape,
  kind: z.literal("cylinder"),
  radiusTop: positive,
  radiusBottom: positive,
  height: positive,
});
export const RampNodeSchema = z.strictObject({
  ...baseShape,
  kind: z.literal("ramp"),
  size: z.tuple([positive, positive, positive]),
  angleDeg: z.number().min(-89).max(89),
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
  CameraNodeSchema,
  LightNodeSchema,
  SpawnNodeSchema,
  GoalNodeSchema,
]);

export const SceneASTSchema: z.ZodType<SceneAST> = z
  .strictObject({
    name: z.string().min(1).max(200),
    gravity: Vec3Schema,
    skyColor: colorString,
    nodes: z.array(SceneNodeSchema).max(2000),
  })
  .superRefine((scene, ctx) => {
    const seen = new Set<string>();
    scene.nodes.forEach((node, index) => {
      if (seen.has(node.id)) {
        ctx.addIssue({
          code: "custom",
          path: ["nodes", index, "id"],
          message: `duplicate node id "${node.id}"`,
        });
      }
      seen.add(node.id);
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

export function isGeometryNode(node: SceneNode): node is GeometryNode {
  return node.kind === "box" || node.kind === "sphere" || node.kind === "cylinder" || node.kind === "ramp";
}

export function bodyKindOf(node: GeometryNode): BodyKind {
  return node.physics?.body ?? "static";
}

/** Deep clones a scene through structured JSON (scenes are pure data). */
export function cloneScene(scene: SceneAST): SceneAST {
  return JSON.parse(JSON.stringify(scene)) as SceneAST;
}
